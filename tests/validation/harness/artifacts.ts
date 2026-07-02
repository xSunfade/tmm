import fs from 'fs/promises';
import path from 'path';

export type ArtifactType =
  | 'plaid_final_state_snapshot'
  | 'plaid_state_diff'
  | 'ledger_snapshot'
  | 'ui_parity_expected'
  | 'ui_parity_observed'
  | 'ui_parity_diff'
  | 'drift_forensics'
  | 'reconciliation_events';

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortDeep(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export async function writeArtifact(
  rootDir: string,
  filename: string,
  artifactType: ArtifactType,
  seed: number,
  payload: Record<string, unknown>
) {
  const target = path.resolve(rootDir, 'tests/validation/artifacts', filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const envelope = {
    schemaVersion: '1.0.0',
    artifactType,
    generatedAt: new Date().toISOString(),
    seed,
    payload
  };
  await fs.writeFile(target, JSON.stringify(sortDeep(envelope), null, 2), 'utf8');
  return target;
}
