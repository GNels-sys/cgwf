/**
 * Who decides whether a library deck may be dealt to bots (`library_decks.agent_eligible`)?
 *
 * Owner request (2026-10-19): the Forge coverage check switches decks on when Forge can play them and
 * they are legal for engine tables, but it must never undo the owner's own choice. So every switch is
 * recorded in `import_meta.eligibleBy`:
 *
 * - "owner": set from the Library page (PATCH agentEligible). The check never changes it, on or off.
 * - "coverage": switched on by a coverage check. A later check that finds a problem switches it off.
 * - absent: nobody decided yet. A clean check (with `enable`) switches it on. A deck that is already on
 *   with no record counts as the owner's (precons switched on by hand before this existed), except EDHREC
 *   imports, which only ever became eligible through their importer's check.
 */
export type EligibleBy = "owner" | "coverage";

export interface EligibilityInput {
  current: boolean;
  eligibleBy: EligibleBy | null;
  source: string;
  /** null = the check could not run (no engine, engine busy): nothing changes. */
  clean: boolean | null;
  /** Switch clean decks on (EDHREC import, precon import, `--enable`); off = report only. */
  enable: boolean;
}

export interface EligibilityDecision {
  eligible: boolean;
  eligibleBy: EligibleBy | null;
  /** What happened, for the report. */
  outcome: "enabled" | "disabled" | "kept-by-owner" | "unchanged";
}

/**
 * A deck the rules engine can play may still be held back from bots (owner, 2026-11-17): an EDHREC
 * "core" average filed under Bracket 2 whose cards the written bracket rules put higher (a two-card
 * combo, a Game Changer, chained extra turns). After the first 150-deck Bracket 2 import 25 such decks
 * sat in the Bracket 2 bot pool. A held deck stays in the library for people; bots are not dealt it. The
 * owner can still switch a single deck on from the Library page (that choice is never overridden), or
 * file it under a higher bracket, which lifts the hold at the next check.
 */
export function botHoldReason(d: { source: string; bracket: number; floor: number | null }): string | null {
  if (d.source !== "edhrec" || d.bracket !== 2 || d.floor === null || d.floor <= 2) return null;
  return `the bracket rules put it at Bracket ${d.floor} or higher, above the Bracket 2 it is filed under`;
}

export function decideEligibility(i: EligibilityInput): EligibilityDecision {
  const by: EligibleBy | null = i.eligibleBy ?? (i.current ? (i.source === "edhrec" ? "coverage" : "owner") : null);
  const same = (outcome: EligibilityDecision["outcome"] = "unchanged"): EligibilityDecision => ({ eligible: i.current, eligibleBy: by, outcome });
  if (i.clean === null) return same();
  if (by === "owner") return same(i.current && !i.clean ? "kept-by-owner" : "unchanged");
  if (i.clean) {
    if (i.current || !i.enable) return same();
    return { eligible: true, eligibleBy: "coverage", outcome: "enabled" };
  }
  if (i.current) return { eligible: false, eligibleBy: null, outcome: "disabled" };
  return same();
}
