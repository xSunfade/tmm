# Position Semantics (D4)

Market assets are ownership positions: `quantity × price(t)`. The simulated price is a
deterministic output of user-configured assumptions — explicitly not a market prediction.
Contributions purchase shares at the simulated price at contribution time (correct DCA).

## Which plan rows become positions

- An `AssetRow` with `mode === 'Ticker'` becomes a position when it has a resolvable
  starting price (`liveprice > 0`) and quantity (explicit `quantity`, or derived
  `value ÷ liveprice` by the v2→v3 migration, flagged `positionNeedsReview`).
- Ticker rows without a resolvable price fall back to balance-based modeling
  (`value` + `apy` daily compounding) — identical to `APY` mode.
- `apy` on a Ticker row is the **assumed annual return** of the simulated price path.
  The domain model exposes it as `assumedAnnualReturnPct`.

## Fixed-point representation

| Quantity | Unit | Type |
|---|---|---|
| Share quantity | micro-shares (1 share = 1,000,000 µshares) | `bigint` |
| Price per share | micro-cents (1 cent = 1,000,000 µcents) | `bigint` |
| Position value | cents | `bigint` |

- `valueCents(t) = bankersRound(quantityMicro(t) × priceMicroCents(t) / 10^12)`
- Initial price: `priceMicroCents(0) = round(liveprice × 10^8)` (dollars → µcents).
- Initial quantity: `quantityMicro(0) = round(quantity × 10^6)`.
- The position account's day-0 ledger balance is **defined** as
  `bankersRound(qty(0) × price(0) / 10^12)` — quantity × price wins over the row's
  stored `value` for Ticker rows (they may disagree after manual edits).

## Deterministic price path

Daily compounding with banker's rounding and residual carry, identical in structure to
balance interest accrual:

```
numer(d)  = priceMicroCents(d-1) × ratePpm + carry(d-1)
delta(d)  = bankersRound(numer(d) / (10^6 × 365))
carry(d)  = numer(d) − delta(d) × (10^6 × 365)
priceMicroCents(d) = priceMicroCents(d-1) + delta(d)
```

- `ratePpm = round(assumedAnnualReturnPct × 10^4)` (e.g. 12% → 120,000 ppm).
- Augment `scale-asset` scales `ratePpm` for the affected day, exactly as it scales
  balance-asset accrual rates.
- Same plan + same seed + same horizon ⇒ identical price path (no randomness; Monte
  Carlo variation remains augment-probability-only).

## Daily ordering (per simulated day)

1. **Purchases** — recurring contribution transfers into the position execute at the
   day's opening price (= previous day's closing price; day 0 uses the initial price):
   `ΔquantityMicro = bankersRound(contributionCents × 10^12 / priceMicroCents_open)`.
   The transfer events move exactly `contributionCents` (conservation is exact).
2. **Price accrual** — the price path advances one day (formula above).
3. **Valuation** — the account balance is reset to
   `bankersRound(quantityMicro × priceMicroCents / 10^12)`; the difference from the
   pre-valuation balance is emitted as one `interest` event
   (`interest:<accountId>:<day>`). This event carries both market growth and the
   sub-cent purchase-rounding reconciliation, so **sum of events always equals the
   balance change** (the conservation property holds by construction).

## Acquisition events

Every purchase is recorded as an acquisition `{dayIndex, date, quantityMicro,
priceMicroCents, costCents}` and exposed in the run result (`LedgerRunResult.positions`).
The plan schema (v3) reserves `AssetRow.acquisitions` for user-entered acquisition
history; v1 scope does not consume it in the engine beyond the opening quantity.

## v1 scope exclusions (do not add without a design doc)

Dividends, splits, tax lots, capital gains, rebalancing, allocation rules, withdrawal
strategies, real market data in the simulated path.

## Negative cash policy (engine edge case, Phase 3.6)

- The synthetic `cash` account **may go negative**. Negative cash models an unfunded
  shortfall (expenses/contributions exceeding income); no borrowing cost is applied.
- Net worth includes negative cash at face value. The series is deterministic and is
  not floored or clamped.
- Debt accounts floor at zero (`allowNegative: false`); asset/position balances are
  driven by valuation and flows and are not floored.
- Surfacing shortfalls to the user is a UI concern (sanity warnings), never an engine
  mutation.
