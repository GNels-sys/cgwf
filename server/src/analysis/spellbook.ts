import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import type { SpellbookResults } from "./combos.js";

/**
 * Commander Spellbook client (https://commanderspellbook.com, backend MIT).
 * Their API notes ask for: sparse unauthenticated requests ("a few HTTP calls
 * per user interaction"), a named User-Agent, handling 429s, and credit with a
 * link back. We send one POST per distinct deck list, cache the answer in
 * SQLite (combo_cache), space requests at least 1.5 s apart, and the UI shows
 * "Combos by Commander Spellbook" with a link. Never used for bulk export.
 */
export const SPELLBOOK_URL = "https://backend.commanderspellbook.com/find-my-combos";
export const SPELLBOOK_USER_AGENT = `${config.appName}/${config.appVersion} (private card table; ${config.contactEmail})`;

const MIN_GAP_MS = 1500;
const TIMEOUT_MS = 20_000;

export interface SpellbookDeck {
  commanders: string[];
  main: Array<{ card: string; quantity: number }>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class SpellbookClient {
  private lastRequestAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private backoffUntil = 0;

  constructor(
    private readonly log: FastifyBaseLogger | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private slot(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = Math.max(this.lastRequestAt + MIN_GAP_MS, this.backoffUntil) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  /** Returns the results object, or null when Spellbook could not be reached (caller keeps the rest of the analysis). */
  async findCombos(deck: SpellbookDeck): Promise<SpellbookResults | null> {
    if (deck.main.length === 0 && deck.commanders.length === 0) return { included: [] };
    await this.slot();
    const body = JSON.stringify({
      commanders: deck.commanders.map((c) => ({ card: c, quantity: 1 })),
      main: deck.main.map((m) => ({ card: m.card, quantity: Math.max(1, Math.min(99, m.quantity)) })),
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(SPELLBOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": SPELLBOOK_USER_AGENT },
        body,
        signal: ctl.signal,
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "60");
        this.backoffUntil = Date.now() + Math.max(5, Math.min(600, retry)) * 1000;
        this.log?.warn({ retry }, "Commander Spellbook rate-limited us; backing off");
        return null;
      }
      if (!res.ok) {
        this.log?.warn({ status: res.status }, "Commander Spellbook answered with an error");
        return null;
      }
      const json = (await res.json()) as { results?: SpellbookResults };
      const results = json.results;
      if (!results || !Array.isArray(results.included)) return null;
      // Keep only what we read; the full variant objects carry image URLs we do not need to store.
      return {
        identity: results.identity,
        included: results.included.map(slim),
        almostIncluded: (results.almostIncluded ?? []).slice(0, 20).map(slim),
      };
    } catch (err) {
      this.log?.warn({ err }, "Commander Spellbook request failed");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function slim(v: SpellbookResults["included"][number]): SpellbookResults["included"][number] {
  return {
    id: v.id,
    status: v.status,
    identity: v.identity,
    uses: v.uses.map((u) => ({ card: { name: u.card.name }, quantity: u.quantity, mustBeCommander: u.mustBeCommander })),
    requires: (v.requires ?? []).map((r) => ({ template: { name: r.template?.name }, quantity: r.quantity })),
    produces: v.produces.map((p) => ({ feature: { name: p.feature.name, status: p.feature.status, uncountable: p.feature.uncountable }, quantity: p.quantity })),
    manaValueNeeded: v.manaValueNeeded,
    manaNeeded: v.manaNeeded,
    bracketTag: v.bracketTag ?? null,
    description: typeof v.description === "string" ? v.description.slice(0, 1500) : undefined,
    popularity: v.popularity ?? null,
  };
}
