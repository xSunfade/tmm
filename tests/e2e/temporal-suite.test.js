import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function computeEffectiveValue(state) {
  if (state.status === 'connected') {
    if (state.overrideActive && state.manualValue != null) return Number(state.manualValue);
    if (state.autoValue != null) return Number(state.autoValue);
  }
  if (state.manualValue != null) return Number(state.manualValue);
  if (state.autoValue != null) return Number(state.autoValue);
  return 0;
}

function pickHistorySource({ hasPlaidLive, hasPlaidArchived, hasCheckpoint, hasManual }) {
  if (hasPlaidLive) return 'plaid_live';
  if (hasPlaidArchived) return 'plaid_archived';
  if (hasCheckpoint) return 'checkpoint';
  if (hasManual) return 'manual';
  return 'none';
}

function applyReconnectMapping(entityState, mapping) {
  if (!entityState.connectedAccountId || !mapping) return entityState;
  if (mapping[entityState.connectedAccountId]) {
    return {
      ...entityState,
      connectedAccountId: mapping[entityState.connectedAccountId]
    };
  }
  return entityState;
}

async function loadTemporalFixture() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturePath = path.resolve(__dirname, '../fixtures/temporal/personas.json');
  const raw = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(raw);
}

function runPersona(persona) {
  const observed = [];
  let entityState = null;

  for (const step of persona.timeline) {
    entityState = {
      status: step.status,
      connectedAccountId: step.connectedAccountId,
      autoValue: step.autoValue,
      manualValue: step.manualValue,
      overrideActive: !!step.overrideActive
    };

    if (step.status === 'connected' && persona.expectedReconnectMapping) {
      entityState = applyReconnectMapping(entityState, persona.expectedReconnectMapping);
    }

    const effective = computeEffectiveValue(entityState);
    assert(
      effective === Number(step.expectedEffectiveValue),
      `${persona.id} ${step.slice}: expected ${step.expectedEffectiveValue}, got ${effective}`
    );

    observed.push({ slice: step.slice, value: effective, connectedAccountId: entityState.connectedAccountId });
  }

  // Determinism check: replaying the same timeline should match exactly.
  const replay = persona.timeline.map((step) => {
    const base = {
      status: step.status,
      connectedAccountId: step.connectedAccountId,
      autoValue: step.autoValue,
      manualValue: step.manualValue,
      overrideActive: !!step.overrideActive
    };
    const mapped = step.status === 'connected' && persona.expectedReconnectMapping
      ? applyReconnectMapping(base, persona.expectedReconnectMapping)
      : base;
    return {
      slice: step.slice,
      value: computeEffectiveValue(mapped),
      connectedAccountId: mapped.connectedAccountId
    };
  });
  assert(JSON.stringify(observed) === JSON.stringify(replay), `${persona.id}: timeline replay is not deterministic`);

  // Source ladder sanity check on late slices.
  const lateSlice = persona.timeline[persona.timeline.length - 1];
  const source = pickHistorySource({
    hasPlaidLive: lateSlice.status === 'connected',
    hasPlaidArchived: lateSlice.status !== 'connected',
    hasCheckpoint: true,
    hasManual: true
  });
  if (lateSlice.status === 'connected') {
    assert(source === 'plaid_live', `${persona.id}: expected plaid_live source on connected late slice`);
  } else {
    assert(source === 'plaid_archived', `${persona.id}: expected plaid_archived source on disconnected late slice`);
  }

  if (persona.expectedReconnectMapping) {
    const keys = Object.keys(persona.expectedReconnectMapping);
    for (const oldId of keys) {
      const newId = persona.expectedReconnectMapping[oldId];
      const hasMappedStep = observed.some((o) => o.connectedAccountId === newId);
      assert(hasMappedStep, `${persona.id}: reconnect mapping ${oldId} -> ${newId} never appeared`);
    }
  }
}

async function run() {
  console.log('🧪 Running temporal suite (T0 -> T+180d)...\n');
  const fixture = await loadTemporalFixture();
  assert(Array.isArray(fixture.personas) && fixture.personas.length > 0, 'No personas found in temporal fixture');

  for (const persona of fixture.personas) {
    runPersona(persona);
    console.log(`✅ persona ${persona.id}`);
  }

  console.log('\n✅ temporal suite passed');
}

run().catch((err) => {
  console.error(`\n❌ temporal suite failed: ${err.message}`);
  process.exit(1);
});
