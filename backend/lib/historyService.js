// History snapshot/point helpers shared by the history routes, Stripe webhook
// (downgrade archive hook), Plaid disconnect/remove flows, the sync workflow,
// and the scheduled snapshot job. Moved verbatim from server.js (Phase 2.9
// router split).

import { supabaseAdmin } from '../supabaseClient.js';
import {
  createSnapshotsForAccounts,
  getHistoryTimezoneForUser
} from '../models/history.js';
import { getAccountsByUserAndItemId } from '../models/account.js';

const HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES = Math.max(0, Number(process.env.HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES || 0));

export function buildForensics(points) {
  return (points || [])
    .filter((p) => p?.needsReview)
    .map((p) => {
      const checkpointValue = Number(p.checkpointValue || 0);
      const plaidValue = Number(p.plaidValue || p.value || 0);
      const delta = plaidValue - checkpointValue;
      const classification = Math.abs(delta) <= 0.01 ? 'rounding' : 'modified_tx';
      return {
        date: p.date,
        delta,
        classification,
        confidence: classification === 'rounding' ? 'high' : 'medium',
        evidence: {
          checkpointValue,
          plaidValue
        }
      };
    });
}

async function getAccountsForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id,user_id,plaid_item_id,balance,currency_code')
    .eq('user_id', userId);
  if (error) throw new Error(`Failed to load user accounts: ${error.message}`);
  return data || [];
}

export async function createArchiveSnapshotForUser(userId, options = {}) {
  const accounts = await getAccountsForUser(userId);
  if (!accounts.length) {
    return { snapshotRows: [], totalNetWorth: 0, pointDate: null, point: null };
  }
  const timezone = options.timezone || (await getHistoryTimezoneForUser(userId));
  const skipIfFreshWithinMinutes = options.forceArchive
    ? 0
    : (Number(options.skipIfFreshWithinMinutes) || HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES);
  return createSnapshotsForAccounts(userId, accounts, {
    timezone,
    asOf: options.asOf,
    useMonthEnd: !!options.useMonthEnd,
    source: options.source || 'plaid',
    pointSource: options.pointSource || 'plaid_archived',
    confidence: options.confidence || 'high',
    metadata: options.metadata || {},
    skipIfFreshWithinMinutes
  });
}

export async function createArchiveSnapshotForItem(userId, itemId, options = {}) {
  const accounts = await getAccountsByUserAndItemId(userId, itemId);
  if (!accounts.length) {
    return { snapshotRows: [], totalNetWorth: 0, pointDate: null, point: null };
  }
  const timezone = options.timezone || (await getHistoryTimezoneForUser(userId));
  const skipIfFreshWithinMinutes = options.forceArchive
    ? 0
    : (Number(options.skipIfFreshWithinMinutes) || HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES);
  return createSnapshotsForAccounts(userId, accounts, {
    timezone,
    asOf: options.asOf,
    useMonthEnd: !!options.useMonthEnd,
    source: options.source || 'plaid',
    pointSource: options.pointSource || 'plaid_archived',
    confidence: options.confidence || 'high',
    metadata: options.metadata || { reason: 'item_disconnect', item_id: itemId },
    skipIfFreshWithinMinutes
  });
}

export async function runScheduledHistorySnapshots() {
  const { data: plusUsers, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('plan_tier', 'tmm_plus');
  if (error) throw new Error(`Failed to load TMM+ users for snapshots: ${error.message}`);
  for (const row of plusUsers || []) {
    try {
      await createArchiveSnapshotForUser(row.id, {
        useMonthEnd: true,
        pointSource: 'plaid_archived',
        metadata: { trigger: 'scheduled_snapshot' }
      });
    } catch (err) {
      console.error(`Scheduled history snapshot failed for user ${row.id}:`, err.message);
    }
  }
}

export async function deriveNetWorthPointsFromSnapshots(userId, startDate, endDate) {
  let query = supabaseAdmin
    .from('account_balance_snapshots')
    .select('as_of,balance,source')
    .eq('user_id', userId)
    .order('as_of', { ascending: true });
  if (startDate) query = query.gte('as_of', `${startDate}T00:00:00.000Z`);
  if (endDate) query = query.lte('as_of', `${endDate}T23:59:59.999Z`);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load snapshots for fallback points: ${error.message}`);
  const grouped = new Map();
  for (const row of data || []) {
    const date = String(row.as_of).slice(0, 10);
    const current = grouped.get(date) || { net: 0, source: row.source || 'plaid_archived' };
    current.net += Number(row.balance || 0);
    grouped.set(date, current);
  }
  return Array.from(grouped.entries()).map(([pointDate, value]) => ({
    point_date: pointDate,
    net_worth: value.net,
    source: value.source || 'plaid_archived',
    confidence: 'high',
    reconciled: false
  }));
}

export function deriveCoverageFromPoints(points) {
  const plaidDates = (points || [])
    .filter((p) => p?.source === 'plaid_live' || p?.source === 'plaid_archived')
    .map((p) => String(p.point_date || p.date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  if (!plaidDates.length) return { earliest: null, latest: null };
  return {
    earliest: plaidDates[0],
    latest: plaidDates[plaidDates.length - 1]
  };
}
