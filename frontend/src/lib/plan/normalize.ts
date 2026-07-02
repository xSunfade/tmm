import type { PlanState } from './types';

type Entity = { uuid?: string | null };

function generateUuid(prefix: string) {
  const base =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${base}`;
}

function ensureListUuids(list: Entity[], prefix: string, used: Set<string>) {
  let changed = false;
  list.forEach((item) => {
    const current = String(item.uuid || '').trim();
    if (!current) {
      let next = generateUuid(prefix);
      while (used.has(next)) {
        next = generateUuid(prefix);
      }
      item.uuid = next;
      used.add(next);
      changed = true;
      return;
    }
    if (!used.has(current)) {
      used.add(current);
      return;
    }
    let deduped = generateUuid(prefix);
    while (used.has(deduped)) {
      deduped = generateUuid(prefix);
    }
    item.uuid = deduped;
    used.add(deduped);
    changed = true;
  });
  return changed;
}

export function ensureEntityUuids(plan: PlanState) {
  const used = new Set<string>();
  let changed = false;
  Object.values(plan.alternatives || {}).forEach((alt) => {
    changed = ensureListUuids(alt.income || [], 'income', used) || changed;
    changed = ensureListUuids(alt.expense || [], 'expense', used) || changed;
    changed = ensureListUuids(alt.asset || [], 'asset', used) || changed;
    changed = ensureListUuids(alt.debt || [], 'debt', used) || changed;
  });
  return changed;
}
