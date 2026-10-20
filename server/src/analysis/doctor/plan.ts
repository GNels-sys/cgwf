import { DOCTOR_ROLE_LABELS, normalizeName, type Bracket, type DoctorRole, type DoctorRoleCount, type DoctorSwap } from "@cgwf/shared";
import { analyzeDeck } from "../index.js";
import { isLand, type AnalysisCard } from "../cards.js";
import type { SpellbookResults, SpellbookVariant } from "../combos.js";
import type { GameChangersList } from "../gameChangers.js";
import type { EdhrecCardStat } from "./edhrec.js";
import { roleCounts, rolesOf } from "./roles.js";

/**
 * The Deck Doctor's planner: pure, no I/O, so every rule is unit-tested (doctor.test.ts).
 *
 * Adds. Candidates come from EDHREC's list for the commander and from Commander Spellbook's "one card
 * away" combos (the service resolves them to real cards and drops anything outside the colour identity,
 * not Commander-legal, without a paper printing, already in the deck or dismissed). Score =
 * 60 x inclusion + 100 x positive synergy, + 15 when the card fills a role the deck is short of
 * (DOCTOR_ROLE_TARGETS), + 20 per combo it completes (two at most). Bracket: each scored add is replayed
 * through the real analysis (`analyzeDeck`) with the deck + the add and any combo it completes; when the
 * bracket floor would rise above the target bracket (or the deck's own floor, if already higher) the add
 * is dropped, unless the user allowed a higher bracket, in which case the swap says so.
 *
 * Cuts. Never a commander, a pinned "keep" card, or a piece of a combo the deck already has; never a
 * land unless the add is a land (the land count never drops otherwise). Each card is valued like an add
 * (60 x inclusion + 100 x synergy, 0 when EDHREC does not list it), + 25 for every short role it fills
 * that the add does not, - 8 for each over-filled role, - 5 for mana value 6+. The cut is the
 * lowest-valued card sharing a role with the add when one exists ("ramp for ramp"), else the lowest-valued
 * card overall. A card is cut once (a basic land line may give up one copy per land add).
 * A swap is kept when the add is worth more than the cut; the best 10 by gain are returned.
 */

export interface DoctorDeckCard extends AnalysisCard {
  entryId: number | null;
  cardId: string;
  oracleId: string | null;
  faceCount: number;
}

export interface DoctorCandidate extends AnalysisCard {
  cardId: string;
  oracleId: string;
  faceCount: number;
  sources: Array<"edhrec" | "combo">;
  /** Spellbook variants (one card away) this card completes, already filtered to this deck. */
  completes: SpellbookVariant[];
}

export interface PlanInput {
  deck: DoctorDeckCard[];
  candidates: DoctorCandidate[];
  edhrec: Map<string, EdhrecCardStat> | null;
  /** "Atraxa", "Thrasios + Tymna": used in the reason sentences. */
  commanderLabel: string;
  target: Bracket;
  allowHigher: boolean;
  gameChangers: GameChangersList;
  combos: SpellbookResults | null;
  keep: ReadonlySet<string>;
  dismissed: ReadonlySet<string>;
  limit?: number;
}

export interface PlanResult {
  swaps: Array<Omit<DoctorSwap, "add"> & { add: Omit<DoctorSwap["add"], "localStores" | "cheapestLocal"> }>;
  roles: DoctorRoleCount[];
  floorBefore: number;
}

const ADD_FLOOR = 8;
const BRACKET_CHECKS = 80;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;

export function edhrecValue(stat: EdhrecCardStat | undefined): number {
  if (!stat) return 0;
  return 60 * stat.inclusion + 100 * Math.max(0, stat.synergy);
}

export function comboLabel(v: SpellbookVariant, missing: string): string {
  const others = v.uses.map((u) => u.card.name).filter((n) => n !== missing);
  const effect = v.produces.slice(0, 2).map((p) => p.feature.name.toLowerCase()).join(", ");
  return `${[missing, ...others].join(" + ")}${effect ? `: ${effect}` : ""}`;
}

function comboPieces(combos: SpellbookResults | null, deckNames: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of combos?.included ?? []) {
    const names = v.uses.map((u) => u.card.name);
    if (names.every((n) => deckNames.has(n))) for (const n of names) out.add(n);
  }
  return out;
}

export function planSwaps(input: PlanInput): PlanResult {
  const { deck, edhrec, gameChangers } = input;
  const stat = (name: string) => edhrec?.get(normalizeName(name));
  const roles = roleCounts(deck);
  const have = new Map(roles.map((r) => [r.role, r]));
  const short = (role: DoctorRole) => {
    const r = have.get(role)!;
    return r.have < r.want;
  };
  const over = (role: DoctorRole) => {
    const r = have.get(role)!;
    return role !== "land" && r.have > r.want + 3;
  };
  const baseCombos: SpellbookResults = { included: input.combos?.included ?? [] };
  const floorBefore = analyzeDeck(deck, { gameChangers, combos: baseCombos }).floor;
  const ceiling = Math.max(input.target, floorBefore);

  // ---- adds
  type ScoredAdd = { c: DoctorCandidate; roles: DoctorRole[]; gap: DoctorRole | null; score: number };
  const scored: ScoredAdd[] = [];
  for (const c of input.candidates) {
    if (input.dismissed.has(c.oracleId)) continue;
    const r = rolesOf(c);
    const gap = r.find(short) ?? null;
    const combosBonus = 20 * Math.min(2, c.completes.length);
    const score = edhrecValue(stat(c.name)) + (gap ? 15 : 0) + combosBonus;
    if (score < ADD_FLOOR) continue;
    scored.push({ c, roles: r, gap, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));

  const checked: Array<ScoredAdd & { floorAfter: number }> = [];
  for (const s of scored.slice(0, BRACKET_CHECKS)) {
    const combos: SpellbookResults = { included: [...baseCombos.included, ...s.c.completes] };
    const floorAfter = analyzeDeck([...deck, { ...s.c, quantity: 1, board: "main" }], { gameChangers, combos }).floor;
    if (floorAfter > ceiling && !input.allowHigher) continue;
    checked.push({ ...s, floorAfter });
  }

  // ---- cuts
  const deckNames = new Set(deck.map((d) => d.name));
  const pieces = comboPieces(input.combos, deckNames);
  type Cuttable = { d: DoctorDeckCard; roles: DoctorRole[]; left: number };
  const cuttable: Cuttable[] = deck
    .filter((d) => d.board === "main" && !(d.oracleId && input.keep.has(d.oracleId)) && !pieces.has(d.name))
    .map((d) => ({ d, roles: rolesOf(d), left: Math.max(1, d.quantity) }));
  const cutValue = (x: Cuttable, addRoles: DoctorRole[]) =>
    edhrecValue(stat(x.d.name)) +
    25 * x.roles.filter((r) => r !== "land" && short(r) && !addRoles.includes(r)).length -
    8 * x.roles.filter(over).length -
    (x.d.cmc >= 6 ? 5 : 0);

  const swaps: PlanResult["swaps"] = [];
  for (const a of checked) {
    const addIsLand = isLand(a.c);
    const pool = cuttable.filter((x) => x.left > 0 && (addIsLand || !isLand(x.d)));
    if (pool.length === 0) continue;
    const sameRole = pool.filter((x) => x.roles.some((r) => a.roles.includes(r) && (r !== "land" || addIsLand)));
    const from = sameRole.length ? sameRole : pool;
    const cut = from.reduce((best, x) => (cutValue(x, a.roles) < cutValue(best, a.roles) ? x : best));
    const cutScore = cutValue(cut, a.roles);
    const gain = a.score - cutScore;
    if (gain <= 0) continue;
    cut.left--;
    const sharedRole = cut.roles.find((r) => a.roles.includes(r)) ?? null;
    const role = a.gap ?? sharedRole ?? a.roles[0] ?? null;
    swaps.push({
      add: {
        cardId: a.c.cardId,
        oracleId: a.c.oracleId,
        name: a.c.name,
        typeLine: a.c.typeLine,
        manaCost: a.c.manaCost,
        faceCount: a.c.faceCount,
        roles: a.roles,
        synergy: stat(a.c.name)?.synergy ?? null,
        inclusion: stat(a.c.name)?.inclusion ?? null,
        sources: [...new Set([...a.c.sources, ...(a.gap ? (["role"] as const) : [])])],
      },
      cut: {
        cardId: cut.d.cardId,
        oracleId: cut.d.oracleId,
        name: cut.d.name,
        typeLine: cut.d.typeLine,
        manaCost: cut.d.manaCost,
        faceCount: cut.d.faceCount,
        roles: cut.roles,
        synergy: stat(cut.d.name)?.synergy ?? null,
        inclusion: stat(cut.d.name)?.inclusion ?? null,
        entryId: cut.d.entryId,
        quantity: cut.d.quantity,
      },
      role,
      reason: reasonFor(input.commanderLabel, a, cut.d, sharedRole, stat(a.c.name), stat(cut.d.name), have),
      combos: a.c.completes.map((v) => comboLabel(v, a.c.name)),
      bracket: {
        floorBefore,
        floorAfter: a.floorAfter,
        raises: a.floorAfter > ceiling,
        note: a.floorAfter > ceiling ? `Raises the bracket floor to ${a.floorAfter} (your target is ${input.target}).` : null,
      },
      score: Math.round(gain * 10) / 10,
    });
  }
  swaps.sort((x, y) => y.score - x.score || x.add.name.localeCompare(y.add.name));
  return { swaps: swaps.slice(0, input.limit ?? 10), roles, floorBefore };
}

function reasonFor(
  label: string,
  a: { c: DoctorCandidate; gap: DoctorRole | null },
  cut: DoctorDeckCard,
  sharedRole: DoctorRole | null,
  addStat: EdhrecCardStat | undefined,
  cutStat: EdhrecCardStat | undefined,
  have: Map<DoctorRole, DoctorRoleCount>,
): string {
  const parts: string[] = [];
  if (addStat) parts.push(`${signedPct(addStat.synergy)} synergy with ${label}, in ${pct(addStat.inclusion)} of ${label} decks`);
  if (a.c.completes.length) parts.push(`completes ${comboLabel(a.c.completes[0]!, a.c.name)}`);
  if (a.gap) {
    const r = have.get(a.gap)!;
    parts.push(`the deck has ${r.have} ${DOCTOR_ROLE_LABELS[a.gap].toLowerCase()} of ${r.want} suggested`);
  }
  const addPart = parts.length ? parts.join("; ") : "fits the deck";
  let cutPart: string;
  if (sharedRole && sharedRole !== "land") cutPart = `Replaces ${cut.name}, your lowest-synergy ${DOCTOR_ROLE_LABELS[sharedRole].toLowerCase()} card`;
  else if (sharedRole === "land") cutPart = `Replaces ${cut.name}, your lowest-synergy land`;
  else if (cutStat) cutPart = `Replaces ${cut.name} (${signedPct(cutStat.synergy)} synergy, in ${pct(cutStat.inclusion)} of ${label} decks)`;
  else cutPart = `Replaces ${cut.name}, which EDHREC does not list for ${label}`;
  if (cut.cmc >= 6) cutPart += `; mana value ${cut.cmc}`;
  return `${addPart.charAt(0).toUpperCase()}${addPart.slice(1)}. ${cutPart}.`;
}
