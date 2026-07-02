export type DeterministicRng = {
  seed: number;
  next: () => number;
  nextInt: (maxExclusive: number) => number;
  chance: (probability: number) => boolean;
};

export function createRng(seedInput: number): DeterministicRng {
  let seed = (Math.trunc(seedInput) >>> 0) || 1;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const nextInt = (maxExclusive: number) => {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
    return Math.floor(next() * maxExclusive);
  };
  const chance = (probability: number) => next() < Math.max(0, Math.min(1, probability));
  return { seed: seedInput >>> 0, next, nextInt, chance };
}

export function seededShuffle<T>(values: T[], rng: DeterministicRng): T[] {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
