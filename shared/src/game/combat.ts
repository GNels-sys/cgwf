import type { CardPrinting } from "../cards.js";
import { deriveBattlefield, type DerivedCard } from "./effects.js";
import type { CardInstance, CombatState, DamageAssignment, GameState, PlayerId } from "./types.js";
import type { PlayerView, ViewCard } from "./view.js";

/**
 * Combat helpers shared by the reducer (validation, default damage) and the
 * client (the damage sheet). Everything is derived from the same
 * `deriveBattlefield` the tiles use, so the proposal matches what players see.
 * The server works from the true GameState; the client from its PlayerView,
 * through the same `CombatContext` shape, so both sides agree on the default.
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

function typeLineFrom(printing: CardPrinting | null, custom: { typeLine: string } | null, face: 0 | 1): string {
  const f = printing ? (printing.faces[face] ?? printing.faces[0]) : undefined;
  return (custom?.typeLine ?? f?.typeLine ?? printing?.typeLine ?? "").split(" // ")[0]!.toLowerCase();
}

export function typeLineOf(c: CardInstance): string {
  return typeLineFrom(c.printing, c.custom, c.face);
}

export function isPlaneswalkerOrBattle(c: CardInstance): boolean {
  return /\b(planeswalker|battle)\b/.test(typeLineOf(c));
}

/** The little the damage proposal needs to know about a card. */
export interface CombatCard {
  iid: string;
  onBattlefield: boolean;
  /** Controller (zone owner). */
  controller: PlayerId;
  typeLine: string;
}

export interface CombatContext {
  combat: CombatState | null;
  card: (iid: string) => CombatCard | undefined;
  stats: (iid: string) => DerivedCard | undefined;
}

export function combatContextFromState(state: GameState): CombatContext {
  const cache = new Map<PlayerId, Map<string, DerivedCard>>();
  return {
    combat: state.combat,
    card: (iid) => {
      const c = state.cards[iid];
      return c ? { iid, onBattlefield: c.zone.kind === "battlefield", controller: c.zone.owner, typeLine: typeLineOf(c) } : undefined;
    },
    stats: (iid) => {
      const c = state.cards[iid];
      if (!c) return undefined;
      let m = cache.get(c.zone.owner);
      if (!m) {
        m = derivedFor(state, c.zone.owner);
        cache.set(c.zone.owner, m);
      }
      return m.get(iid);
    },
  };
}

/** The client's view of the same thing (only visible cards exist in a view, which is all combat ever touches). */
export function combatContextFromView(view: PlayerView, printings: Record<string, CardPrinting>): CombatContext {
  const cards = new Map<string, ViewCard>();
  const stats = new Map<string, DerivedCard>();
  for (const p of Object.values(view.players)) {
    const field = Object.values(p.battlefield).flat();
    for (const c of [...field, ...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards]) cards.set(c.iid, c);
    const derived = deriveBattlefield(field, (c) => ((c as ViewCard).printingId ? (printings[(c as ViewCard).printingId!] ?? null) : null), p.manualAnthems).cards;
    for (const [iid, d] of derived) stats.set(iid, d);
  }
  return {
    combat: view.combat,
    card: (iid) => {
      const c = cards.get(iid);
      if (!c) return undefined;
      const printing = c.printingId ? (printings[c.printingId] ?? null) : null;
      return { iid, onBattlefield: c.zone.kind === "battlefield", controller: c.zone.owner, typeLine: typeLineFrom(printing, c.custom, c.face) };
    },
    stats: (iid) => stats.get(iid),
  };
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
export function proposeDamage(ctx: CombatContext): DamageAssignment[] {
  const combat = ctx.combat;
  if (!combat) return [];
  const out: DamageAssignment[] = [];
  for (const a of combat.attackers) {
    const card = ctx.card(a.iid);
    if (!card?.onBattlefield) continue;
    const d = ctx.stats(a.iid);
    let power = Math.max(0, d?.power ?? 0);
    const deathtouch = hasKeyword(d, "deathtouch");
    const trample = hasKeyword(d, "trample");
    const blockers = combat.blockers.filter((b) => b.attacker === a.iid).map((b) => ctx.card(b.iid)).filter((c): c is CombatCard => Boolean(c?.onBattlefield));
    const playerTarget: DamageAssignment["target"] = a.planeswalker && ctx.card(a.planeswalker)?.onBattlefield ? { kind: "card", iid: a.planeswalker } : { kind: "player", player: a.player };
    if (blockers.length === 0) {
      if (power > 0) out.push({ source: a.iid, target: playerTarget, amount: power });
      continue;
    }
    blockers.forEach((b, i) => {
      const last = i === blockers.length - 1;
      const lethal = lethalFor(ctx.stats(b.iid), deathtouch);
      let amount = Math.min(power, lethal);
      if (last && !trample) amount = power; // nothing tramples over: the rest goes to the last blocker
      if (amount > 0 || last) out.push({ source: a.iid, target: { kind: "card", iid: b.iid }, amount });
      power -= amount;
    });
    if (trample && power > 0) out.push({ source: a.iid, target: playerTarget, amount: power });
  }

  for (const b of combat.blockers) {
    const card = ctx.card(b.iid);
    const attacker = ctx.card(b.attacker);
    if (!card?.onBattlefield || !attacker?.onBattlefield) continue;
    const power = Math.max(0, ctx.stats(b.iid)?.power ?? 0);
    if (power > 0) out.push({ source: b.iid, target: { kind: "card", iid: b.attacker }, amount: power });
  }
  return out;
}

export function proposeCombatDamage(state: GameState): DamageAssignment[] {
  return proposeDamage(combatContextFromState(state));
}

/** Creatures that would have lethal damage marked after these assignments (deathtouch counts). */
export function lethalFrom(ctx: CombatContext, assignments: DamageAssignment[]): string[] {
  const dealt = new Map<string, { total: number; deathtouch: boolean }>();
  for (const a of assignments) {
    if (a.target.kind !== "card" || a.amount <= 0) continue;
    const dt = hasKeyword(ctx.stats(a.source), "deathtouch");
    const cur = dealt.get(a.target.iid) ?? { total: 0, deathtouch: false };
    dealt.set(a.target.iid, { total: cur.total + a.amount, deathtouch: cur.deathtouch || dt });
  }
  const out: string[] = [];
  for (const [iid, d] of dealt) {
    const c = ctx.card(iid);
    if (!c?.onBattlefield || /\b(planeswalker|battle)\b/.test(c.typeLine)) continue;
    const stats = ctx.stats(iid);
    if (!stats?.isCreature) continue;
    if (d.deathtouch || (stats.toughness !== null && d.total >= stats.toughness)) out.push(iid);
  }
  return out;
}

export function lethalCards(state: GameState, assignments: DamageAssignment[]): string[] {
  return lethalFrom(combatContextFromState(state), assignments);
}
