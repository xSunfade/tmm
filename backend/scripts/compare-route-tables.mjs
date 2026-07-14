// One-shot verifier for the Phase 2.9 router split: extracts the route table
// from a pre-split server.js snapshot and compares it (as a set) with the
// current split layout. Exits non-zero on any difference.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const preSplitPath = process.argv[2];
if (!preSplitPath) {
  console.error('usage: node compare-route-tables.mjs <pre-split-server.js>');
  process.exit(2);
}

const RE = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*\n?\s*['"`]([^'"`]+)['"`]/g;

function extract(source) {
  const rows = [];
  let m;
  const re = new RegExp(RE.source, 'g');
  while ((m = re.exec(source)) !== null) rows.push(`${m[1].toUpperCase()} ${m[2]}`);
  return rows;
}

const before = extract(readFileSync(preSplitPath, 'utf8'));
const afterRaw = execFileSync(process.execPath, [path.join(backendDir, 'scripts', 'dump-route-table.mjs')], {
  encoding: 'utf8'
});
const after = afterRaw.split('\n').map((l) => l.trim()).filter(Boolean);

const beforeSet = new Set(before);
const afterSet = new Set(after);
const missing = before.filter((r) => !afterSet.has(r));
const added = after.filter((r) => !beforeSet.has(r));

console.log(`before: ${before.length} routes, after: ${after.length} routes`);
if (missing.length || added.length) {
  if (missing.length) console.error('MISSING after split:\n  ' + missing.join('\n  '));
  if (added.length) console.error('ADDED after split:\n  ' + added.join('\n  '));
  process.exit(1);
}
console.log('ROUTE TABLES IDENTICAL');
