// Authentication Middleware
// Validates JWT tokens from Supabase Auth and attaches user to request

import { supabase } from '../supabaseClient.js';
import { supabaseAdmin } from '../supabaseClient.js';

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

/**
 * Middleware to require TMM+ plan tier for Plaid and other paid features.
 * Must be used after requireAuth (req.userId must be set).
 * Returns 403 with clear message if user is on Free tier or has no profile.
 */
export async function requireTmmPlus(req, res, next) {
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
        message: 'Tier check unavailable'
      });
    }
    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('plan_tier')
      .eq('id', req.userId)
      .maybeSingle();

    if (error) {
      console.error('Tier check error:', error);
      return res.status(500).json({
        error: 'Internal server error',
        message: 'Could not verify plan tier'
      });
    }

    const tier = profile?.plan_tier ?? 'free';
    if (tier !== 'tmm_plus') {
      return res.status(403).json({
        error: 'Plaid is available on TMM+',
        message: 'Upgrade to TMM+ to connect bank accounts with Plaid.',
        code: 'TIER_REQUIRED'
      });
    }

    next();
  } catch (err) {
    console.error('requireTmmPlus error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Tier validation failed'
    });
  }
}

/**
 * Optional auth middleware - attaches user if token is present, but doesn't require it
 * Useful for routes that work with or without authentication
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (!error && user) {
        req.user = user;
        req.userId = user.id;
      }
    }
    
    next();
  } catch (err) {
    // Don't fail on optional auth errors, just continue without user
    console.warn('Optional auth error (non-fatal):', err);
    next();
  }
}
