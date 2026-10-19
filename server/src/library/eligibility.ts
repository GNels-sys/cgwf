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
