/**
 * Seeded pseudo-randomness (module 13, FR-3). The whole point is reproducibility:
 * the same {scenario, seed} must yield identical outputs in CI, with light jitter
 * so repeated runs look "alive" rather than frozen. No crypto — speed + determinism.
 */

/** FNV-1a string hash → 32-bit unsigned int. Used to derive per-key seeds. */
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — tiny, fast, deterministic. Returns floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic RNG bound to a set of keys (e.g. seed+segmentId+modelId). */
export class Rng {
  private readonly next: () => number;
  constructor(...keys: (string | number)[]) {
    this.next = mulberry32(hashSeed(...keys));
  }
  /** float in [0,1) */
  float(): number {
    return this.next();
  }
  /** float in [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  /** integer in [min,max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  /** ±frac jitter around v, clamped to [0,1] (handy for bbox/confidence) */
  jitterUnit(v: number, frac = 0.05): number {
    const j = v + (this.next() * 2 - 1) * frac;
    return Math.max(0, Math.min(1, j));
  }
}
