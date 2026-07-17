#!/usr/bin/env node
// Seed the Stripe catalog + plan_catalog table (Phase 4.6, billing doc §Runbook 4).
//
// Creates (idempotently, by lookup_key) the four subscription prices in
// Stripe TEST mode and upserts the matching plan_catalog rows:
//
//   tmm_plus_monthly  $12/mo   tmm_plus_annual  $120/yr
//   tmm_pro_monthly   $25/mo   tmm_pro_annual   $250/yr
//
// Prices follow project-roadmap/04-billing-and-entitlements.md (pricing
// floor). Refuses to run against a LIVE Stripe key — the live catalog is a
// Gate D founder action, run deliberately with --allow-live.
//
// Usage (from backend/): node scripts/seed-stripe-catalog.mjs

import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const CATALOG = [
  { lookupKey: 'tmm_plus_monthly', tier: 'tmm_plus', interval: 'month', unitAmount: 1200, product: 'TMM+' },
  { lookupKey: 'tmm_plus_annual', tier: 'tmm_plus', interval: 'year', unitAmount: 12000, product: 'TMM+' },
  { lookupKey: 'tmm_pro_monthly', tier: 'tmm_pro', interval: 'month', unitAmount: 2500, product: 'TMM+ Pro' },
  { lookupKey: 'tmm_pro_annual', tier: 'tmm_pro', interval: 'year', unitAmount: 25000, product: 'TMM+ Pro' }
];

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY is not set');
    process.exit(1);
  }
  const allowLive = process.argv.includes('--allow-live');
  if (secretKey.startsWith('sk_live') && !allowLive) {
    console.error('Refusing to seed against a LIVE Stripe key. Re-run with --allow-live at Gate D if intended.');
    process.exit(1);
  }
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !supabaseSecret) {
    console.error('SUPABASE_URL / SUPABASE_SECRET_KEY are not set');
    process.exit(1);
  }

  const stripe = new Stripe(secretKey);
  const supabase = createClient(supabaseUrl, supabaseSecret, { auth: { persistSession: false } });

  // Products, keyed by name (create once).
  const productIds = new Map();
  for (const name of [...new Set(CATALOG.map((c) => c.product))]) {
    const existing = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
    if (existing.data[0]) {
      productIds.set(name, existing.data[0].id);
      console.log(`product exists: ${name} -> ${existing.data[0].id}`);
    } else {
      const created = await stripe.products.create({ name });
      productIds.set(name, created.id);
      console.log(`product created: ${name} -> ${created.id}`);
    }
  }

  for (const entry of CATALOG) {
    const found = await stripe.prices.list({ lookup_keys: [entry.lookupKey], limit: 1 });
    let price = found.data[0] || null;
    if (!price) {
      price = await stripe.prices.create({
        product: productIds.get(entry.product),
        currency: 'usd',
        unit_amount: entry.unitAmount,
        recurring: { interval: entry.interval },
        lookup_key: entry.lookupKey
      });
      console.log(`price created: ${entry.lookupKey} -> ${price.id} ($${entry.unitAmount / 100}/${entry.interval})`);
    } else {
      console.log(`price exists: ${entry.lookupKey} -> ${price.id}`);
    }

    const { error } = await supabase.from('plan_catalog').upsert(
      {
        stripe_price_id: price.id,
        lookup_key: entry.lookupKey,
        tier: entry.tier,
        billing_interval: entry.interval,
        active: true
      },
      { onConflict: 'stripe_price_id' }
    );
    if (error) {
      console.error(`plan_catalog upsert failed for ${entry.lookupKey}: ${error.message}`);
      process.exit(1);
    }
    console.log(`plan_catalog upserted: ${entry.lookupKey} (${entry.tier}, ${entry.interval})`);
  }

  // Retire the legacy $5 placeholder if it is still in the catalog (PAY-2:
  // unknown/inactive prices grant nothing).
  const legacyPriceId = process.env.STRIPE_PRICE_ID_TMM_PLUS;
  if (legacyPriceId) {
    const inCatalog = CATALOG.length > 0 && (await supabase
      .from('plan_catalog')
      .select('stripe_price_id')
      .eq('stripe_price_id', legacyPriceId)
      .maybeSingle());
    if (!inCatalog?.data) {
      console.log(`note: legacy STRIPE_PRICE_ID_TMM_PLUS (${legacyPriceId}) is NOT in plan_catalog — subscriptions on it resolve Free. Archive it in the Stripe dashboard.`);
    }
  }

  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
