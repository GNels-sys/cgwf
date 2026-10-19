import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { ARCHETYPE_LABELS, BRACKET_NAMES, normalizeName, type Board, type Bracket, type DeckAnalysis, type LibraryImportInfo } from "@cgwf/shared";
import { primerSkeleton, type AnalysisCard } from "../../analysis/index.js";
import type { DeckAnalyzer } from "../../analysis/service.js";
import { config } from "../../config.js";
import type { DbHandle } from "../../db/index.js";
import { cards } from "../../db/schema.js";
import { resolveDecklist } from "../../decks/resolve.js";
import { deckForEngine } from "../../engine/deck.js";
import { deckWarnings } from "../../routes/decks.js";
import type { NameIndex } from "../../search/index.js";
import type { LibraryEntry, LibraryService } from "../service.js";
import type { EdhrecClient } from "./client.js";
import type { CoverageChecker } from "./coverage.js";
import { IDENTITIES, identityInfo } from "./identity.js";
import { averageDeckText, parseAverageDeck, parseCommanderPage, parseList, totalCards, type AverageDeck } from "./parse.js";
import { diversitySummary, EDHREC_BRACKET_LABELS, EDHREC_BRACKET_NAMES, groupLabel, selectBracket, type Candidate, type EdhrecBracket, type Evaluation, type SelectionResult, type SelectionRules } from "./select.js";
import { classifyWinCondition, primaryArchetype, WIN_CONDITION_LABELS, type WinCondition } from "./wincon.js";
import { inArray } from "drizzle-orm";

/**
 * EDHREC average decks into the deck library: 75 Bracket 3 ("upgraded"), 75 Bracket 4
 * ("optimized"), 25 Bracket 5 ("cedh"), varied in colour identity, archetype and win condition.
 *
 *   1. Pool: EDHREC's week / month / year top 100 plus the top `listDepth` of each of the 32
 *      colour-identity lists; one commander page each for `bracket_counts`.
 *   2. Per bracket, `selectBracket` ranks by that bracket's deck count and applies the diversity
 *      rules; a candidate is evaluated only when it could be taken: fetch its average deck for the
 *      bracket, resolve every card through the deck resolver, check it is a legal 100-card Commander
 *      deck, analyse it (archetypes, combos, bracket floor) and classify its win condition.
 *   3. Import (idempotent by `edhrec:<slug>:<bracket>`), primer skeleton from the engine, then ask
 *      the rules engine whether Forge knows every card; only clean decks become agent-eligible.
 *   4. Report (Markdown) under DATA_DIR/reports/.
 * The averages are SYNTHESISED by EDHREC (the most common card per slot across every deck it has
 * indexed), not one pilot's list; the names and the library pages say so.
 */
export interface EdhrecImportOptions {
  /** Ignore the on-disk cache and fetch everything again. */
  refresh?: boolean;
  /** Select and write the report, import nothing. */
  dryRun?: boolean;
  /** Only re-run the Forge coverage check on EDHREC decks already in the library. */
  recheckCoverage?: boolean;
  /** Per-bracket targets (defaults 75 / 75 / 25). */
  targets?: Partial<Record<EdhrecBracket, number>>;
  /** Commanders taken from each colour-identity list (default 20). */
  listDepth?: number;
}

export interface EdhrecImportState {
  running: boolean;
  phase: "idle" | "pool" | "pages" | "select" | "import" | "coverage" | "done" | "error";
  message: string;
  requests: number;
  cacheHits: number;
  selected: Record<EdhrecBracket, number>;
  imported: number;
  updated: number;
  agentEligible: number;
  error: string | null;
  reportPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Evaluated {
  candidate: Candidate;
  bracket: EdhrecBracket;
  deck: AverageDeck;
  entries: LibraryEntry[];
  analysisCards: AnalysisCard[];
  analysis: DeckAnalysis;
  winCondition: WinCondition;
}

export const DEFAULT_RULES: Record<EdhrecBracket, Omit<SelectionRules, "overlapWith" | "overlapCap">> = {
  3: { bracket: 3, target: 75, identityCap: 4, archetypeCap: 12, minArchetypes: 10, minDecks: 20, coverage: "identity", winConMin: 3 },
  4: { bracket: 4, target: 75, identityCap: 4, archetypeCap: 12, minArchetypes: 10, minDecks: 20, coverage: "identity", winConMin: 3 },
  5: { bracket: 5, target: 25, identityCap: 3, archetypeCap: 12, minArchetypes: 10, minDecks: 50, coverage: "group", winConMin: 1 },
};

export function edhrecSourceKey(slug: string, bracket: EdhrecBracket): string {
  return `edhrec:${slug}:${EDHREC_BRACKET_NAMES[bracket]}`;
}
export function edhrecDeckUrl(slug: string, bracket: EdhrecBracket): string {
  return `https://edhrec.com/average-decks/${slug}/${EDHREC_BRACKET_NAMES[bracket]}`;
}
export function edhrecDeckName(commanders: string[], bracket: EdhrecBracket): string {
  return `${commanders.join(" / ")} — ${EDHREC_BRACKET_LABELS[bracket]} (EDHREC average)`;
}

/** The classifier's view of EDHREC's bracket, in words; null when they agree. */
export function bracketMismatch(bracket: EdhrecBracket, a: DeckAnalysis): string | null {
  if (a.floor > bracket) {
    const why = a.reasons.filter((r) => r.bracket > bracket).map((r) => r.text);
    return `the bracket rules put it at Bracket ${a.floor} or higher (EDHREC says ${bracket}): ${why.join(" ")}`;
  }
  if (a.suggested < bracket - 1) return `plays softer than Bracket ${bracket}: the classifier suggests Bracket ${a.suggested} (${BRACKET_NAMES[a.suggested]})`;
  return null;
}

export class EdhrecImporter {
  readonly state: EdhrecImportState = this.freshState();
  private readonly evaluated = new Map<string, Evaluated>();

  constructor(
    private readonly handle: DbHandle,
    private readonly index: NameIndex,
    private readonly library: LibraryService,
    private readonly analyzer: DeckAnalyzer,
    private readonly client: EdhrecClient,
    private readonly coverage: CoverageChecker | null,
    private readonly log: FastifyBaseLogger | null,
  ) {}

  private freshState(): EdhrecImportState {
    return { running: false, phase: "idle", message: "", requests: 0, cacheHits: 0, selected: { 3: 0, 4: 0, 5: 0 }, imported: 0, updated: 0, agentEligible: 0, error: null, reportPath: null, startedAt: null, finishedAt: null };
  }

  private set(phase: EdhrecImportState["phase"], message: string): void {
    this.state.phase = phase;
    this.state.message = message;
    this.state.requests = this.client.requests;
    this.state.cacheHits = this.client.cacheHits;
    this.log?.info({ phase, message }, "edhrec import");
  }

  async run(opts: EdhrecImportOptions = {}): Promise<void> {
    if (this.state.running) return;
    Object.assign(this.state, this.freshState(), { running: true, startedAt: new Date().toISOString() });
    this.evaluated.clear();
    try {
      const report = opts.recheckCoverage ? await this.recheck() : await this.fullRun(opts);
      this.state.reportPath = this.writeReport(report);
      this.set("done", `done: ${this.state.imported} new, ${this.state.updated} updated, ${this.state.agentEligible} agent-eligible`);
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
      this.set("error", this.state.error);
      this.log?.error({ err }, "edhrec import failed");
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      this.state.requests = this.client.requests;
      this.state.cacheHits = this.client.cacheHits;
    }
  }

  // ------------------------------------------------------------ pool

  async candidatePool(opts: EdhrecImportOptions = {}): Promise<{ candidates: Candidate[]; poolSize: number; skipped: string[] }> {
    const refresh = Boolean(opts.refresh);
    const depth = opts.listDepth ?? 20;
    this.set("pool", "reading EDHREC's top commander lists");
    const slugs = new Map<string, string>();
    for (const tf of ["week", "month", "year"]) for (const e of parseList(await this.client.get(`commanders/${tf}`, { refresh }))) slugs.set(e.slug, e.name);
    for (const id of IDENTITIES) for (const e of parseList(await this.client.get(`commanders/${id.slug}`, { refresh })).slice(0, depth)) slugs.set(e.slug, e.name);
    const candidates: Candidate[] = [];
    const skipped: string[] = [];
    let n = 0;
    for (const [slug, name] of slugs) {
      n++;
      if (n % 25 === 0) this.set("pages", `commander pages ${n}/${slugs.size}`);
      const page = parseCommanderPage(slug, await this.client.get(`commanders/${slug}`, { refresh }));
      if (!page) {
        skipped.push(`${name} (${slug}): EDHREC has no commander page`);
        continue;
      }
      candidates.push({ slug, name: page.name || name, identity: page.identity, bracketCounts: page.bracketCounts });
    }
    return { candidates, poolSize: slugs.size, skipped };
  }

  // ------------------------------------------------------------ evaluation

  /** Fetch, resolve, check and analyse one commander's average deck for one bracket. */
  async evaluate(c: Candidate, bracket: EdhrecBracket, refresh = false): Promise<Evaluation> {
    const deck = parseAverageDeck(c.slug, await this.client.get(`average-decks/${c.slug}/${EDHREC_BRACKET_NAMES[bracket]}`, { refresh }));
    if (!deck) return { ok: false, reason: `EDHREC has no ${EDHREC_BRACKET_NAMES[bracket]} average deck` };
    if (totalCards(deck) !== 100) return { ok: false, reason: `the average deck has ${totalCards(deck)} cards, not 100` };
    const resolved = this.resolve(deck);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const rowIds = [...new Set(resolved.entries.map((e) => e.cardId))];
    const rows = this.handle.db.select().from(cards).where(inArray(cards.id, rowIds)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const warnings = deckWarnings(resolved.entries.map((e) => ({ row: byId.get(e.cardId)!, quantity: e.quantity, board: e.board as Board })));
    if (warnings.length) return { ok: false, reason: `not a legal Commander deck as averaged: ${warnings.map((w) => w.message).join(" ")}` };
    const analysisCards = this.analyzer.loadCardsByIds(resolved.entries);
    const analysis = (await this.analyzer.analyze(analysisCards, { combos: "cached" })).analysis;
    const winCondition = classifyWinCondition(analysis, analysisCards);
    this.evaluated.set(edhrecSourceKey(c.slug, bracket), { candidate: c, bracket, deck, entries: resolved.entries, analysisCards, analysis, winCondition });
    return { ok: true, primary: primaryArchetype(analysis), winCondition };
  }

  /**
   * The average deck's names through the existing resolver (exact names only: a fuzzy guess is
   * refused). A name the resolver cannot place falls back to the Scryfall id EDHREC lists for it.
   */
  resolve(deck: AverageDeck): { ok: true; entries: LibraryEntry[] } | { ok: false; reason: string } {
    const result = resolveDecklist({ handle: this.handle, index: this.index }, averageDeckText(deck));
    const byScryfall = new Map<string, string>();
    if (deck.scryfallIds.length) {
      const rows = this.handle.db.select({ id: cards.id, normalizedName: cards.normalizedName }).from(cards).where(inArray(cards.id, deck.scryfallIds.map((s) => s.id))).all();
      for (const r of rows) {
        byScryfall.set(r.normalizedName, r.id);
        const front = r.normalizedName.split(" // ")[0];
        if (front) byScryfall.set(front, r.id);
      }
    }
    const entries: LibraryEntry[] = [];
    const missing: string[] = [];
    for (const line of result.lines) {
      const board = line.line.board === "commander" ? "commander" : "main";
      let id = line.status === "resolved" ? (line.card?.id ?? null) : null;
      if (!id) id = byScryfall.get(normalizeName(line.line.name)) ?? null;
      if (!id) {
        missing.push(line.line.name);
        continue;
      }
      const prev = entries.find((e) => e.cardId === id && e.board === board);
      if (prev) prev.quantity += line.line.quantity;
      else entries.push({ cardId: id, quantity: line.line.quantity, board });
    }
    if (missing.length) return { ok: false, reason: `cards not in our card data: ${missing.join(", ")}` };
    const commanders = entries.filter((e) => e.board === "commander").length;
    if (commanders !== deck.commanders.length) return { ok: false, reason: `expected ${deck.commanders.length} commander(s), resolved ${commanders}` };
    return { ok: true, entries };
  }

  // ------------------------------------------------------------ runs

  private async fullRun(opts: EdhrecImportOptions): Promise<Report> {
    const pool = await this.candidatePool(opts);
    const results: SelectionResult[] = [];
    const chosen = new Map<EdhrecBracket, Set<string>>();
    for (const b of [3, 4, 5] as EdhrecBracket[]) {
      const rules: SelectionRules = { ...DEFAULT_RULES[b], target: opts.targets?.[b] ?? DEFAULT_RULES[b].target };
      if (b === 4) Object.assign(rules, { overlapWith: chosen.get(3) ?? new Set<string>(), overlapCap: Math.floor(rules.target / 3) });
      this.set("select", `choosing Bracket ${b} (${EDHREC_BRACKET_NAMES[b]})`);
      const r = await selectBracket(pool.candidates, rules, (c) => this.evaluate(c, b, Boolean(opts.refresh)));
      results.push(r);
      chosen.set(b, new Set(r.picks.map((p) => p.slug)));
      this.state.selected[b] = r.picks.length;
    }
    const overlap = [...(chosen.get(3) ?? [])].filter((s) => chosen.get(4)?.has(s)).length;
    const imported: ImportedDeck[] = [];
    if (!opts.dryRun) {
      this.set("import", "writing library decks");
      for (const r of results) {
        for (const p of r.picks) {
          const key = edhrecSourceKey(p.slug, r.bracket);
          const ev = this.evaluated.get(key)!;
          const name = edhrecDeckName(ev.deck.commanders, r.bracket);
          const mismatch = bracketMismatch(r.bracket, ev.analysis);
          const meta: LibraryImportInfo = {
            provider: "edhrec",
            slug: p.slug,
            edhrecBracket: EDHREC_BRACKET_NAMES[r.bracket],
            decks: p.decks,
            rank: p.rank,
            winCondition: WIN_CONDITION_LABELS[p.winCondition],
            fetchedAt: new Date().toISOString(),
            pickReason: p.reason,
            mismatch,
            coverage: null,
            coverageError: null,
          };
          const primer = primerSkeleton(name, ev.analysis, ev.analysisCards);
          const { id, created } = this.library.upsertImported({
            sourceKey: key,
            source: "edhrec",
            name,
            bracket: r.bracket as Bracket,
            sourceUrl: edhrecDeckUrl(p.slug, r.bracket),
            entries: ev.entries,
            analysis: ev.analysis,
            commanders: ev.deck.commanders,
            primer,
            importMeta: meta,
          });
          if (created) this.state.imported++;
          else this.state.updated++;
          imported.push({ id, key, name, bracket: r.bracket, mismatch, created });
        }
      }
    }
    const coverage = opts.dryRun ? [] : await this.checkCoverage(imported.map((d) => ({ id: d.id, name: d.name })));
    const stale = opts.dryRun ? [] : this.staleImports(new Set(imported.map((d) => d.key)));
    return { kind: opts.dryRun ? "dry-run" : "import", pool, results, overlap, imported, coverage, stale, fetched: { requests: this.client.requests, cacheHits: this.client.cacheHits } };
  }

  private async recheck(): Promise<Report> {
    const rows = this.library.list({ source: "edhrec" });
    const coverage = await this.checkCoverage(rows.map((r) => ({ id: r.id, name: r.name })));
    return { kind: "recheck", pool: { candidates: [], poolSize: 0, skipped: [] }, results: [], overlap: 0, imported: [], coverage, stale: [], fetched: { requests: 0, cacheHits: 0 } };
  }

  /** Forge coverage through the engine, then agent eligibility. */
  private async checkCoverage(decks: Array<{ id: string; name: string }>): Promise<CoverageLine[]> {
    this.set("coverage", `checking ${decks.length} decks against the rules engine`);
    const out: CoverageLine[] = [];
    const specs = decks.flatMap((d) => {
      const conv = deckForEngine(this.handle, "edhrec-import", `library:${d.id}`);
      return conv ? [{ key: d.id, deck: conv.deck, problems: conv.problems, name: d.name }] : [];
    });
    const results = this.coverage ? await this.coverage.check(specs.map((s) => ({ key: s.key, deck: s.deck }))) : new Map<string, { missing: string[] | null; error?: string }>();
    for (const s of specs) {
      const r = results.get(s.key) ?? { missing: null, error: "no rules engine configured (ENGINE_URL)" };
      // Engine tables block decks with Commander warnings, so a deck with problems is never eligible.
      this.library.setCoverage(s.key, r, s.problems.length === 0);
      const eligible = Boolean(r.missing && r.missing.length === 0 && s.problems.length === 0);
      if (eligible) this.state.agentEligible++;
      out.push({ id: s.key, name: s.name, missing: r.missing, error: r.error ?? (s.problems.length ? s.problems.join(" ") : null), eligible });
    }
    return out;
  }

  /** EDHREC decks from earlier runs that this run did not select (kept; listed in the report). */
  private staleImports(current: Set<string>): string[] {
    return this.library
      .list({ source: "edhrec" })
      .flatMap((d) => {
        const key = this.library.getRow(d.id)?.sourceKey ?? "";
        return current.has(key) ? [] : [d.name];
      });
  }

  // ------------------------------------------------------------ report

  private writeReport(r: Report): string {
    const dir = path.join(config.dataDir, "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `edhrec-import-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    fs.writeFileSync(file, renderReport(r));
    return file;
  }
}

interface ImportedDeck {
  id: string;
  key: string;
  name: string;
  bracket: EdhrecBracket;
  mismatch: string | null;
  created: boolean;
}

interface CoverageLine {
  id: string;
  name: string;
  missing: string[] | null;
  error: string | null;
  eligible: boolean;
}

export interface Report {
  kind: "import" | "dry-run" | "recheck";
  pool: { candidates: Candidate[]; poolSize: number; skipped: string[] };
  results: SelectionResult[];
  overlap: number;
  imported: ImportedDeck[];
  coverage: CoverageLine[];
  stale: string[];
  fetched: { requests: number; cacheHits: number };
}

export function renderReport(r: Report): string {
  const lines: string[] = [];
  lines.push(`# EDHREC deck library import (${r.kind}, ${new Date().toISOString()})`);
  lines.push("");
  lines.push("Average deck data from EDHREC (https://edhrec.com). Every deck is EDHREC's synthesised average for the commander at that bracket (the most common card per slot across indexed decks), not one player's list.");
  lines.push("");
  if (r.kind !== "recheck") {
    lines.push(`Candidate pool: ${r.pool.poolSize} commanders (week/month/year top 100 + top of each colour identity), ${r.pool.candidates.length} with a commander page. Requests: ${r.fetched.requests} new, ${r.fetched.cacheHits} from cache.`);
    for (const s of r.pool.skipped) lines.push(`- skipped: ${s}`);
    lines.push(`Bracket 3 / Bracket 4 commander overlap: ${r.overlap}.`);
    lines.push("");
  }
  for (const s of r.results) {
    const div = diversitySummary(s.picks);
    lines.push(`## Bracket ${s.bracket} (EDHREC "${EDHREC_BRACKET_NAMES[s.bracket]}"): ${s.picks.length} picked from ${s.poolSize} ranked candidates`);
    lines.push("");
    lines.push(`- Colour groups: ${fmt(div.groups)}`);
    lines.push(`- Identities (${Object.keys(div.identities).length} of 32): ${fmt(div.identities)}`);
    lines.push(`- Primary archetypes (${Object.keys(div.archetypes).filter((k) => k !== "none").length}): ${fmt(Object.fromEntries(Object.entries(div.archetypes).map(([k, v]) => [k === "none" ? "none" : (ARCHETYPE_LABELS[k as keyof typeof ARCHETYPE_LABELS] ?? k), v])))}`);
    lines.push(`- Win conditions: ${fmt(Object.fromEntries(Object.entries(div.winConditions).map(([k, v]) => [WIN_CONDITION_LABELS[k as WinCondition] ?? k, v])))}`);
    for (const u of s.unmet) lines.push(`- Not met: ${u}`);
    lines.push("");
    lines.push("| # | Commander | Identity | Decks | Archetype | Win | Pass | Why |");
    lines.push("|---|---|---|---|---|---|---|---|");
    s.picks.forEach((p, i) => lines.push(`| ${i + 1} | ${p.name} | ${identityInfo(p.identity).label} | ${p.decks} | ${p.primary ? ARCHETYPE_LABELS[p.primary] : "none"} | ${WIN_CONDITION_LABELS[p.winCondition]} | ${p.pass} | ${p.reason} |`));
    if (s.rejected.length) {
      lines.push("");
      lines.push(`Rejected while choosing (${s.rejected.length}):`);
      for (const x of s.rejected) lines.push(`- ${x.name}: ${x.reason}`);
    }
    lines.push("");
  }
  const mism = r.imported.filter((d) => d.mismatch);
  if (r.kind === "import") {
    lines.push(`## Bracket mismatches (${mism.length}; EDHREC's bracket kept, flagged on the library page)`);
    lines.push("");
    for (const d of mism) lines.push(`- ${d.name}: ${d.mismatch}`);
    if (!mism.length) lines.push("- none");
    lines.push("");
  }
  if (r.coverage.length) {
    const notEligible = r.coverage.filter((c) => !c.eligible);
    lines.push(`## Rules-engine coverage: ${r.coverage.filter((c) => c.eligible).length} of ${r.coverage.length} agent-eligible`);
    lines.push("");
    for (const c of notEligible) {
      if (c.missing && c.missing.length) lines.push(`- ${c.name}: Forge cannot play ${c.missing.join(", ")} (kept for humans, not agent-eligible)`);
      else lines.push(`- ${c.name}: not checked (${c.error ?? "unknown"}); not agent-eligible until \`cli import-edhrec --recheck-coverage\``);
    }
    if (!notEligible.length) lines.push("- every imported deck is playable by the rules engine");
    lines.push("");
  }
  if (r.stale.length) {
    lines.push(`## Earlier EDHREC imports not in this selection (${r.stale.length}, kept)`);
    lines.push("");
    for (const s of r.stale) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push(`Groups: ${["mono", "two", "three", "four", "five", "colorless"].map((g) => groupLabel(g as Parameters<typeof groupLabel>[0])).join(", ")}.`);
  return lines.join("\n") + "\n";
}

function fmt(o: Record<string, number>): string {
  return Object.entries(o)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}

