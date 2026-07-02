# Ledger Timing Examples

All examples use integer cents and banker’s rounding.

## Example 1: Monthly on 31st roll-forward

- Input:
  - start: `2026-01-31`
  - monthly expense: `10000` cents
- Expected fire dates:
  - `2026-01-31`, `2026-02-28`, `2026-03-31`, `2026-04-30`

## Example 2: Weekly weekday lock

- Input:
  - start: Monday `2026-01-05`
  - weekly income: `50000`
- Expected:
  - fires every Monday only.

## Example 3: Raise timing

- Input:
  - monthly income `300000`, raise `10%`, start `2026-01-01`
- Rule:
  - raise applied at period start before posting the income event.

## Example 4: Debt ordering

- Daily order:
  1. interest accrual
  2. minimum payment
  3. extra payment
  4. principal update

## Example 5: Ticker ordering

- Day order:
  1. cashflow events
  2. debt events
  3. investment return application
  4. checkpoint adjustment events (if any)

## Example 6: Checkpoint boundary

- If checkpoint date = `2026-06-01`, then:
  - all points before date unchanged
  - point at date and after uses checkpoint-adjusted state.
