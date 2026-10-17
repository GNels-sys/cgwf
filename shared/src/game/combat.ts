import { deriveBattlefield, type DerivedCard } from "./effects.js";
import type { CardInstance, DamageAssignment, GameState, PlayerId } from "./types.js";

/**
 * Combat helpers shared by the reducer (validation, default damage) and the
 * client (the damage sheet). Everything is derived from the same
 * `deriveBattlefield` the tiles use, so the proposal matches what players see.
 *
 * This is a stopgap for a manual table: first strike, damage prevention,
 * protection and "can't be blocked" are NOT modelled; the attacker edits the
 * proposal when they matter, and creature deaths are still moved by hand.
 */

export function permanentsOf(state: GameState, controller: PlayerId): CardInstance[] {
  const p = state.players[controller];
  if (!p) return [];
  const out: CardInstance[] = [];
  for (const list of Object.values(p.zones.battlefield)) for (const iid of list) {
    const c = state.cards[iid];
    if (c) out.push(c);
  }
  return out;
}

/** Derived stats (P/T, keywords) for every permanent one player controls. */
export function derivedFor(state: GameState, controller: PlayerId): Map<string, DerivedCard> {
  const p = state.players[controller];
  return deriveBattlefield(permanentsOf(state, controller), (c) => (c as CardInstance).printing, p?.manualAnthems ?? []).cards;
}

/** Derived stats for one permanent (its controller's derivation). */
export function derivedCard(state: GameState, c: CardInstance): DerivedCard | undefined {
  return derivedFor(state, c.zone.owner).get(c.iid);
}

export function hasKeyword(d: DerivedCard | undefined, keyword: string): boolean {
  if (!d) return false;
  const k = keyword.toLowerCase();
  return d.keywords.some((x) => x === k || x.startsWith(`${k} `));
}

export function typeLineOf(c: CardInstance): string {
  const p = c.printing;
  const face = p ? (p.faces[c.face] ?? p.faces[0]) : undefined;
  return (c.custom?.typeLine ?? face?.typeLine ?? p?.typeLine ?? "").split(" // ")[0]!.toLowerCase();
}

export function isPlaneswalkerOrBattle(c: CardInstance): boolean {
  return /\b(planeswalker|battle)\b/.test(typeLineOf(c));
}

/** Lethal damage for a blocker/attacker given the source's keywords: 1 with deathtouch, else remaining toughness. */
function lethalFor(target: DerivedCard | undefined, sourceDeathtouch: boolean): number {
  if (sourceDeathtouch) return 1;
  return Math.max(1, target?.toughness ?? 1);
}

/**
 * Default combat damage, the way a careful player would assign it:
 * - an unblocked attacker deals its power to the player (or planeswalker) it attacks;
 * - a blocked attacker deals lethal damage to each blocker in declared order, the remainder to the
 *   last blocker, or to the defending player/planeswalker when it has trample;
 * - each blocker deals its power to the attacker it blocks.
 * Sources with no numeric power (custom tokens with "*") contribute nothing; the player edits.
 */
export function proposeCombatDamage(state: GameState): DamageAssignment[] {
  const combat = state.combat;
  if (!combat) return [];
  const out: DamageAssignment[] = [];
  const derived = new Map<PlayerId, Map<string, DerivedCard>>();
  const statsOf = (c: CardInstance): DerivedCard | undefined => {
    let m = derived.get(c.zone.owner);
    if (!m) {
      m = derivedFor(state, c.zone.owner);
      derived.set(c.zone.owner, m);
    }
    return m.get(c.iid);
  };

  for (const a of combat.attackers) {
    const card = state.cards[a.iid];
    if (!card || card.zone.kind !== "battlefield") continue;
    const d = statsOf(card);
    let power = Math.max(0, d?.power ?? 0);
    const deathtouch = hasKeyword(d, "deathtouch");
    const trample = hasKeyword(d, "trample");
    const blockers = combat.blockers.filter((b) => b.attacker === a.iid).map((b) => state.cards[b.iid]).filter((c): c is CardInstance => Boolean(c && c.zone.kind === "battlefield"));
    const playerTarget: DamageAssignment["target"] = a.planeswalker && state.cards[a.planeswalker]?.zone.kind === "battlefield" ? { kind: "card", iid: a.planeswalker } : { kind: "player", player: a.player };
    if (blockers.length === 0) {
      if (power > 0) out.push({ source: a.iid, target: playerTarget, amount: power });
      continue;
    }
    blockers.forEach((b, i) => {
      const last = i === blockers.length - 1;
      const lethal = lethalFor(statsOf(b), deathtouch);
      let amount = Math.min(power, lethal);
      if (last && !trample) amount = power; // nothing tramples over: the rest goes to the last blocker
      if (amount > 0 || last) out.push({ source: a.iid, target: { kind: "card", iid: b.iid }, amount });
      power -= amount;
    });
    if (trample && power > 0) out.push({ source: a.iid, target: playerTarget, amount: power });
  }

  for (const b of combat.blockers) {
    const card = state.cards[b.iid];
    const attacker = state.cards[b.attacker];
    if (!card || card.zone.kind !== "battlefield" || !attacker || attacker.zone.kind !== "battlefield") continue;
    const power = Math.max(0, statsOf(card)?.power ?? 0);
    if (power > 0) out.push({ source: b.iid, target: { kind: "card", iid: b.attacker }, amount: power });
  }
  return out;
}

/** Total combat damage marked on each card by a set of assignments, and whether it looks lethal. */
export function lethalCards(state: GameState, assignments: DamageAssignment[]): string[] {
  const dealt = new Map<string, { total: number; deathtouch: boolean }>();
  for (const a of assignments) {
    if (a.target.kind !== "card" || a.amount <= 0) continue;
    const src = state.cards[a.source];
    const dt = src ? hasKeyword(derivedCard(state, src), "deathtouch") : false;
    const cur = dealt.get(a.target.iid) ?? { total: 0, deathtouch: false };
    dealt.set(a.target.iid, { total: cur.total + a.amount, deathtouch: cur.deathtouch || dt });
  }
  const out: string[] = [];
  for (const [iid, d] of dealt) {
    const c = state.cards[iid];
    if (!c || c.zone.kind !== "battlefield" || isPlaneswalkerOrBattle(c)) continue;
    const stats = derivedCard(state, c);
    if (!stats?.isCreature) continue;
    if (d.deathtouch || (stats.toughness !== null && d.total >= stats.toughness)) out.push(iid);
  }
  return out;
}
