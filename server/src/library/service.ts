import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import {
  isArchetypeTag,
  isBracket,
  type ArchetypeTag,
  type Bracket,
  type DeckAnalysis,
  type LibraryDeckDetail,
  type LibraryDeckSummary,
  type LibraryPatchRequest,
} from "@cgwf/shared";
import type { DeckAnalyzer } from "../analysis/service.js";
import { primerSkeleton } from "../analysis/index.js";
import type { DbHandle } from "../db/index.js";
import { cards, libraryDeckCards, libraryDecks, type LibraryDeckRow } from "../db/schema.js";

/**
 * The owner's deck library. Rows come from the precon importer or from "add my
 * deck to the library"; the owner edits bracket, tags, primer and the
 * agent-eligible flag. Phase 7 reads `agentEligible` rows and their primers.
 */
export interface LibraryEntry {
  cardId: string;
  quantity: number;
  board: "main" | "commander" | "sideboard";
}

export interface CreateLibraryDeck {
  name: string;
  source: "precon" | "user";
  sourceKey: string | null;
  setCode?: string | null;
  setName?: string | null;
  releaseDate?: string | null;
  bracket?: Bracket;
  createdBy?: string | null;
  entries: LibraryEntry[];
}

export interface ListFilters {
  bracket?: Bracket | undefined;
  tag?: ArchetypeTag | undefined;
  q?: string | undefined;
  source?: "precon" | "user" | undefined;
  agentEligible?: boolean | undefined;
}

const MAX_PRIMER = 40_000;

export class LibraryService {
  constructor(
    private readonly handle: DbHandle,
    private readonly analyzer: DeckAnalyzer,
  ) {}

  private toSummary(row: LibraryDeckRow, cardCount: number): LibraryDeckSummary {
    return {
      id: row.id,
      name: row.name,
      source: row.source as "precon" | "user",
      setCode: row.setCode,
      setName: row.setName,
      releaseDate: row.releaseDate,
      commanders: row.commanders,
      bracket: (isBracket(row.bracket) ? row.bracket : 2) as Bracket,
      floor: isBracket(row.bracketFloor) ? row.bracketFloor : null,
      suggested: isBracket(row.bracketSuggested) ? row.bracketSuggested : null,
      tags: row.tags.filter(isArchetypeTag),
      agentEligible: row.agentEligible,
      hasPrimer: row.primer.trim().length > 0,
      cardCount,
      updatedAt: row.updatedAt,
    };
  }

  private countsFor(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.handle.db
      .select({ id: libraryDeckCards.libraryDeckId, quantity: libraryDeckCards.quantity, board: libraryDeckCards.board })
      .from(libraryDeckCards)
      .where(inArray(libraryDeckCards.libraryDeckId, ids))
      .all();
    for (const r of rows) if (r.board !== "sideboard") out.set(r.id, (out.get(r.id) ?? 0) + r.quantity);
    return out;
  }

  list(filters: ListFilters = {}): LibraryDeckSummary[] {
    const where: SQL[] = [];
    if (filters.bracket) where.push(eq(libraryDecks.bracket, filters.bracket));
    if (filters.source) where.push(eq(libraryDecks.source, filters.source));
    if (filters.agentEligible !== undefined) where.push(eq(libraryDecks.agentEligible, filters.agentEligible));
    if (filters.tag) where.push(like(libraryDecks.tags, `%"${filters.tag}"%`));
    if (filters.q) {
      const needle = `%${filters.q.replace(/[%_]/g, "").toLowerCase()}%`;
      where.push(or(like(libraryDecks.name, needle), like(libraryDecks.commanders, needle), like(libraryDecks.setName, needle))!);
    }
    const rows = this.handle.db
      .select()
      .from(libraryDecks)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(libraryDecks.bracket), desc(libraryDecks.releaseDate), asc(libraryDecks.name))
      .all();
    const counts = this.countsFor(rows.map((r) => r.id));
    return rows.map((r) => this.toSummary(r, counts.get(r.id) ?? 0));
  }

  getRow(id: string): LibraryDeckRow | undefined {
    return this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, id)).get();
  }

  bySourceKey(key: string): LibraryDeckRow | undefined {
    return this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, key)).get();
  }

  entries(id: string): Array<LibraryEntry & { position: number }> {
    return this.handle.db
      .select()
      .from(libraryDeckCards)
      .where(eq(libraryDeckCards.libraryDeckId, id))
      .orderBy(asc(libraryDeckCards.position))
      .all()
      .map((r) => ({ cardId: r.cardId, quantity: r.quantity, board: r.board as LibraryEntry["board"], position: r.position }));
  }

  detail(id: string): LibraryDeckDetail | null {
    const row = this.getRow(id);
    if (!row) return null;
    const entries = this.entries(id);
    const ids = [...new Set(entries.map((e) => e.cardId))];
    const cardRows = ids.length ? this.handle.db.select().from(cards).where(inArray(cards.id, ids)).all() : [];
    const byId = new Map(cardRows.map((c) => [c.id, c]));
    const cardsOut = entries.flatMap((e) => {
      const c = byId.get(e.cardId);
      return c ? [{ cardId: e.cardId, name: c.name, quantity: e.quantity, board: e.board, typeLine: c.typeLine, manaCost: c.manaCost }] : [];
    });
    const cardCount = cardsOut.filter((c) => c.board !== "sideboard").reduce((n, c) => n + c.quantity, 0);
    return {
      ...this.toSummary(row, cardCount),
      primer: row.primer,
      analysis: (row.analysis as DeckAnalysis | null) ?? null,
      cards: cardsOut,
      sourceKey: row.sourceKey,
      createdAt: row.createdAt,
    };
  }

  /** Insert a deck and run the analysis (combos through the cache). */
  async create(input: CreateLibraryDeck, opts: { combos?: "cached" | "refresh" | "skip" } = {}): Promise<LibraryDeckDetail> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const analysisCards = this.analyzer.loadCardsByIds(input.entries);
    const commanders = analysisCards.filter((c) => c.board === "commander").map((c) => c.name);
    const result = await this.analyzer.analyze(analysisCards, { combos: opts.combos ?? "cached" });
    const a = result.analysis;
    this.handle.sqlite.transaction(() => {
      this.handle.db
        .insert(libraryDecks)
        .values({
          id,
          name: input.name,
          source: input.source,
          sourceKey: input.sourceKey,
          setCode: input.setCode ?? null,
          setName: input.setName ?? null,
          releaseDate: input.releaseDate ?? null,
          commanders,
          bracket: input.bracket ?? (input.source === "precon" ? 2 : a.suggested),
          bracketFloor: a.floor,
          bracketSuggested: a.suggested,
          tags: a.archetypes.map((t) => t.tag),
          primer: "",
          agentEligible: false,
          analysis: a,
          createdBy: input.createdBy ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      input.entries.forEach((e, position) => {
        this.handle.db.insert(libraryDeckCards).values({ libraryDeckId: id, cardId: e.cardId, quantity: e.quantity, board: e.board, position }).run();
      });
    })();
    return this.detail(id)!;
  }

  /** Re-run the engine (and re-ask Spellbook) for a library deck; keeps the owner's bracket, tags and primer. */
  async reanalyze(id: string, opts: { combos?: "cached" | "refresh" } = {}): Promise<LibraryDeckDetail | null> {
    const row = this.getRow(id);
    if (!row) return null;
    const analysisCards = this.analyzer.loadCardsByIds(this.entries(id));
    const result = await this.analyzer.analyze(analysisCards, { combos: opts.combos ?? "refresh" });
    const a = result.analysis;
    this.handle.db
      .update(libraryDecks)
      .set({ analysis: a, bracketFloor: a.floor, bracketSuggested: a.suggested, commanders: analysisCards.filter((c) => c.board === "commander").map((c) => c.name), updatedAt: new Date().toISOString() })
      .where(eq(libraryDecks.id, id))
      .run();
    return this.detail(id);
  }

  patch(id: string, body: LibraryPatchRequest): { ok: true; deck: LibraryDeckDetail } | { ok: false; error: string } {
    const row = this.getRow(id);
    if (!row) return { ok: false, error: "library deck not found" };
    const set: Partial<typeof libraryDecks.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = String(body.name).replace(/\s+/g, " ").trim().slice(0, 80);
      if (!name) return { ok: false, error: "name cannot be empty" };
      set.name = name;
    }
    if (body.bracket !== undefined) {
      if (!isBracket(body.bracket)) return { ok: false, error: "bracket must be 1-5" };
      set.bracket = body.bracket;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || !body.tags.every(isArchetypeTag)) return { ok: false, error: "unknown tag" };
      set.tags = [...new Set(body.tags)];
    }
    if (body.primer !== undefined) {
      if (typeof body.primer !== "string") return { ok: false, error: "primer must be text" };
      set.primer = body.primer.slice(0, MAX_PRIMER);
    }
    if (body.agentEligible !== undefined) set.agentEligible = Boolean(body.agentEligible);
    if (Object.keys(set).length) {
      set.updatedAt = new Date().toISOString();
      this.handle.db.update(libraryDecks).set(set).where(eq(libraryDecks.id, id)).run();
    }
    return { ok: true, deck: this.detail(id)! };
  }

  remove(id: string): boolean {
    const row = this.getRow(id);
    if (!row) return false;
    this.handle.db.delete(libraryDeckCards).where(eq(libraryDeckCards.libraryDeckId, id)).run();
    this.handle.db.delete(libraryDecks).where(eq(libraryDecks.id, id)).run();
    return true;
  }

  /** Markdown outline from the stored analysis (Phase 7 may replace this with a model draft). */
  primerSkeleton(id: string): string | null {
    const row = this.getRow(id);
    if (!row) return null;
    const analysisCards = this.analyzer.loadCardsByIds(this.entries(id));
    const a = (row.analysis as DeckAnalysis | null) ?? null;
    if (!a) return null;
    return primerSkeleton(row.name, a, analysisCards);
  }
}
