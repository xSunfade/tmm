// Authentication Middleware
// Validates JWT tokens from Supabase Auth and attaches user to request

import { supabase } from '../supabaseClient.js';
import { supabaseAdmin } from '../supabaseClient.js';
import { createEntitlementResolver } from '../lib/entitlements.js';

/**
 * Middleware to require authentication for protected routes
 * Validates JWT token from Authorization header and attaches user to request
 * 
 * Usage:
 *   app.post('/api/protected', requireAuth, async (req, res) => {
 *     // req.user contains the authenticated user
 *     // req.userId contains the user's UUID
 *   });
 */
export async function requireAuth(req, res, next) {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header. Expected: Bearer <token>'
      });
    }
    
    // Extract token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Token is required'
      });
    }
    
    // Validate token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: error?.message || 'Invalid or expired token'
      });
    }
    
    // Attach user to request
    req.user = user;
    req.userId = user.id;
    
    // Continue to next middleware/route handler
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: 'Authentication validation failed'
    });
  }
}

// Table-driven entitlement resolution (ADR-3): tier and limits come from
// plan_catalog + tier_entitlements rows via one resolver, never inline checks.
const resolveEntitlements = supabaseAdmin
  ? createEntitlementResolver({ supabaseAdmin })
  : null;

/** Direct access to the resolver for routes that need limits, not just a gate. */
export async function getEntitlementsForUser(userId) {
  if (!resolveEntitlements) {
    throw new Error('Entitlement resolver unavailable (no Supabase admin client)');
  }
  return resolveEntitlements(userId);
}

/**
 * Middleware factory: require a boolean entitlement flag (e.g. 'plaidEnabled').
 * Must be used after requireAuth. Attaches the resolved entitlements to
 * req.entitlements so handlers can read limits (maxPlaidItems etc.) without a
 * second resolution.
 */
export function requireEntitlement(flag) {
  return async function requireEntitlementMiddleware(req, res, next) {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Authentication required'
        });
      }
      if (!resolveEntitlements) {
        return res.status(503).json({
          error: 'Service unavailable',
          message: 'Entitlement check unavailable'
        });
      }

      const resolved = await resolveEntitlements(req.userId);
      req.entitlements = resolved;

      if (!resolved.entitlements[flag]) {
        return res.status(403).json({
          error: 'This feature is available on TMM+',
          message: 'Upgrade to TMM+ to connect bank accounts with Plaid.',
          code: 'TIER_REQUIRED',
          tier: resolved.tier
        });
      }

      next();
    } catch (err) {
      console.error('requireEntitlement error:', err);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Entitlement validation failed'
      });
    }
  };
}

/**
 * Require TMM+ (or higher) for Plaid routes. Kept under its historical name so
 * existing route definitions stay unchanged; internally this is the
 * entitlement resolver gating on plaidEnabled (ADR-3).
 */
export const requireTmmPlus = requireEntitlement('plaidEnabled');

/**
 * Middleware to require the admin role (Phase 4.11) for ops routes.
 * Must be used after requireAuth. profiles.is_admin is set only via SQL.
 */
export async function requireAdmin(req, res, next) {
  try {
    if (!req.userId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required'
      });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Admin check unavailable'
      });
    }
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('is_admin')
      .eq('id', req.userId)
      .maybeSingle();
    if (error) {
      console.error('Admin check error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Could not verify admin role'
      });
    }
    if (!profile?.is_admin) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Admin role required',
        code: 'ADMIN_REQUIRED'
      });
    }
    next();
  } catch (err) {
    console.error('requireAdmin error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Admin validation failed'
    });
  }
}
