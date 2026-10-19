import type { ArchetypeTag } from "@cgwf/shared";
import { IDENTITIES, IDENTITY_GROUPS, identityInfo, type IdentityGroup } from "./identity.js";
import { WIN_CONDITIONS, type WinCondition } from "./wincon.js";

/**
 * Picks N commanders for one EDHREC bracket. Pure apart from `evaluate`, which the importer
 * implements (fetch the bracket's average deck, resolve it, analyse it) and memoises; tests pass a
 * table. Candidates are ranked by that bracket's deck count. Order of passes:
 *   A  coverage: the best candidate of every colour identity (or every identity size group, for
 *      the small cEDH bracket) that has one;
 *   B  archetypes: new primary archetypes until `minArchetypes` distinct ones;
 *   C  win conditions: each class up to `winConMin` decks;
 *   D  fill by rank;
 *   E  only if still short: fill by rank ignoring the archetype cap (reported).
 * Every pass respects the identity cap, the minimum deck count and the overlap cap with an earlier
 * bracket; A-D also respect the archetype cap.
 */
export type EdhrecBracket = 3 | 4 | 5;
export const EDHREC_BRACKET_NAMES: Record<EdhrecBracket, "upgraded" | "optimized" | "cedh"> = { 3: "upgraded", 4: "optimized", 5: "cedh" };
export const EDHREC_BRACKET_LABELS: Record<EdhrecBracket, "Upgraded" | "Optimized" | "cEDH"> = { 3: "Upgraded", 4: "Optimized", 5: "cEDH" };

export interface Candidate {
  slug: string;
  name: string;
  identity: string;
  bracketCounts: Record<1 | 2 | 3 | 4 | 5, number>;
}

export type Evaluation =
  | { ok: true; primary: ArchetypeTag | null; winCondition: WinCondition }
  | { ok: false; reason: string };

export interface SelectionRules {
  bracket: EdhrecBracket;
  target: number;
  identityCap: number;
  archetypeCap: number;
  minArchetypes: number;
  /** Fewest decks EDHREC must have seen in this bracket for the average to be worth importing. */
  minDecks: number;
  /** "identity": all 32 identities where candidates exist; "group": the six size groups. */
  coverage: "identity" | "group";
  winConMin: number;
  /** Commanders already chosen in an earlier bracket, and how many of them may repeat here. */
  overlapWith?: ReadonlySet<string>;
  overlapCap?: number;
}

export interface Pick {
  slug: string;
  name: string;
  identity: string;
  decks: number;
  rank: number;
  primary: ArchetypeTag | null;
  winCondition: WinCondition;
  pass: "A" | "B" | "C" | "D" | "E";
  reason: string;
}

export interface Rejection {
  slug: string;
  name: string;
  reason: string;
}

export interface SelectionResult {
  bracket: EdhrecBracket;
  picks: Pick[];
  rejected: Rejection[];
  /** Goals that could not be met, in words. */
  unmet: string[];
  /** Candidates with enough decks in this bracket (the ranked pool). */
  poolSize: number;
}

export function rankCandidates(candidates: Candidate[], bracket: EdhrecBracket, minDecks: number): Candidate[] {
  return candidates
    .filter((c) => c.bracketCounts[bracket] >= minDecks)
    .sort((a, b) => b.bracketCounts[bracket] - a.bracketCounts[bracket] || a.slug.localeCompare(b.slug));
}

export async function selectBracket(candidates: Candidate[], rules: SelectionRules, evaluate: (c: Candidate) => Promise<Evaluation>): Promise<SelectionResult> {
  const ranked = rankCandidates(candidates, rules.bracket, rules.minDecks);
  const rankOf = new Map(ranked.map((c, i) => [c.slug, i + 1]));
  const memo = new Map<string, Evaluation>();
  const rejected: Rejection[] = [];
  const picks: Pick[] = [];
  const taken = new Set<string>();
  const perIdentity = new Map<string, number>();
  const perArchetype = new Map<string, number>();
  const perWin = new Map<WinCondition, number>();
  let overlap = 0;
  const unmet: string[] = [];

  const evalOf = async (c: Candidate): Promise<Evaluation> => {
    const hit = memo.get(c.slug);
    if (hit) return hit;
    const e = await evaluate(c);
    memo.set(c.slug, e);
    if (!e.ok) rejected.push({ slug: c.slug, name: c.name, reason: e.reason });
    return e;
  };
  const archKey = (p: ArchetypeTag | null) => p ?? "none";
  const full = () => picks.length >= rules.target;
  /** Cheap checks first, so the network is only hit for candidates that could be taken. */
  const preCheck = (c: Candidate): boolean => {
    if (taken.has(c.slug)) return false;
    if ((perIdentity.get(c.identity) ?? 0) >= rules.identityCap) return false;
    if (rules.overlapWith?.has(c.slug) && overlap >= (rules.overlapCap ?? Infinity)) return false;
    return true;
  };
  const archOk = (e: Extract<Evaluation, { ok: true }>, relaxArch: boolean) => relaxArch || (perArchetype.get(archKey(e.primary)) ?? 0) < rules.archetypeCap;
  const take = (c: Candidate, e: Extract<Evaluation, { ok: true }>, pass: Pick["pass"], why: string) => {
    taken.add(c.slug);
    perIdentity.set(c.identity, (perIdentity.get(c.identity) ?? 0) + 1);
    perArchetype.set(archKey(e.primary), (perArchetype.get(archKey(e.primary)) ?? 0) + 1);
    perWin.set(e.winCondition, (perWin.get(e.winCondition) ?? 0) + 1);
    if (rules.overlapWith?.has(c.slug)) overlap++;
    const rank = rankOf.get(c.slug) ?? 0;
    picks.push({
      slug: c.slug,
      name: c.name,
      identity: c.identity,
      decks: c.bracketCounts[rules.bracket],
      rank,
      primary: e.primary,
      winCondition: e.winCondition,
      pass,
      reason: `#${rank} by ${EDHREC_BRACKET_NAMES[rules.bracket]} decks (${c.bracketCounts[rules.bracket]}); ${why}`,
    });
  };
  /** First ranked candidate passing `want`, taken with `why`. */
  const takeFirst = async (pool: Candidate[], want: (e: Extract<Evaluation, { ok: true }>) => boolean, pass: Pick["pass"], why: string, relaxArch = false): Promise<boolean> => {
    for (const c of pool) {
      if (full()) return false;
      if (!preCheck(c)) continue;
      const e = await evalOf(c);
      if (!e.ok || !archOk(e, relaxArch) || !want(e)) continue;
      take(c, e, pass, why);
      return true;
    }
    return false;
  };

  // A: coverage
  if (rules.coverage === "identity") {
    const order = IDENTITIES.map((i) => ({ i, best: ranked.find((c) => c.identity === i.key) }))
      .filter((x) => x.best)
      .sort((a, b) => b.best!.bracketCounts[rules.bracket] - a.best!.bracketCounts[rules.bracket]);
    for (const { i } of order) {
      if (full()) break;
      const ok = await takeFirst(ranked.filter((c) => c.identity === i.key), () => true, "A", `best ${i.label} deck (colour coverage)`);
      if (!ok) unmet.push(`no usable ${i.label} deck`);
    }
    for (const i of IDENTITIES) if (!ranked.some((c) => c.identity === i.key)) unmet.push(`no ${i.label} commander with ${rules.minDecks}+ decks in the candidate pool`);
  } else {
    for (const g of IDENTITY_GROUPS) {
      if (full()) break;
      const pool = ranked.filter((c) => identityInfo(c.identity).group === g);
      if (pool.length === 0) {
        unmet.push(`no ${groupLabel(g)} commander with ${rules.minDecks}+ decks in the candidate pool`);
        continue;
      }
      const ok = await takeFirst(pool, () => true, "A", `best ${groupLabel(g)} deck (colour-group coverage)`);
      if (!ok) unmet.push(`no usable ${groupLabel(g)} deck`);
    }
  }

  // B: archetype variety
  const distinct = () => new Set(picks.map((p) => p.primary).filter((p): p is ArchetypeTag => p !== null)).size;
  while (!full() && distinct() < rules.minArchetypes) {
    const seen = new Set(picks.map((p) => p.primary));
    const ok = await takeFirst(ranked, (e) => e.primary !== null && !seen.has(e.primary), "B", "adds a new primary archetype");
    if (!ok) break;
  }
  if (distinct() < rules.minArchetypes) unmet.push(`only ${distinct()} distinct primary archetypes (goal ${rules.minArchetypes})`);

  // C: win-condition mix
  for (const w of WIN_CONDITIONS) {
    while (!full() && (perWin.get(w) ?? 0) < rules.winConMin) {
      const ok = await takeFirst(ranked, (e) => e.winCondition === w, "C", `adds a ${w} win condition`);
      if (!ok) {
        unmet.push(`only ${perWin.get(w) ?? 0} ${w} decks (goal ${rules.winConMin})`);
        break;
      }
    }
  }

  // D: fill by rank
  while (!full()) {
    const ok = await takeFirst(ranked, () => true, "D", "next by popularity");
    if (!ok) break;
  }
  // E: relax the archetype cap only if still short
  if (!full()) {
    while (!full()) {
      const ok = await takeFirst(ranked, () => true, "E", "next by popularity (archetype cap relaxed)", true);
      if (!ok) break;
    }
    if (picks.some((p) => p.pass === "E")) unmet.push(`archetype cap of ${rules.archetypeCap} relaxed to fill the bracket`);
  }
  if (!full()) unmet.push(`only ${picks.length} of ${rules.target} decks found`);

  return { bracket: rules.bracket, picks, rejected, unmet, poolSize: ranked.length };
}

export function groupLabel(g: IdentityGroup): string {
  return g === "colorless" ? "colourless" : g === "mono" ? "mono-colour" : g === "five" ? "five-colour" : `${g}-colour`;
}

/** Counts for the report: identities, groups, archetypes, win conditions. */
export function diversitySummary(picks: Pick[]) {
  const count = <K extends string>(keys: K[]) => keys.reduce<Record<string, number>>((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {});
  return {
    identities: count(picks.map((p) => identityInfo(p.identity).label)),
    groups: count(picks.map((p) => groupLabel(identityInfo(p.identity).group))),
    archetypes: count(picks.map((p) => p.primary ?? "none")),
    winConditions: count(picks.map((p) => p.winCondition)),
  };
}
