# Supabase Signup Bootstrap Verification

Use this doc to verify and fix deterministic user bootstrap after running migrations 006, 007, and 008.

---

## 1) VERIFY: Auth Signup Bootstrap Trigger

Confirm there is **exactly one** trigger on `auth.users` that bootstraps app tables.

**Expected:**

- **Trigger name:** `on_auth_user_created_bootstrap`
- **Table:** `auth.users`
- **Timing:** `AFTER INSERT`
- **Function:** `public.handle_new_auth_user_bootstrap()`

**Verification SQL (run in Supabase SQL Editor):**

```sql
SELECT
  trigger_name,
  event_manipulation,
  event_object_schema,
  event_object_table,
  action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'auth'
  AND event_object_table = 'users'
ORDER BY trigger_name;
```

**Expected result:** One row with `trigger_name = 'on_auth_user_created_bootstrap'` and `action_statement` referencing `handle_new_auth_user_bootstrap`.

**If it fails:** Run migration `007_auth_user_bootstrap_trigger.sql` (it drops and recreates the trigger).

---

## 2) VERIFY: Schema Invariants

Every `auth.users` row must have a matching `public.profiles` row and a matching `public.user_onboarding` row.

**Verification SQL (must return 0 rows):**

```sql
-- Missing profiles rows
SELECT u.id AS missing_profile_user_id
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL;

-- Missing onboarding rows
SELECT u.id AS missing_onboarding_user_id
FROM auth.users u
LEFT JOIN public.user_onboarding o ON o.user_id = u.id
WHERE o.user_id IS NULL;
```

**If any rows are returned:** Run migration `008_backfill_profiles_and_onboarding.sql` (or the backfill SQL below once).

---

## 3) FIX (if needed): One-time Backfill

If step 2 returned missing rows, run this **once** (or run migration 008):

```sql
-- Backfill profiles
INSERT INTO public.profiles (id, plan_tier)
SELECT u.id, 'free'
FROM auth.users u
LEFT JOIN public.profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;

-- Backfill user_onboarding
INSERT INTO public.user_onboarding (user_id)
SELECT u.id
FROM auth.users u
LEFT JOIN public.user_onboarding o ON o.user_id = u.id
WHERE o.user_id IS NULL
ON CONFLICT (user_id) DO NOTHING;
```

---

## 4) Codebase Alignment (no code changes)

Verified behavior:

| Check | Location | Status |
|-------|----------|--------|
| `fetchPlanTier()` reads `public.profiles.plan_tier` | `frontend/src/app/providers/AuthProvider.tsx` | Yes: `supabase.from('profiles').select('plan_tier').eq('id', userId).maybeSingle()` |
| Missing profiles row not relied on as normal path | `AuthProvider`, `backend/middleware/auth.js` | Yes: missing row → tier treated as `'free'`; no code assumes “no row” as success |
| Plaid gating depends on `plan_tier`, not auth metadata | `AccountIntegrationScreen`, Settings, backend `requireTmmPlus` | Yes: gating uses `planTier === 'tmm_plus'` and `profiles.plan_tier` |
| `user_onboarding` not read by frontend | `frontend/src` | Yes: onboarding state is localStorage-only (`onboardingStorage.ts`); no Supabase query to `user_onboarding` |

---

## 5) New Signup Test

After migrations and verification:

1. Create a **new** test user (Supabase Auth signup).
2. In SQL Editor, run:
   - `SELECT * FROM public.profiles WHERE id = '<new_user_uuid>';` → one row, `plan_tier = 'free'`.
   - `SELECT * FROM public.user_onboarding WHERE user_id = '<new_user_uuid>';` → one row.
3. In the app: sign in as that user; tier should be free; Plaid should be gated; no manual inserts required.

---

## Done criteria

- [ ] Exactly one bootstrap trigger on `auth.users`: `on_auth_user_created_bootstrap`
- [ ] Trigger calls `public.handle_new_auth_user_bootstrap()`
- [ ] Missing-row checks (step 2) return 0 rows
- [ ] New signups auto-create `profiles` + `user_onboarding` rows
- [ ] App behavior unchanged except for deterministic bootstrap
