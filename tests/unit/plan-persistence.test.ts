// Node-side unit tests for the plan persistence module. A minimal in-memory
// localStorage (plus a bare `window` marker) is installed before importing the
// module so the browser-only guards pass.

class MemoryStorage {
  private store = new Map<string, string>();
  failNextSet: Error | null = null;

  get length() {
    return this.store.size;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    if (this.failNextSet) {
      const error = this.failNextSet;
      this.failNextSet = null;
      throw error;
    }
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const memoryStorage = new MemoryStorage();
const globalAny = globalThis as Record<string, unknown>;
globalAny.window = globalThis;
globalAny.localStorage = memoryStorage;
globalAny.sessionStorage = new MemoryStorage();

const { DEFAULT_PLAN_STATE } = await import('../../frontend/src/lib/plan/defaults');
const {
  loadPlanSnapshot,
  savePlanSnapshot,
  getCorruptPlanBackup,
  clearCorruptPlanBackup,
  retryCorruptPlanBackup
} = await import('../../frontend/src/lib/plan/planPersistence');
const { getScopedStorageKey } = await import('../../frontend/src/lib/storage/userScopedStorage');

const PLAN_STORAGE_KEY = getScopedStorageKey('mm-plan');
const BACKUP_STORAGE_KEY = getScopedStorageKey('tmm.plan.corrupt-backup');

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function quotaError(): Error {
  const error = new Error('QuotaExceededError: the quota has been exceeded');
  error.name = 'QuotaExceededError';
  return error;
}

function buildPlan(altName: string) {
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE));
  plan.alternatives[altName] = { income: [], expense: [], asset: [], debt: [] };
  return plan;
}

function testSaveSuccessRoundTrip() {
  memoryStorage.clear();
  const plan = buildPlan('SaveMe');
  assert(savePlanSnapshot(plan) === true, 'successful save must return true');
  const loaded = loadPlanSnapshot();
  assert('SaveMe' in loaded.alternatives, 'saved plan must round-trip through load');
  assert(getCorruptPlanBackup() === null, 'clean round-trip must not create a corrupt backup');
}

function testSaveFailureIsReported() {
  memoryStorage.clear();
  const before = buildPlan('Before');
  assert(savePlanSnapshot(before) === true, 'setup save should succeed');

  memoryStorage.failNextSet = quotaError();
  const after = buildPlan('After');
  assert(savePlanSnapshot(after) === false, 'quota-exceeded save must return false, not throw');

  const loaded = loadPlanSnapshot();
  assert('Before' in loaded.alternatives, 'failed save must leave the previous snapshot intact');
  assert(!('After' in loaded.alternatives), 'failed save must not partially persist');
}

function testCorruptPlanIsBackedUpNotDiscarded() {
  memoryStorage.clear();
  const corruptRaw = '{"alternatives": {"Lost plan"';
  memoryStorage.setItem(PLAN_STORAGE_KEY, corruptRaw);

  const loaded = loadPlanSnapshot();
  assert(
    JSON.stringify(Object.keys(loaded.alternatives)) === JSON.stringify(Object.keys(DEFAULT_PLAN_STATE.alternatives)),
    'corrupt plan load must fall back to the default plan'
  );
  assert(getCorruptPlanBackup() === corruptRaw, 'corrupt raw blob must be preserved in the backup key');
  assert(memoryStorage.getItem(BACKUP_STORAGE_KEY) === corruptRaw, 'backup must live under the scoped backup key');
}

function testFirstBackupIsNotOverwritten() {
  memoryStorage.clear();
  const firstCorrupt = '{"first": corrupt';
  memoryStorage.setItem(PLAN_STORAGE_KEY, firstCorrupt);
  loadPlanSnapshot();

  const secondCorrupt = '{"second": corrupt';
  memoryStorage.setItem(PLAN_STORAGE_KEY, secondCorrupt);
  loadPlanSnapshot();

  assert(getCorruptPlanBackup() === firstCorrupt, 'the first (closest to real data) backup must be kept');
}

function testRetryStillCorruptReturnsNull() {
  memoryStorage.clear();
  memoryStorage.setItem(BACKUP_STORAGE_KEY, '{not json');
  assert(retryCorruptPlanBackup() === null, 'unparseable backup must return null');
  assert(getCorruptPlanBackup() === '{not json', 'failed retry must keep the backup');
}

function testRetryRecoversParseableBackup() {
  memoryStorage.clear();
  const recoverable = buildPlan('Recovered');
  memoryStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(recoverable));

  const recovered = retryCorruptPlanBackup();
  assert(recovered !== null, 'parseable backup must recover');
  assert('Recovered' in (recovered!.alternatives || {}), 'recovered plan must contain the backed-up data');
  assert(getCorruptPlanBackup() === null, 'successful recovery must clear the backup');

  const loaded = loadPlanSnapshot();
  assert('Recovered' in loaded.alternatives, 'recovered plan must become the live snapshot');
}

function testClearCorruptBackup() {
  memoryStorage.clear();
  memoryStorage.setItem(BACKUP_STORAGE_KEY, '{whatever');
  clearCorruptPlanBackup();
  assert(getCorruptPlanBackup() === null, 'clear must remove the backup');
}

function run() {
  console.log('🧪 Running plan persistence unit tests...\n');

  testSaveSuccessRoundTrip();
  console.log('✅ save success round-trip, no spurious backup');

  testSaveFailureIsReported();
  console.log('✅ quota-exceeded save returns false and keeps previous snapshot');

  testCorruptPlanIsBackedUpNotDiscarded();
  console.log('✅ corrupt plan JSON is backed up before falling back');

  testFirstBackupIsNotOverwritten();
  console.log('✅ first corrupt backup is never overwritten');

  testRetryStillCorruptReturnsNull();
  console.log('✅ retry on still-corrupt backup returns null and keeps backup');

  testRetryRecoversParseableBackup();
  console.log('✅ retry recovers parseable backup and clears it');

  testClearCorruptBackup();
  console.log('✅ clear removes the backup');

  console.log('\n✅ plan persistence unit tests passed');
}

run();
