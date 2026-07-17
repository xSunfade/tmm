// Express server bootstrap: app-level middleware (order matters), router
// mounts, and scheduled-job startup. Route handlers live in routes/*.js and
// shared service logic in lib/ (Phase 2.9 router split — zero logic change).

import express from 'express';
import cors from 'cors';
import config from './config.js';
import { isPlaidConfigured } from './plaidClient.js';
import { initializeTokenStorage } from './tokenStore.js';
import { requestLogger } from './middleware/logging.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { securityHeaders, createRequestTimeoutMiddleware } from './middleware/security.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startPlaidSyncWorker } from './lib/plaidSyncWorker.js';
import {
  PLAID_SYNC_USE_QUEUE,
  PLAID_SYNC_WORKER_ENABLED,
  processPlaidSyncJob,
  runScheduledTransactionsSync
} from './lib/plaidSyncService.js';
import { runScheduledHistorySnapshots } from './lib/historyService.js';
import { runGraceExpirySweep } from './lib/entitlementSweeps.js';
import { revokeExpiredPlaidTokens } from './lib/plaidLifecycle.js';
import stripeRoutes from './routes/stripeRoutes.js';
import plaidRoutes from './routes/plaidRoutes.js';
import googleRoutes from './routes/googleRoutes.js';
import planRoutes from './routes/planRoutes.js';
import privacyRoutes from './routes/privacyRoutes.js';
import historyRoutes from './routes/historyRoutes.js';
import entitlementRoutes from './routes/entitlementRoutes.js';

const app = express();
const PORT = config.port;

// Request correlation and logging (must be before other middleware)
app.use(correlationMiddleware);
app.use(requestLogger);
app.use(securityHeaders({ enableHsts: config.enableHsts }));
app.use(createRequestTimeoutMiddleware(config.requestTimeoutMs));

// Multi-origin CORS support
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (config.corsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Optional local dev override.
      if (config.allowDevUnlistedCors) {
        console.warn(`⚠️  CORS: Allowing unlisted origin: ${origin}`);
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true
}));
// Stripe webhook signatures require the raw request body; register before JSON parsing.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
// Plaid webhook verification (SEC-1) hashes the exact raw body bytes; same treatment.
app.use('/api/webhooks/plaid', express.raw({ type: 'application/json' }));
// Plan documents can legitimately exceed the global body limit (D14: warn at
// 1 MB, hard-reject above 5 MB in the handler). Route-scoped parser must run
// before the global one; express.json() no-ops when the body is already parsed.
app.use('/api/plan', express.json({ limit: config.planJsonBodyLimit, strict: true }));
app.use(express.json({ limit: config.jsonBodyLimit, strict: true }));

// Request validation middleware
const validateRequest = (req, res, next) => {
  if (req.method === 'POST' && !req.body) {
    return res.status(400).json({ error: 'Request body is required' });
  }
  next();
};

app.use(validateRequest);

const apiRateLimit = createRateLimiter({
  id: 'api-global',
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 240)
});
app.use('/api', apiRateLimit);

// Plaid routes fail fast with 503 when credentials are absent (FRAGILE-5);
// the client itself is lazy so the server boots without them (dev/Sheets-only
// work). The webhook route is excluded: it only records + enqueues.
app.use(['/api/plaid', '/api/ops/plaid'], (req, res, next) => {
  if (!isPlaidConfigured()) {
    return res.status(503).json({
      error: 'Plaid integration is not configured on this server',
      code: 'PLAID_NOT_CONFIGURED'
    });
  }
  next();
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    requestId: req.requestId
  });
});

app.get('/', (req, res) => {
  res.send('TMM Backend is running 🚀');
});

// Routers own their full paths; mounted at root so the route table matches
// the pre-split server.js exactly. No cross-router path overlaps exist, so
// mount order does not affect matching.
app.use(stripeRoutes);
app.use(plaidRoutes);
app.use(googleRoutes);
app.use(planRoutes);
app.use(privacyRoutes);
app.use(historyRoutes);
app.use(entitlementRoutes);

// Apply error handling middleware
app.use(errorHandler);

// Initialize storage and start server
async function startServer() {
  try {
    // Initialize Supabase token storage
    await initializeTokenStorage({
      supabase: config.supabase
    });

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 TMM Plaid Backend API running on port ${PORT}`);
      console.log(`📡 Environment: ${config.env}`);
      console.log(`🌐 CORS origins: ${config.corsOrigins.join(', ')}`);
      console.log(`💾 Database: Supabase PostgreSQL`);
      console.log(`🔐 Plaid environment: ${config.plaid.environment}`);

      const syncIntervalMinutes = Number(process.env.PLAID_TRANSACTIONS_SYNC_INTERVAL_MINUTES || 1440);
      if (Number.isFinite(syncIntervalMinutes) && syncIntervalMinutes > 0) {
        const intervalMs = syncIntervalMinutes * 60 * 1000;
        setInterval(() => {
          runScheduledTransactionsSync().catch((err) => {
            console.error('Scheduled Plaid transactions sync run failed:', err.message);
          });
        }, intervalMs);
        console.log(`🕒 Plaid transactions sync schedule: every ${syncIntervalMinutes} minute(s)`);
      } else {
        console.log('🕒 Plaid transactions sync schedule: disabled');
      }

      if (PLAID_SYNC_USE_QUEUE && PLAID_SYNC_WORKER_ENABLED) {
        const pollMs = Number(process.env.PLAID_SYNC_WORKER_POLL_MS || 2000);
        startPlaidSyncWorker({
          runJob: processPlaidSyncJob,
          pollIntervalMs: pollMs,
          lockSeconds: Number(process.env.PLAID_SYNC_JOB_LOCK_SECONDS || 120),
          enabled: true
        });
        console.log(`🧵 Plaid sync worker: enabled (poll ${pollMs}ms)`);
      } else {
        console.log('🧵 Plaid sync worker: disabled');
      }

      // Entitlement + Plaid lifecycle sweeps (Phase 4.4/4.8 — D11/D12):
      // grace expiry -> downgrade + suspend; retention expiry -> revoke.
      // Kill switch: RUN_ENTITLEMENT_SWEEPS=false.
      const lifecycleSweepMinutes = Number(process.env.ENTITLEMENT_SWEEP_INTERVAL_MINUTES || 60);
      const runLifecycleSweeps = String(process.env.RUN_ENTITLEMENT_SWEEPS || 'true').toLowerCase() !== 'false';
      if (runLifecycleSweeps && Number.isFinite(lifecycleSweepMinutes) && lifecycleSweepMinutes > 0) {
        const sweep = () => {
          runGraceExpirySweep().catch((err) => {
            console.error('Grace-expiry sweep failed:', err.message);
          });
          revokeExpiredPlaidTokens().catch((err) => {
            console.error('Plaid revocation sweep failed:', err.message);
          });
        };
        setInterval(sweep, lifecycleSweepMinutes * 60 * 1000);
        sweep(); // run once at boot so restarts never extend a grace window
        console.log(`🕒 Entitlement/lifecycle sweeps: every ${lifecycleSweepMinutes} minute(s)`);
      } else {
        console.log('🕒 Entitlement/lifecycle sweeps: disabled');
      }

      const snapshotIntervalMinutes = Number(process.env.HISTORY_SNAPSHOT_INTERVAL_MINUTES || 10080);
      if (Number.isFinite(snapshotIntervalMinutes) && snapshotIntervalMinutes > 0) {
        const intervalMs = snapshotIntervalMinutes * 60 * 1000;
        setInterval(() => {
          runScheduledHistorySnapshots().catch((err) => {
            console.error('Scheduled history snapshot run failed:', err.message);
          });
        }, intervalMs);
        console.log(`🕒 History snapshot schedule: every ${snapshotIntervalMinutes} minute(s)`);
      } else {
        console.log('🕒 History snapshot schedule: disabled');
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
