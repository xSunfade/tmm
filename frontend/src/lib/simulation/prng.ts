function xmur3(input: string): () => number {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function deriveSeed(baseSeed: string, runIndex: number, ...parts: string[]): string {
  const suffix = [String(runIndex), ...parts].join(':');
  return `${baseSeed}:${suffix}`;
}

export function createRng(seed: string): () => number {
  const seedFactory = xmur3(seed || 'tmm-default-seed');
  return mulberry32(seedFactory());
}

export function randomForKey(baseSeed: string, key: string): number {
  return createRng(`${baseSeed}:${key}`)();
}
