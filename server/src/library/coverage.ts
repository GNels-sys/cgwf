import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Bracket, LibraryCoverageState, LibrarySource } from "@cgwf/shared";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { deckForEngine } from "../engine/deck.js";
import type { CoverageChecker, CoverageResult } from "./edhrec/coverage.js";
import type { EligibilityDecision } from "./eligibility.js";
import type { LibraryService } from "./service.js";

/**
 * Library-wide rules-engine check (2026-10-19), for any source: precons, EDHREC averages, player decks.
 * Each deck is converted exactly as an engine table converts it (`deckForEngine`: same boards, same
 * legality checks, which block a game) and sent to Forge in check games (`CoverageChecker`, four decks
 * per `deckcheck-<uuid>` game, see edhrec/coverage.ts). The result goes into `import_meta` and agent
 * eligibility follows `decideEligibility` (eligibility.ts): with `enable`, clean decks switch on; a deck
 * the owner switched on or off by hand is never changed. Driven by `cli check-library-coverage` (loopback
 * route) or the owner route; precon imports run it for the decks they add.
 */

export interface LibraryCoverageOptions {
  source?: LibrarySource | undefined;
  /** Only these library deck ids (the precon import passes the decks it just added). */
  ids?: string[] | undefined;
  /** Switch clean decks on. Without it the run only records and reports. */
  enable?: boolean | undefined;
}

export interface CoverageReportLine {
  id: string;
  name: string;
  source: string;
  bracket: Bracket;
  missing: string[] | null;
  problems: string[];
  error: string | null;
  outcome: EligibilityDecision["outcome"];
  eligible: boolean;
}

export interface CoverageReport {
  options: LibraryCoverageOptions;
  lines: CoverageReportLine[];
  before: Record<Bracket, { eligible: number; total: number }>;
  after: Record<Bracket, { eligible: number; total: number }>;
}

export class LibraryCoverage {
  readonly state: LibraryCoverageState = LibraryCoverage.fresh();

  constructor(
    private readonly handle: DbHandle,
    private readonly library: LibraryService,
    private readonly checker: CoverageChecker | null,
    private readonly log: FastifyBaseLogger | null = null,
  ) {}

  private static fresh(): LibraryCoverageState {
    return { running: false, phase: "idle", message: "", total: 0, checked: 0, enabled: 0, keptByOwner: 0, excluded: 0, unchecked: 0, error: null, reportPath: null, startedAt: null, finishedAt: null };
  }

  /** Run in the background (routes); `check` is the awaited version. */
  start(opts: LibraryCoverageOptions): boolean {
    if (this.state.running) return false;
    void this.check(opts).catch(() => undefined);
    return true;
  }

  async check(opts: LibraryCoverageOptions): Promise<CoverageReport | null> {
    if (this.state.running) return null;
    Object.assign(this.state, LibraryCoverage.fresh(), { running: true, phase: "checking", startedAt: new Date().toISOString() });
    try {
      const before = this.library.bracketCounts();
      let decks = this.library.list(opts.source ? { source: opts.source } : {});
      if (opts.ids) {
        const want = new Set(opts.ids);
        decks = decks.filter((d) => want.has(d.id));
      }
      this.state.total = decks.length;
      this.state.message = `checking ${decks.length} decks against the rules engine`;
      const lines: CoverageReportLine[] = [];
      // Groups of 20 decks (five check games) so progress shows and memory stays flat.
      for (let i = 0; i < decks.length; i += 20) {
        const group = decks.slice(i, i + 20);
        const specs = group.flatMap((d) => {
          const conv = deckForEngine(this.handle, "library-coverage", `library:${d.id}`);
          return conv ? [{ d, deck: conv.deck, problems: conv.problems }] : [];
        });
        const results: Map<string, CoverageResult> = this.checker
          ? await this.checker.check(specs.map((s) => ({ key: s.d.id, deck: s.deck })))
          : new Map(specs.map((s) => [s.d.id, { missing: null, error: "no rules engine configured (ENGINE_URL)" }]));
        for (const s of specs) {
          const r = results.get(s.d.id) ?? { missing: null, error: "no answer from the rules engine" };
          const decision = this.library.recordCoverage(s.d.id, r, s.problems, { enable: Boolean(opts.enable) });
          const outcome = decision?.outcome ?? "unchanged";
          const line: CoverageReportLine = {
            id: s.d.id,
            name: s.d.name,
            source: s.d.source,
            bracket: s.d.bracket,
            missing: r.missing,
            problems: s.problems,
            error: r.error ?? null,
            outcome,
            eligible: decision?.eligible ?? s.d.agentEligible,
          };
          lines.push(line);
          this.state.checked++;
          if (outcome === "enabled") this.state.enabled++;
          if (outcome === "kept-by-owner") this.state.keptByOwner++;
          if (r.missing === null) this.state.unchecked++;
          else if (r.missing.length > 0 || s.problems.length > 0) this.state.excluded++;
        }
        this.state.message = `checked ${this.state.checked}/${this.state.total}: ${this.state.enabled} switched on, ${this.state.excluded} excluded`;
      }
      const report: CoverageReport = { options: opts, lines, before, after: this.library.bracketCounts() };
      this.state.reportPath = this.writeReport(report);
      this.state.phase = "done";
      this.state.message = `done: ${this.state.checked} checked, ${this.state.enabled} switched on, ${this.state.excluded} excluded, ${this.state.keptByOwner} kept on by the owner, ${this.state.unchecked} not checked`;
      this.log?.info({ ...this.state }, "library coverage check finished");
      return report;
    } catch (err) {
      this.state.phase = "error";
      this.state.error = err instanceof Error ? err.message : String(err);
      this.log?.error({ err }, "library coverage check failed");
      return null;
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
    }
  }

  private writeReport(r: CoverageReport): string | null {
    try {
      const dir = path.join(config.dataDir, "reports");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `library-coverage-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
      fs.writeFileSync(file, renderCoverageReport(r));
      return file;
    } catch (err) {
      this.log?.warn({ err }, "could not write the coverage report");
      return null;
    }
  }
}

const BRACKETS = [1, 2, 3, 4, 5] as const;

export function renderCoverageReport(r: CoverageReport): string {
  const out: string[] = [];
  const scope = [r.options.source ? `source ${r.options.source}` : "every source", r.options.ids ? `${r.options.ids.length} chosen decks` : null, r.options.enable ? "clean decks switched on" : "report only"].filter(Boolean).join(", ");
  out.push(`# Library rules-engine check (${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`, "", `Scope: ${scope}. ${r.lines.length} decks checked.`, "");
  out.push("## Bot-eligible decks per bracket", "", "| Bracket | Before | After | Total |", "|---|---|---|---|");
  for (const b of BRACKETS) out.push(`| ${b} | ${r.before[b].eligible} | ${r.after[b].eligible} | ${r.after[b].total} |`);
  const by = (o: CoverageReportLine["outcome"]) => r.lines.filter((l) => l.outcome === o);
  const enabled = by("enabled");
  out.push("", `## Switched on (${enabled.length})`, "");
  for (const l of enabled) out.push(`- ${l.name} (B${l.bracket}, ${l.source})`);
  const excluded = r.lines.filter((l) => l.missing !== null && (l.missing.length > 0 || l.problems.length > 0));
  out.push("", `## Excluded: Forge cannot play it or an engine table would refuse it (${excluded.length})`, "");
  for (const l of excluded) {
    const why = [l.missing && l.missing.length ? `Forge cannot play ${l.missing.join(", ")}` : null, l.problems.length ? l.problems.join(" ") : null].filter(Boolean).join("; ");
    const state = l.outcome === "kept-by-owner" ? " (left on: the owner switched it on by hand)" : l.outcome === "disabled" ? " (switched off)" : "";
    out.push(`- ${l.name} (B${l.bracket}, ${l.source}): ${why}${state}`);
  }
  const unchecked = r.lines.filter((l) => l.missing === null);
  if (unchecked.length) {
    out.push("", `## Not checked (${unchecked.length})`, "");
    for (const l of unchecked) out.push(`- ${l.name}: ${l.error ?? "unknown"}`);
  }
  return out.join("\n") + "\n";
}
