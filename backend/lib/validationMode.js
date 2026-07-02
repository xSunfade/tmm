import fs from 'fs/promises';
import path from 'path';

const ENABLED = String(process.env.VALIDATION_MODE || '').toLowerCase() === 'true';
const SCENARIO = process.env.VALIDATION_SCENARIO || 'baseline';
let cachedPack = null;

async function loadPack() {
  if (cachedPack) return cachedPack;
  const filePath = path.resolve(
    process.cwd(),
    'tests/validation/fixtures/validation_mode',
    `${SCENARIO}.json`
  );
  const raw = await fs.readFile(filePath, 'utf8');
  cachedPack = JSON.parse(raw);
  return cachedPack;
}

export async function getValidationResponse(method, routePath, req) {
  if (!ENABLED) return null;
  const pack = await loadPack();
  const key = `${method.toUpperCase()} ${routePath}`;
  const routes = pack?.routes || {};
  const routeValue = routes[key];
  if (!routeValue) return null;
  if (typeof routeValue === 'function') return routeValue(req);
  return routeValue;
}

export function isValidationModeEnabled() {
  return ENABLED;
}
