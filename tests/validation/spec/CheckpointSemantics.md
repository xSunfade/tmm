# Checkpoint Semantics

## Checkpoint model

- Checkpoint is a **state-reset event** at `checkpoint.date` for the targeted alternative.
- It overrides projected value from that date forward for the checkpointed entities.

## Precedence

1. Explicit reconciliation override for a date
2. Plaid live/archived point for date (if present and not overridden)
3. Checkpoint value
4. Pure projection fallback

## Ghost-adjustment prevention

- Applying a checkpoint creates one deterministic adjustment event id:
  - `checkpoint_adjust:<alt>:<date>`
- Re-applying the same checkpoint/date must not create additional adjustment events.
- Reconciliation overrides must reference checkpoint id/date pair to prevent duplicate correction cascades.
