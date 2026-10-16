import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { normalizeName, type LibraryImportState } from "@cgwf/shared";
import type { FetchLike } from "../analysis/spellbook.js";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";
import type { NameIndex } from "../search/index.js";
import type { LibraryEntry, LibraryService } from "./service.js";

/**
 * Commander preconstructed decklists from MTGJSON (https://mtgjson.com, MIT
 * licence; data courtesy of MTGJSON). Verified 2026-10-15:
 *   https://mtgjson.com/api/v5/DeckList.json            every deck's metadata (3113 rows,
 *                                                        197 with type "Commander Deck")
 *   https://mtgjson.com/api/v5/decks/<fileName>.json    one deck: commander[], mainBoard[],
 *                                                        sideBoard[], each card with
 *                                                        identifiers.scryfallId + count
 * Runs in the background with progress like the Scryfall ingest; idempotent
 * (decks already in the library are skipped by their MTGJSON fileName).
 */
export const MTGJSON_DECK_LIST_URL = "https://mtgjson.com/api/v5/DeckList.json";
export const MTGJSON_DECK_URL = (fileName: string) => `https://mtgjson.com/api/v5/decks/${encodeURIComponent(fileName)}.json`;
export const MTGJSON_USER_AGENT = `${config.appName}/${config.appVersion} (private card table; ${config.contactEmail})`;
const GAP_MS = 250;
const PRECON_KEY = (fileName: string) => `mtgjson:${fileName}`;

interface DeckListEntry {
  code: string;
  fileName: string;
  name: string;
  releaseDate: string;
  type: string;
}

interface MtgjsonCard {
  name: string;
  count?: number;
  setCode?: string;
  number?: string;
  identifiers?: { scryfallId?: string };
}

interface MtgjsonDeck {
  code: string;
  name: string;
  releaseDate?: string;
  type?: string;
  commander?: MtgjsonCard[];
  mainBoard?: MtgjsonCard[];
  sideBoard?: MtgjsonCard[];
}

export interface PreconImportOptions {
  /** Re-import decks already in the library (replaces nothing: existing rows are kept, missing ones added). */
  force?: boolean;
  /** Ask Commander Spellbook for each deck (cached per list). Off = faster, combos "skipped". */
  combos?: boolean;
  /** Limit for tests. */
  limit?: number;
}

export class PreconImporter {
  readonly state: LibraryImportState = { running: false, phase: "idle", total: 0, done: 0, imported: 0, skipped: 0, errors: [], error: null, startedAt: null, finishedAt: null };
  private lastRequestAt = 0;

  constructor(
    private readonly handle: DbHandle,
    private readonly index: NameIndex,
    private readonly library: LibraryService,
    private readonly log: FastifyBaseLogger | null,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async getJson<T>(url: string): Promise<T> {
    const wait = this.lastRequestAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
    const res = await this.fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": MTGJSON_USER_AGENT } });
    if (!res.ok) throw new Error(`MTGJSON ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  /** Map an MTGJSON card to one of our printing ids: Scryfall id first, then exact name. */
  resolveCard(c: MtgjsonCard): string | null {
    const sid = c.identifiers?.scryfallId;
    if (sid) {
      const row = this.handle.db.select({ id: cards.id }).from(cards).where(eq(cards.id, sid)).get();
      if (row) return row.id;
    }
    const exact = this.index.exact(normalizeName(c.name));
    return exact ? exact.id : null;
  }

  private entriesFor(deck: MtgjsonDeck): { entries: LibraryEntry[]; missing: string[] } {
    const entries: LibraryEntry[] = [];
    const missing: string[] = [];
    const push = (list: MtgjsonCard[] | undefined, board: LibraryEntry["board"]) => {
      for (const c of list ?? []) {
        const id = this.resolveCard(c);
        if (!id) {
          missing.push(c.name);
          continue;
        }
        const existing = entries.find((e) => e.cardId === id && e.board === board);
        if (existing) existing.quantity += Math.max(1, c.count ?? 1);
        else entries.push({ cardId: id, quantity: Math.max(1, c.count ?? 1), board });
      }
    };
    push(deck.commander, "commander");
    push(deck.mainBoard, "main");
    push(deck.sideBoard, "sideboard");
    return { entries, missing };
  }

  async run(opts: PreconImportOptions = {}): Promise<void> {
    if (this.state.running) return;
    Object.assign(this.state, { running: true, phase: "list", total: 0, done: 0, imported: 0, skipped: 0, errors: [], error: null, startedAt: new Date().toISOString(), finishedAt: null });
    try {
      const list = await this.getJson<{ data: DeckListEntry[] }>(MTGJSON_DECK_LIST_URL);
      let decks = (list.data ?? []).filter((d) => d.type === "Commander Deck" && d.fileName);
      decks.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.name.localeCompare(b.name));
      if (opts.limit) decks = decks.slice(0, opts.limit);
      this.state.total = decks.length;
      this.state.phase = "decks";
      for (const d of decks) {
        try {
          if (!opts.force && this.library.bySourceKey(PRECON_KEY(d.fileName))) {
            this.state.skipped++;
            continue;
          }
          const deck = await this.getJson<{ data: MtgjsonDeck }>(MTGJSON_DECK_URL(d.fileName));
          const { entries, missing } = this.entriesFor(deck.data);
          const total = entries.length + missing.length;
          if (entries.length === 0 || missing.length > total * 0.1) {
            this.state.errors.push(`${d.name} (${d.code}): ${missing.length} of ${total} cards not found (${missing.slice(0, 3).join(", ")})`);
            continue;
          }
          if (missing.length) this.state.errors.push(`${d.name} (${d.code}): missing ${missing.join(", ")}`);
          if (this.library.bySourceKey(PRECON_KEY(d.fileName))) {
            this.state.skipped++;
            continue;
          }
          await this.library.create(
            {
              name: d.name,
              source: "precon",
              sourceKey: PRECON_KEY(d.fileName),
              setCode: d.code,
              setName: null,
              releaseDate: d.releaseDate,
              bracket: 2,
              entries,
            },
            { combos: opts.combos === false ? "skip" : "cached" },
          );
          this.state.imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.state.errors.push(`${d.name} (${d.code}): ${msg}`);
          this.log?.warn({ err, deck: d.fileName }, "precon import failed for one deck");
        } finally {
          this.state.done++;
        }
      }
      this.state.phase = "done";
      this.log?.info({ imported: this.state.imported, skipped: this.state.skipped, errors: this.state.errors.length }, "precon import finished");
    } catch (err) {
      this.state.phase = "error";
      this.state.error = err instanceof Error ? err.message : String(err);
      this.log?.error({ err }, "precon import failed");
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }
}
