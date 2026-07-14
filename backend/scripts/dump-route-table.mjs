// Dumps the ordered Express route table (method + path) by statically parsing
// route registrations. Used to verify the router split preserves the table
// (Phase 2.9 acceptance: identical pre/post).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const REGISTRATION_RE = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*\n?\s*['"`]([^'"`]+)['"`]/g;

function extract(file) {
  const source = readFileSync(file, 'utf8');
  const rows = [];
  let match;
  while ((match = REGISTRATION_RE.exec(source)) !== null) {
    rows.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return rows;
}

const serverFile = path.join(backendDir, 'server.js');
const routesDir = path.join(backendDir, 'routes');

let rows = [];
if (existsSync(routesDir)) {
  // Post-split: routers own the registrations; mount order lives in server.js.
  const mountOrder = [];
  const serverSource = readFileSync(serverFile, 'utf8');
  const mountRe = /from\s+'\.\/routes\/([\w-]+)\.js'/g;
  let m;
  while ((m = mountRe.exec(serverSource)) !== null) mountOrder.push(`${m[1]}.js`);
  const known = new Set(mountOrder);
  for (const f of readdirSync(routesDir)) {
    if (f.endsWith('.js') && !known.has(f)) mountOrder.push(f);
  }
  rows = rows.concat(extract(serverFile));
  for (const f of mountOrder) rows = rows.concat(extract(path.join(routesDir, f)));
} else {
  rows = extract(serverFile);
}

console.log(rows.join('\n'));
