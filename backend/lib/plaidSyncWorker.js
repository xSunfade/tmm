import { randomUUID } from 'crypto';
import {
  claimNextPlaidSyncJob,
  completePlaidSyncJob,
  failPlaidSyncJob
} from '../models/plaidSyncJobs.js';

export function startPlaidSyncWorker({
  runJob,
  pollIntervalMs = 2000,
  lockSeconds = 120,
  enabled = true
}) {
  if (!enabled) {
    return { stop: () => {} };
  }
  const workerId = randomUUID();
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const job = await claimNextPlaidSyncJob({ workerId, lockSeconds });
      if (!job) return;
      const startedAt = Date.now();
      try {
        const result = await runJob(job, workerId);
        await completePlaidSyncJob({ jobId: job.job_id, result });
      } catch (error) {
        const retryDelayMs = Math.min(60_000, Math.max(5_000, (Number(job.attempts || 1) ** 2) * 1000));
        await failPlaidSyncJob({
          jobId: job.job_id,
          errorCode: error?.code || error?.response?.data?.error_code || null,
          errorMessage: error?.message || 'unknown worker failure',
          runAfterDelayMs: retryDelayMs,
          noRetry: !!error?.noRetry
        });
      } finally {
        const elapsed = Date.now() - startedAt;
        console.log(JSON.stringify({
          type: 'plaid_sync_worker_job_finished',
          workerId,
          jobId: job.job_id,
          elapsed_ms: elapsed,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (err) {
      console.error('Plaid sync worker tick failed:', err.message);
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => {
    tick().catch(() => {});
  }, Math.max(500, Number(pollIntervalMs) || 2000));

  tick().catch(() => {});

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

