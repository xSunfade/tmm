-- Generated baseline history seed for net_worth_points_alt
-- Replace __USER_ID__ with your test user UUID before running.

BEGIN;

INSERT INTO net_worth_points_alt (user_id, alt, point_date, net_worth, source, confidence) VALUES
  ('__USER_ID__'::uuid, 'Baseline', '2025-01-01'::date, 216587.78, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-02-01'::date, 364575.86, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-03-01'::date, 510361.67, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-04-01'::date, 656146.9, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-05-01'::date, 799730.59, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-06-01'::date, 945513.8, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-07-01'::date, 1165295.38, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-08-01'::date, 1311075.87, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-09-01'::date, 1456855.97, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-10-01'::date, 1602634.32, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-11-01'::date, 1748412.34, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2025-12-01'::date, 1968188.53, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2026-01-01'::date, 2113963.61, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2026-02-01'::date, 2259740.18, 'tmm_total', 'high'),
  ('__USER_ID__'::uuid, 'Baseline', '2026-03-01'::date, 2405513.15, 'tmm_total', 'high')
ON CONFLICT (user_id, alt, point_date) DO UPDATE
SET net_worth = EXCLUDED.net_worth,
    source = EXCLUDED.source,
    confidence = EXCLUDED.confidence,
    updated_at = NOW();

COMMIT;
