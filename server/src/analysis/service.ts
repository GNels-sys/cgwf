import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Board, DeckAnalysis } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, comboCache, deckCards } from "../db/schema.js";
import { analyzeDeck, fromRow, loadGameChangers, type AnalysisCard } from "./index.js";
import type { SpellbookResults } from "./combos.js";
import { SpellbookClient } from "./spellbook.js";

/**
 * Glue between the pure engine and the world: loads card rows, asks Commander
 * Spellbook (through the per-list cache), runs the analysis. Shared by the
 * deck page route, the library and the precon importer.
 */
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export interface AnalyzeResult {
  analysis: DeckAnalysis;
  combosCached: boolean;
  cards: AnalysisCard[];
}

export class DeckAnalyzer {
  constructor(
    private readonly handle: DbHandle,
    private readonly spellbook: SpellbookClient,
    private readonly log: FastifyBaseLogger | null = null,
  ) {}

  /** Cards of a user deck (main + commander only; sideboards do not count). */
  loadDeckCards(deckId: string): AnalysisCard[] {
    const rows = this.handle.db
      .select({ dc: deckCards, card: cards })
      .from(deckCards)
      .innerJoin(cards, eq(cards.id, deckCards.cardId))
      .where(eq(deckCards.deckId, deckId))
      .orderBy(deckCards.position)
      .all();
    return rows.filter((r) => r.dc.board === "main" || r.dc.board === "commander").map((r) => fromRow(r.card, r.dc.quantity, r.dc.board as Extract<Board, "main" | "commander">));
  }

  /** Cards from printing ids (library decks, precon import). */
  loadCardsByIds(entries: Array<{ cardId: string; quantity: number; board: string }>): AnalysisCard[] {
    const ids = [...new Set(entries.map((e) => e.cardId))];
    if (ids.length === 0) return [];
    const rows = this.handle.db.select().from(cards).where(inArray(cards.id, ids)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: AnalysisCard[] = [];
    for (const e of entries) {
      if (e.board !== "main" && e.board !== "commander") continue;
      const row = byId.get(e.cardId);
      if (row) out.push(fromRow(row, e.quantity, e.board));
    }
    return out;
  }

  static listHash(cards: AnalysisCard[]): string {
    const names = cards
      .flatMap((c) => Array.from({ length: Math.max(1, c.quantity) }, () => `${c.board === "commander" ? "!" : ""}${c.name}`))
      .sort();
    return createHash("sha256").update(names.join("\n")).digest("hex");
  }

  private readCache(hash: string): SpellbookResults | null {
    const row = this.handle.db.select().from(comboCache).where(eq(comboCache.listHash, hash)).get();
    if (!row) return null;
    if (Date.now() - Date.parse(row.fetchedAt) > CACHE_MAX_AGE_MS) return null;
    return row.results as SpellbookResults;
  }

  private writeCache(hash: string, results: SpellbookResults): void {
    this.handle.db
      .insert(comboCache)
      .values({ listHash: hash, results, fetchedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: comboCache.listHash, set: { results, fetchedAt: new Date().toISOString() } })
      .run();
  }

  /** The cached Spellbook answer for this exact list (after `analyze`), incl. one-card-away combos. */
  cachedCombos(cards: AnalysisCard[]): SpellbookResults | null {
    const row = this.handle.db.select().from(comboCache).where(eq(comboCache.listHash, DeckAnalyzer.listHash(cards))).get();
    return row ? (row.results as SpellbookResults) : null;
  }

  /** Engine only, no Spellbook request (uses a cached answer when one exists). For list views. */
  analyzeSync(cards: AnalysisCard[]): DeckAnalysis {
    const cached = this.readCache(DeckAnalyzer.listHash(cards));
    return analyzeDeck(cards, { gameChangers: loadGameChangers(), combos: cached ?? undefined });
  }

  /**
   * Full analysis. `combos: "cached"` uses the cache and asks Spellbook on a
   * miss; `"refresh"` always asks; `"skip"` never asks (fast, for lists).
   */
  async analyze(cards: AnalysisCard[], opts: { combos?: "cached" | "refresh" | "skip" } = {}): Promise<AnalyzeResult> {
    const mode = opts.combos ?? "cached";
    const gameChangers = loadGameChangers();
    let combos: SpellbookResults | null | undefined;
    let combosCached = false;
    if (mode !== "skip") {
      const hash = DeckAnalyzer.listHash(cards);
      const cached = mode === "cached" ? this.readCache(hash) : null;
      if (cached) {
        combos = cached;
        combosCached = true;
      } else {
        combos = await this.spellbook.findCombos({
          commanders: cards.filter((c) => c.board === "commander").map((c) => c.name),
          main: cards.filter((c) => c.board === "main").map((c) => ({ card: c.name, quantity: c.quantity })),
        });
        if (combos) this.writeCache(hash, combos);
        else {
          // Keep an old answer rather than nothing when Spellbook is down.
          const stale = this.handle.db.select().from(comboCache).where(eq(comboCache.listHash, hash)).get();
          if (stale) {
            combos = stale.results as SpellbookResults;
            combosCached = true;
            this.log?.info("Commander Spellbook unavailable; using a stale cached answer");
          }
        }
      }
    }
    const analysis = analyzeDeck(cards, { gameChangers, combos });
    return { analysis, combosCached, cards };
  }
}
