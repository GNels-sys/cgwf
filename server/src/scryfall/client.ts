import { SCRYFALL_USER_AGENT } from "../config.js";

/**
 * All traffic to Scryfall goes through here so we honour their rules:
 * descriptive User-Agent, Accept header, and at least 100 ms between requests.
 */
const MIN_GAP_MS = 100;
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for our turn in the single-file request queue. */
function acquireSlot(): Promise<void> {
  const turn = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  chain = turn.catch(() => undefined);
  return turn;
}

export async function scryfallFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await acquireSlot();
  const headers = new Headers(init.headers);
  headers.set("User-Agent", SCRYFALL_USER_AGENT);
  if (!headers.has("Accept")) headers.set("Accept", "application/json;q=0.9,*/*;q=0.8");
  const res = await fetch(url, { ...init, headers });
  if (res.status === 429) {
    // Back off hard if Scryfall tells us to slow down.
    lastRequestAt = Date.now() + 2000;
  }
  return res;
}

export async function scryfallJson<T>(url: string): Promise<T> {
  const res = await scryfallFetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Scryfall ${res.status} for ${url}`);
  return (await res.json()) as T;
}
