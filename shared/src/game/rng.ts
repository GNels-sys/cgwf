/**
 * Tiny deterministic PRNG (mulberry32). The game state carries the current
 * 32-bit RNG state; every shuffle, die roll or coin flip advances it, so a
 * replay of the same events from the same seed produces the same results.
 * Pure: functions return the next state instead of mutating.
 */

export type RngState = number;

/** FNV-1a over a string, so the room seed can be any random string. */
export function seedFromString(seed: string): RngState {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Next 32-bit unsigned value and the state that follows it. */
export function nextU32(state: RngState): [number, RngState] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [(t ^ (t >>> 14)) >>> 0, s >>> 0];
}

/** Uniform integer in [0, n). */
export function nextInt(state: RngState, n: number): [number, RngState] {
  if (n <= 0) return [0, state];
  const [v, next] = nextU32(state);
  return [Math.floor((v / 4294967296) * n), next];
}

/** Fisher-Yates; returns a new array and the advanced state. */
export function shuffle<T>(items: readonly T[], state: RngState): [T[], RngState] {
  const out = items.slice();
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    let j: number;
    [j, s] = nextInt(s, i + 1);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return [out, s];
}

/** Short opaque id ("c" + base36). Ids come from the RNG stream, so replays agree. */
export function nextId(state: RngState, prefix = "c"): [string, RngState] {
  const [v, s] = nextU32(state);
  return [prefix + v.toString(36), s];
}
