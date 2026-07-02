# Stress Test Results

## Scenario

- Horizon: 10 years
- Accounts: 5
- Income streams: 3
- Investments: 2+ (savings/invest assets)
- Debt payoff included
- Sync cycles: 20
- Reconnect/partial-change pressure: simulated via seeded cycle variance
- Transaction pressure: synthetic >10,000 equivalent events

## Metrics

- Wall time: `27.95 ms`
- CPU time: `78.00 ms`
- Heap delta: `6.38 MB`
- Synthetic transaction count: `100000`
- Final net worth cents: `46464466`

## Correctness checks

- Drift reconciliation leaves no active review flag: `true`
- Rounding loss remained zero: `true`
- Transfer symmetry preserved in ledger: `true`
