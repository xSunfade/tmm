-- Token vault tables (plaid_tokens, google_sheets_tokens) hold third-party
-- access tokens and must never be readable from the browser — not even by the
-- row owner (XSS exfiltration risk; tokens are only used server-side via the
-- service role, which bypasses RLS). Drop the owner policies the baseline
-- created and revoke table privileges from authenticated for defense in depth.

drop policy if exists plaid_tokens_own on public.plaid_tokens;
drop policy if exists google_sheets_tokens_own on public.google_sheets_tokens;

revoke all on table public.plaid_tokens from authenticated;
revoke all on table public.google_sheets_tokens from authenticated;
revoke all on table public.plaid_circuit_breaker from authenticated;
