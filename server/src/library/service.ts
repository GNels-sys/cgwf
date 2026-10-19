import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import {
  isArchetypeTag,
  isBracket,
  isLibrarySource,
  type ArchetypeTag,
  type Bracket,
  type DeckAnalysis,
  type LibraryDeckDetail,
  type LibraryDeckSummary,
  type LibraryEngineCheck,
  type LibraryImportInfo,
  type LibraryPatchRequest,
  type LibrarySource,
} from "@cgwf/shared";
import type { DeckAnalyzer } from "../analysis/service.js";
import { primerSkeleton } from "../analysis/index.js";
import type { DbHandle } from "../db/index.js";
import { cards, libraryDeckCards, libraryDecks, users, type LibraryDeckRow } from "../db/schema.js";
import { checkPrintingSwap } from "../decks/printing.js";
import { decideEligibility, type EligibilityDecision } from "./eligibility.js";

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
  source: LibrarySource;
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
  source?: LibrarySource | undefined;
  agentEligible?: boolean | undefined;
}

const MAX_PRIMER = 40_000;

export class LibraryService {
  constructor(
    private readonly handle: DbHandle,
    private readonly analyzer: DeckAnalyzer,
  ) {}

  private toSummary(row: LibraryDeckRow, cardCount: number, createdByName: string | null = null): LibraryDeckSummary {
    return {
      createdBy: row.createdBy,
      createdByName,
      id: row.id,
      name: row.name,
      source: isLibrarySource(row.source) ? row.source : "user",
      sourceUrl: row.sourceUrl ?? null,
      importInfo: row.source === "edhrec" ? ((row.importMeta as LibraryImportInfo | null) ?? null) : null,
      engineCheck: engineCheckOf(row.importMeta as Record<string, unknown> | null),
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
    const names = this.namesFor(rows.map((r) => r.createdBy));
    return rows.map((r) => this.toSummary(r, counts.get(r.id) ?? 0, r.createdBy ? (names.get(r.createdBy) ?? null) : null));
  }

  /** Display names of the players credited with user decks (Phase 8 submissions). */
  private namesFor(ids: Array<string | null>): Map<string, string> {
    const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
    if (unique.length === 0) return new Map();
    return new Map(this.handle.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, unique)).all().map((u) => [u.id, u.name]));
  }

  getRow(id: string): LibraryDeckRow | undefined {
    return this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, id)).get();
  }

  bySourceKey(key: string): LibraryDeckRow | undefined {
    return this.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, key)).get();
  }

  entries(id: string): Array<LibraryEntry & { position: number; entryId: number }> {
    return this.handle.db
      .select()
      .from(libraryDeckCards)
      .where(eq(libraryDeckCards.libraryDeckId, id))
      .orderBy(asc(libraryDeckCards.position))
      .all()
      .map((r) => ({ entryId: r.id, cardId: r.cardId, quantity: r.quantity, board: r.board as LibraryEntry["board"], position: r.position }));
  }

  /**
   * Swap the printing of one library line (owner's printing picker). Same card only; bumps updatedAt so
   * the Stats and shop panels refresh. Analysis, tags and the primer stay: the card itself is unchanged.
   */
  setPrinting(id: string, entryId: number, cardId: unknown): { ok: true; deck: LibraryDeckDetail } | { ok: false; status: number; error: string } {
    const row = this.getRow(id);
    if (!row) return { ok: false, status: 404, error: "library deck not found" };
    const line = Number.isInteger(entryId)
      ? this.handle.db.select().from(libraryDeckCards).where(and(eq(libraryDeckCards.id, entryId), eq(libraryDeckCards.libraryDeckId, id))).get()
      : undefined;
    const current = line ? this.handle.db.select().from(cards).where(eq(cards.id, line.cardId)).get() : undefined;
    const check = checkPrintingSwap(this.handle, current, cardId);
    if (!check.ok) return check;
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(libraryDeckCards).set({ cardId: check.row.id }).where(eq(libraryDeckCards.id, line!.id)).run();
      this.handle.db.update(libraryDecks).set({ updatedAt: new Date().toISOString() }).where(eq(libraryDecks.id, id)).run();
    })();
    return { ok: true, deck: this.detail(id)! };
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
      return c
        ? [{ cardId: e.cardId, name: c.name, quantity: e.quantity, board: e.board, typeLine: c.typeLine, manaCost: c.manaCost, entryId: e.entryId, oracleId: c.oracleId, set: c.set, collectorNumber: c.collectorNumber, faceCount: c.imageBack ? 2 : 1 }]
        : [];
    });
    const cardCount = cardsOut.filter((c) => c.board !== "sideboard").reduce((n, c) => n + c.quantity, 0);
    return {
      ...this.toSummary(row, cardCount, row.createdBy ? (this.namesFor([row.createdBy]).get(row.createdBy) ?? null) : null),
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

  /**
   * Insert or update an imported deck by its source key (EDHREC importer). An update replaces the
   * card list, analysis, tags, commanders and import details; it keeps the owner's primer unless the
   * stored one is still the importer's own skeleton, and never turns agent eligibility on (the caller
   * sets it after the Forge coverage check).
   */
  upsertImported(input: {
    sourceKey: string;
    source: LibrarySource;
    name: string;
    bracket: Bracket;
    sourceUrl: string;
    entries: LibraryEntry[];
    analysis: DeckAnalysis;
    commanders: string[];
    primer: string;
    importMeta: LibraryImportInfo;
  }): { id: string; created: boolean } {
    const now = new Date().toISOString();
    const a = input.analysis;
    const existing = this.bySourceKey(input.sourceKey);
    const id = existing?.id ?? randomUUID();
    const oldMeta = (existing?.importMeta as (LibraryImportInfo & { autoPrimer?: string }) | null) ?? null;
    const keepPrimer = existing && existing.primer.trim() !== "" && existing.primer !== oldMeta?.autoPrimer;
    const meta = { ...input.importMeta, autoPrimer: input.primer };
    this.handle.sqlite.transaction(() => {
      if (existing) {
        this.handle.db
          .update(libraryDecks)
          .set({
            name: input.name,
            source: input.source,
            sourceUrl: input.sourceUrl,
            commanders: input.commanders,
            bracket: input.bracket,
            bracketFloor: a.floor,
            bracketSuggested: a.suggested,
            tags: a.archetypes.map((t) => t.tag),
            primer: keepPrimer ? existing.primer : input.primer,
            analysis: a,
            importMeta: meta,
            updatedAt: now,
          })
          .where(eq(libraryDecks.id, id))
          .run();
        this.handle.db.delete(libraryDeckCards).where(eq(libraryDeckCards.libraryDeckId, id)).run();
      } else {
        this.handle.db
          .insert(libraryDecks)
          .values({
            id,
            name: input.name,
            source: input.source,
            sourceKey: input.sourceKey,
            sourceUrl: input.sourceUrl,
            commanders: input.commanders,
            bracket: input.bracket,
            bracketFloor: a.floor,
            bracketSuggested: a.suggested,
            tags: a.archetypes.map((t) => t.tag),
            primer: input.primer,
            agentEligible: false,
            analysis: a,
            importMeta: meta,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      input.entries.forEach((e, position) => {
        this.handle.db.insert(libraryDeckCards).values({ libraryDeckId: id, cardId: e.cardId, quantity: e.quantity, board: e.board, position }).run();
      });
    })();
    return { id, created: !existing };
  }

  /**
   * Record a Forge coverage result (+ engine-table legality problems) in import_meta and update agent
   * eligibility with `decideEligibility` (eligibility.ts): the owner's own choice is never overridden.
   */
  recordCoverage(
    id: string,
    coverage: { missing: string[] | null; error?: string | undefined },
    problems: string[],
    opts: { enable: boolean },
  ): EligibilityDecision | null {
    const row = this.getRow(id);
    if (!row) return null;
    const meta = { ...((row.importMeta as Record<string, unknown> | null) ?? {}) };
    if (coverage.missing) {
      meta.coverage = { checkedAt: new Date().toISOString(), missing: coverage.missing };
      meta.coverageError = null;
    } else {
      meta.coverageError = coverage.error ?? "not checked";
    }
    meta.problems = problems;
    const clean = coverage.missing ? coverage.missing.length === 0 && problems.length === 0 : null;
    const by = meta.eligibleBy === "owner" || meta.eligibleBy === "coverage" ? meta.eligibleBy : null;
    const d = decideEligibility({ current: row.agentEligible, eligibleBy: by, source: row.source, clean, enable: opts.enable });
    meta.eligibleBy = d.eligibleBy;
    this.handle.db.update(libraryDecks).set({ importMeta: meta, agentEligible: d.eligible, updatedAt: new Date().toISOString() }).where(eq(libraryDecks.id, id)).run();
    return d;
  }

  /** EDHREC import's coverage step (clean decks switch on; never against the owner's choice). */
  setCoverage(id: string, coverage: { missing: string[] | null; error?: string | undefined }, eligibleWhenClean: boolean): void {
    this.recordCoverage(id, coverage, eligibleWhenClean ? [] : ["not legal for engine tables"], { enable: true });
  }

  /** Whole library per bracket: bot-eligible vs total (Library page header, bot box). */
  bracketCounts(): Record<Bracket, { eligible: number; total: number }> {
    const out = { 1: { eligible: 0, total: 0 }, 2: { eligible: 0, total: 0 }, 3: { eligible: 0, total: 0 }, 4: { eligible: 0, total: 0 }, 5: { eligible: 0, total: 0 } } as Record<Bracket, { eligible: number; total: number }>;
    const rows = this.handle.db.select({ bracket: libraryDecks.bracket, eligible: libraryDecks.agentEligible }).from(libraryDecks).all();
    for (const r of rows) {
      if (!isBracket(r.bracket)) continue;
      out[r.bracket as Bracket].total++;
      if (r.eligible) out[r.bracket as Bracket].eligible++;
    }
    return out;
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
    if (body.agentEligible !== undefined) {
      // The owner's own choice: coverage checks never switch it back (eligibility.ts).
      set.agentEligible = Boolean(body.agentEligible);
      set.importMeta = { ...((row.importMeta as Record<string, unknown> | null) ?? {}), eligibleBy: "owner" };
    }
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

/** The rules-engine check recorded in import_meta, for any source. */
export function engineCheckOf(meta: Record<string, unknown> | null): LibraryEngineCheck | null {
  if (!meta || (meta.coverage === undefined && meta.coverageError === undefined && meta.eligibleBy === undefined)) return null;
  const cov = meta.coverage as { checkedAt?: string; missing?: string[] } | null | undefined;
  return {
    checkedAt: cov?.checkedAt ?? null,
    missing: cov?.missing ?? null,
    problems: Array.isArray(meta.problems) ? (meta.problems as string[]) : [],
    error: typeof meta.coverageError === "string" ? meta.coverageError : null,
    eligibleBy: meta.eligibleBy === "owner" || meta.eligibleBy === "coverage" ? meta.eligibleBy : null,
  };
}
