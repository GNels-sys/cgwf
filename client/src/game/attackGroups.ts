import type { EngineEntityRef, EngineOptionCard } from "@cgwf/shared";

/**
 * Attacking with many identical creatures (owner request 2026-11-18: 110 tokens, each tapped one by one).
 * Candidates of an attackers prompt are grouped when the attack cannot tell them apart: the same name, the
 * same power and toughness, and the same players they may (or must) attack. Everything here is pure; the
 * pick state stays one defender per creature, which is what the engine is sent.
 */
export type AttackTargets = Record<string, EngineEntityRef>;

export function refKey(r: EngineEntityRef): string {
  return r.kind === "player" ? `p:${r.player}` : `c:${r.iid}`;
}

export interface AttackGroup {
  key: string;
  name: string;
  power: number | null;
  toughness: number | null;
  /** Every creature of the group, in the prompt's order. */
  iids: string[];
  /** Where these creatures may be sent: the required defenders when the rules make them attack. */
  pool: EngineEntityRef[];
  /** The rules make these attack if able (goad, an encore copy). */
  required: boolean;
}

/** The defenders a creature may be sent at. A creature the rules send somewhere may only go there. */
export function attackPool(c: EngineOptionCard): EngineEntityRef[] {
  return c.mustAttack && c.mustAttack.length > 0 ? c.mustAttack : (c.canAttack ?? []);
}

export function attackGroups(candidates: EngineOptionCard[]): AttackGroup[] {
  const groups = new Map<string, AttackGroup>();
  for (const c of candidates) {
    const pool = attackPool(c);
    if (pool.length === 0) continue;
    const required = (c.mustAttack?.length ?? 0) > 0;
    const key = [c.name, c.power, c.toughness, required ? "must" : "may", pool.map(refKey).sort().join(",")].join("|");
    const g = groups.get(key);
    if (g) g.iids.push(c.iid);
    else groups.set(key, { key, name: c.name, power: c.power, toughness: c.toughness, iids: [c.iid], pool, required });
  }
  return [...groups.values()];
}

const allows = (pool: EngineEntityRef[], d: EngineEntityRef) => pool.some((x) => refKey(x) === refKey(d));

/** How many of the group attack this defender. */
export function countAt(group: AttackGroup, targets: AttackTargets, defender: EngineEntityRef): number {
  const key = refKey(defender);
  return group.iids.filter((iid) => targets[iid] && refKey(targets[iid]!) === key).length;
}

/** How many of the group attack nobody yet. */
export function countFree(group: AttackGroup, targets: AttackTargets): number {
  return group.iids.filter((iid) => !targets[iid]).length;
}

/**
 * Make exactly `wanted` of the group attack `defender`. More come from the ones attacking nobody (never from
 * another defender's share); fewer go back to attacking nobody. Out-of-range numbers are clamped.
 */
export function setCount(targets: AttackTargets, group: AttackGroup, defender: EngineEntityRef, wanted: number): AttackTargets {
  if (!allows(group.pool, defender)) return targets;
  const key = refKey(defender);
  const here = group.iids.filter((iid) => targets[iid] && refKey(targets[iid]!) === key);
  const free = group.iids.filter((iid) => !targets[iid]);
  const most = here.length + free.length;
  const n = Math.max(0, Math.min(Number.isFinite(wanted) ? Math.floor(wanted) : most, most));
  if (n === here.length) return targets;
  const next = { ...targets };
  if (n > here.length) for (const iid of free.slice(0, n - here.length)) next[iid] = defender;
  else for (const iid of here.slice(n)) delete next[iid];
  return next;
}

/** Everything of the group that attacks nobody yet goes at `defender`. */
export function sendRest(targets: AttackTargets, group: AttackGroup, defender: EngineEntityRef): AttackTargets {
  return setCount(targets, group, defender, Number.POSITIVE_INFINITY);
}

/** Take the whole group back. */
export function clearGroup(targets: AttackTargets, group: AttackGroup): AttackTargets {
  const next = { ...targets };
  for (const iid of group.iids) delete next[iid];
  return next;
}

/** The whole group, shared out as evenly as it goes among `defenders` (the first ones take the remainder). */
export function splitEvenly(targets: AttackTargets, group: AttackGroup, defenders: EngineEntityRef[]): AttackTargets {
  const to = defenders.filter((d) => allows(group.pool, d));
  if (to.length === 0) return targets;
  const next = clearGroup(targets, group);
  const share = Math.floor(group.iids.length / to.length);
  const extra = group.iids.length % to.length;
  let at = 0;
  to.forEach((d, i) => {
    const n = share + (i < extra ? 1 : 0);
    for (const iid of group.iids.slice(at, at + n)) next[iid] = d;
    at += n;
  });
  return next;
}

/**
 * "All attack X": every creature that may attack `defender` does. A creature the rules send at someone else
 * goes there instead, so the declaration stays legal.
 */
export function everyoneAt(candidates: EngineOptionCard[], defender: EngineEntityRef): AttackTargets {
  const next: AttackTargets = {};
  for (const c of candidates) {
    const pool = attackPool(c);
    const to = allows(pool, defender) ? defender : (c.mustAttack?.length ?? 0) > 0 ? pool[0] : undefined;
    if (to) next[c.iid] = to;
  }
  return next;
}

/**
 * A tap on a rolled-up stack of identical creatures: the whole stack attacks `current` (each creature at the
 * defender it is allowed), or the whole stack is taken back when it was attacking already.
 */
export function toggleMany(targets: AttackTargets, cards: EngineOptionCard[], current: EngineEntityRef | null): AttackTargets {
  if (cards.length === 0) return targets;
  const next = { ...targets };
  if (cards.every((c) => next[c.iid])) {
    for (const c of cards) delete next[c.iid];
    return next;
  }
  for (const c of cards) {
    if (next[c.iid]) continue;
    const pool = attackPool(c);
    const to = current && allows(pool, current) ? current : pool[0];
    if (to) next[c.iid] = to;
  }
  return next;
}

/** "Saproling 1/1": how the sheet names a group. */
export function groupLabel(group: AttackGroup): string {
  const pt = group.power !== null && group.toughness !== null ? ` ${group.power}/${group.toughness}` : "";
  return `${group.name}${pt}`;
}
