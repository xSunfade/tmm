# Chaos Report

## Configuration

- Seed: `1337`
- Iterations: `8`

## Assertions

- Final DB state identical: `true`
- Balances/node values identical: `true`
- Cursor only advanced forward: `true`
- No duplicate final rows: `true`

## State Summary

- Baseline cursor: `cursor_1`
- Chaos cursor: `cursor_2`
- Baseline node value (cents): `-139878`
- Chaos node value (cents): `-139878`
- Baseline tx rows: `2`
- Chaos tx rows: `2`

## Chaos Summary

```json
{
  "seed": 1337,
  "pagesProduced": 1,
  "duplicateTransactionsInjected": 6,
  "replayCount": 8,
  "crashInjectedAtIteration": 2,
  "concurrentInterleaveUsed": true
}
```
