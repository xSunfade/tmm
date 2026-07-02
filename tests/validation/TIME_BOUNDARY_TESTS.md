# Time Boundary Tests

## Covered behaviors

- Freeze/jump forward/jump backward via deterministic `TimeController`
- Leap year boundary (includes Feb 29)
- DST transition window (UTC-stable daily iteration)
- Month-end rollover behavior

## Assertions

- No duplicate daily events: `true`
- No skipped days: `true`
- Interest accrual computed each day with fixed-point policy: `true`
- End-of-month sequence stability: `true`
