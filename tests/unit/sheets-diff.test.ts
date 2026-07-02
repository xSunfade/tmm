import {
  cellsEqual,
  entityRowsEqual,
  diffEntitySheet,
  type EntitySheetDiff
} from '../../frontend/src/lib/sheets/sync';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// cellsEqual: must return true ONLY when confidently identical.
// ---------------------------------------------------------------------------
function testCellsEqualExactAndNumeric() {
  // Exact string matches.
  assert(cellsEqual('biweekly', 'biweekly'), 'identical strings should be equal');
  assert(cellsEqual('', ''), 'empty strings equal');
  assert(cellsEqual('  hi  ', 'hi'), 'trimmed strings equal');

  // Null/undefined normalize to empty string.
  assert(cellsEqual(null, ''), 'null equals empty');
  assert(cellsEqual(undefined, null), 'undefined equals null');

  // Numeric equivalence across representations (formatted vs raw).
  assert(cellsEqual(1000, '1000'), 'number vs plain string');
  assert(cellsEqual(1000, '1,000'), 'thousands separator tolerated');
  assert(cellsEqual(1000, '$1,000'), 'currency prefix tolerated');
  assert(cellsEqual('2500.5', 2500.5), 'decimal equality');
  assert(cellsEqual(0, '0'), 'zero equality');
  assert(cellsEqual(-50, '-50'), 'negative equality');
}

function testCellsEqualNeverFalsePositive() {
  // Different numbers.
  assert(!cellsEqual(1000, 1500), 'different numbers not equal');
  assert(!cellsEqual(1000, '1,500'), 'different formatted numbers not equal');
  // Rounding must NOT be treated as equal (would risk skipping a real change).
  assert(!cellsEqual(3.333333, '3.33'), 'rounded display value is not equal');
  // Different strings (the exact bug: frequency change).
  assert(!cellsEqual('weekly', 'biweekly'), 'weekly != biweekly');
  assert(!cellsEqual('TRUE', 'FALSE'), 'boolean flip not equal');
  // Empty vs value: '' does not parse as a number, '0'/100 do -> not equal.
  assert(!cellsEqual('', '0'), 'empty vs "0" not equal');
  assert(!cellsEqual('', 100), 'empty vs number not equal');
  // Ambiguous / non-plain-number formats fall back to string compare (not equal).
  assert(!cellsEqual('1000', '1e3'), 'scientific notation not treated as equal to 1000');
  assert(!cellsEqual('Jan 2026', '2026-01'), 'date reformatting not treated as equal');
}

// ---------------------------------------------------------------------------
// entityRowsEqual: only compares managed columns (0..columnCount-1).
// ---------------------------------------------------------------------------
function testEntityRowsEqual() {
  const a = [UUID_A, 'Salary', 1000, 'monthly'];
  const b = [UUID_A, 'Salary', '1,000', 'monthly'];
  assert(entityRowsEqual(a, b, 4), 'rows equal despite numeric formatting');

  const changed = [UUID_A, 'Salary', 1000, 'biweekly'];
  assert(!entityRowsEqual(a, changed, 4), 'frequency change detected');

  // Extra trailing columns beyond columnCount are ignored.
  const withExtra = [UUID_A, 'Salary', 1000, 'monthly', 'user-note'];
  assert(entityRowsEqual(a, withExtra, 4), 'columns beyond columnCount ignored');

  // Shorter existing row (Google trims trailing empties) with empty managed cells.
  const tmm = [UUID_A, 'Salary', 1000, 'monthly', ''];
  const shortSheet = [UUID_A, 'Salary', 1000, 'monthly'];
  assert(entityRowsEqual(shortSheet, tmm, 5), 'missing trailing cell treated as empty');
}

// ---------------------------------------------------------------------------
// diffEntitySheet: the core "never skip a real change" guarantee.
// ---------------------------------------------------------------------------
const HEADER = ['UUID', 'Name', 'Amount', 'Frequency'];
const COLS = HEADER.length;

function tmm(...rows: unknown[][]): unknown[][] {
  return [HEADER, ...rows];
}

function testDiffSkipsUnchangedRows() {
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', '1,000', 'monthly'] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'monthly']), COLS);
  assert(diff.toUpdate.length === 0, 'unchanged row should not be updated');
  assert(diff.toDelete.length === 0, 'unchanged row should not be deleted');
  assert(diff.toAdd.length === 0, 'unchanged row should not be added');
}

function testDiffCatchesFrequencyChange() {
  // The exact reported scenario: Weekly -> Biweekly.
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'weekly'] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'biweekly']), COLS);
  assert(diff.toUpdate.length === 1, 'frequency change MUST be updated');
  assert(diff.toUpdate[0].rowIndex === 2, 'update targets the correct row');
  assert(diff.toUpdate[0].values[3] === 'biweekly', 'update carries the new frequency');
}

function testDiffCatchesAmountChange() {
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1200, 'monthly']), COLS);
  assert(diff.toUpdate.length === 1, 'amount change MUST be updated');
  assert(diff.toUpdate[0].values[2] === 1200, 'new amount carried');
}

function testDiffWithoutColumnCountAlwaysUpdates() {
  // Backward-compat: no columnCount => never skip (previous behavior).
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'monthly']));
  assert(diff.toUpdate.length === 1, 'without columnCount, matched rows always update');
}

function testDiffMissingValuesAlwaysUpdates() {
  // If a row has no captured values, we cannot prove equality => update.
  const sheetRows = [{ rowIndex: 2, uuid: UUID_A }];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'monthly']), COLS);
  assert(diff.toUpdate.length === 1, 'no values => must update (cannot prove unchanged)');
}

function testDiffDeletesOrphansAndInvalids() {
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] },
    { rowIndex: 3, uuid: 'not-a-uuid', values: ['not-a-uuid', 'Bad', 0, 'monthly'] },
    { rowIndex: 4, uuid: UUID_B, values: [UUID_B, 'Gone', 5, 'monthly'] }
  ];
  // TMM only knows about UUID_A.
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'monthly']), COLS);
  // Row 3 (invalid uuid) + row 4 (orphan) deleted, descending order.
  assert(JSON.stringify(diff.toDelete) === JSON.stringify([4, 3]), `orphans/invalids deleted descending, got ${JSON.stringify(diff.toDelete)}`);
  assert(diff.toUpdate.length === 0, 'matching unchanged row not updated');
}

function testDiffDeletesDuplicateUuids() {
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] },
    { rowIndex: 3, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm([UUID_A, 'Salary', 1000, 'monthly']), COLS);
  assert(JSON.stringify(diff.toDelete) === JSON.stringify([3]), 'duplicate uuid: keep first, delete rest');
  assert(diff.toUpdate.length === 0, 'kept row unchanged -> no update');
}

function testDiffAddsNewRows() {
  const sheetRows = [
    { rowIndex: 2, uuid: UUID_A, values: [UUID_A, 'Salary', 1000, 'monthly'] }
  ];
  const diff = diffEntitySheet(
    sheetRows,
    tmm([UUID_A, 'Salary', 1000, 'monthly'], [UUID_C, 'Bonus', 500, 'yearly']),
    COLS
  );
  assert(diff.toAdd.length === 1, 'new tmm row should be appended');
  assert(diff.toAdd[0][0] === UUID_C, 'correct new row appended');
  assert(diff.toUpdate.length === 0, 'existing unchanged row not updated');
}

function testDiffNeverTouchesHeaderRow() {
  // Row indices < 2 must never appear in toDelete.
  const sheetRows = [
    { rowIndex: 1, uuid: 'UUID', values: ['UUID', 'Name', 'Amount', 'Frequency'] },
    { rowIndex: 2, uuid: 'bad', values: ['bad', '', 0, ''] }
  ];
  const diff = diffEntitySheet(sheetRows, tmm(), COLS);
  assert(!diff.toDelete.includes(1), 'header row (1) must never be deleted');
}

function assertNoSkip(diff: EntitySheetDiff, expectUpdate: boolean, label: string) {
  assert(diff.toUpdate.length === (expectUpdate ? 1 : 0), label);
}

function testFuzzNeverSkipsRealChanges() {
  // Randomized: for many mutated rows, a genuine change must always produce an update.
  const fields = ['Name', 'Amount', 'Frequency'];
  let checks = 0;
  for (let i = 0; i < 500; i++) {
    const base = [UUID_A, 'Salary', 1000, 'monthly'];
    const mutated = [...base];
    const idx = 1 + (i % fields.length);
    // Apply a change that is semantically different.
    if (idx === 2) {
      mutated[idx] = 1000 + ((i % 9) + 1); // amount +1..+9 (never a formatting-equal value)
    } else {
      mutated[idx] = `${base[idx]}-changed-${i}`;
    }
    const sheetRows = [{ rowIndex: 2, uuid: UUID_A, values: base }];
    const diff = diffEntitySheet(sheetRows, [HEADER, mutated], COLS);
    assertNoSkip(diff, true, `fuzz: change at col ${idx} must update (i=${i})`);
    checks++;
  }
  assert(checks === 500, 'fuzz executed all iterations');
}

function run() {
  console.log('🧪 Running sheets diff/cellsEqual unit tests...\n');

  testCellsEqualExactAndNumeric();
  console.log('✅ cellsEqual: exact + numeric equivalence');

  testCellsEqualNeverFalsePositive();
  console.log('✅ cellsEqual: no false positives (rounding/dates/booleans)');

  testEntityRowsEqual();
  console.log('✅ entityRowsEqual: managed-column comparison');

  testDiffSkipsUnchangedRows();
  console.log('✅ diff: skips genuinely unchanged rows');

  testDiffCatchesFrequencyChange();
  console.log('✅ diff: catches Weekly -> Biweekly change');

  testDiffCatchesAmountChange();
  console.log('✅ diff: catches amount change');

  testDiffWithoutColumnCountAlwaysUpdates();
  console.log('✅ diff: backward-compatible (no columnCount => always update)');

  testDiffMissingValuesAlwaysUpdates();
  console.log('✅ diff: missing row values => always update');

  testDiffDeletesOrphansAndInvalids();
  console.log('✅ diff: deletes orphans + invalid UUIDs (descending)');

  testDiffDeletesDuplicateUuids();
  console.log('✅ diff: dedupes duplicate UUIDs');

  testDiffAddsNewRows();
  console.log('✅ diff: appends new rows');

  testDiffNeverTouchesHeaderRow();
  console.log('✅ diff: never deletes header row');

  testFuzzNeverSkipsRealChanges();
  console.log('✅ diff: fuzz (500x) never skips a real change');

  console.log('\n✅ sheets diff/cellsEqual unit tests passed');
}

run();
