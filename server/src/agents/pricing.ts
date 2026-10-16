/**
 * USD per million tokens. First-party Claude API prices as of 2026-10 (see the
 * claude-api skill's model table); cache writes bill at 1.25x input, cache reads
 * at 0.1x. Unknown models fall back to the Sonnet row so a typo never records $0.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null | undefined;
  cache_creation_input_tokens?: number | null | undefined;
}

interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Array<{ match: RegExp; price: Price }> = [
  { match: /^claude-opus-5-5/, price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
  { match: /^claude-opus-5/, price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: /^claude-opus-4/, price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: /^claude-sonnet-5-5/, price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { match: /^claude-sonnet-5/, price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 } },
  { match: /^claude-sonnet-4/, price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: /^claude-haiku-5-5/, price: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 } },
  { match: /^claude-haiku/, price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
];
const DEFAULT: Price = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 };

export function priceFor(model: string): Price {
  return PRICES.find((p) => p.match.test(model))?.price ?? DEFAULT;
}

/** Cost of one response in USD, from the usage object the API returns. */
export function costOf(model: string, usage: Usage): number {
  const p = priceFor(model);
  const m = 1_000_000;
  const cost =
    (usage.input_tokens / m) * p.input +
    (usage.output_tokens / m) * p.output +
    ((usage.cache_creation_input_tokens ?? 0) / m) * p.cacheWrite +
    ((usage.cache_read_input_tokens ?? 0) / m) * p.cacheRead;
  return Math.round(cost * 1e6) / 1e6;
}
