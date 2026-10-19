import type { ArchetypeTag } from "@cgwf/shared";

/**
 * Choosing library decks for computer opponents.
 *
 * Owner report (2026-10-19): "Re-roll" kept dealing the same four decks. The old picker sorted every
 * candidate by how many archetype tags it shared with the host's deck and the picks so far and took
 * the lowest, so decks with few or no tags won every time and the shuffle only broke ties among them.
 *
 * Now: picks are a weighted random draw (variety is a preference, not a rule), decks dealt to this
 * host recently sit out until the eligible pool has been cycled through, and two bots share a commander
 * only when the library has no other choice.
 */

export interface PickableDeck {
  id: string;
  commanders: string[];
  tags: ArchetypeTag[];
}

export interface PickOptions {
  count: number;
  /** Archetype tags of the host's own deck. */
  hostTags: Iterable<ArchetypeTag>;
  /** Library deck ids dealt to this host recently, newest first. */
  recent: readonly string[];
  /** Injected for tests; Math.random in production. */
  random?: (() => number) | undefined;
}

/** Decks remembered per host. With 3 bots per deal this is the last 40 deals. */
export const RECENT_DECKS_MAX = 120;

/** Weight floor: even a deck that repeats every strategy already at the table can still be dealt. */
const MIN_WEIGHT = 0.25;

function commanderKey(deck: PickableDeck): string {
  return deck.commanders.map((c) => c.toLowerCase()).sort().join(" + ");
}

/**
 * How much of this deck's strategy is already at the table, 0..1. A deck with no tags is unknown,
 * not "maximally different": it gets the middle value instead of winning every draw.
 */
export function tagOverlap(tags: readonly ArchetypeTag[], taken: ReadonlySet<ArchetypeTag>): number {
  if (tags.length === 0) return 0.5;
  return tags.filter((t) => taken.has(t)).length / tags.length;
}

export function pickWeight(tags: readonly ArchetypeTag[], taken: ReadonlySet<ArchetypeTag>): number {
  return Math.max(MIN_WEIGHT, 1 - 0.75 * tagOverlap(tags, taken));
}

function weightedDraw<T>(items: readonly T[], weight: (item: T) => number, random: () => number): T | undefined {
  if (items.length === 0) return undefined;
  const weights = items.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Pick up to `count` decks. Decks not dealt recently are drawn first; only if there are not enough of
 * them do recent decks come back, least recently dealt first.
 */
export function pickAgentDecks<D extends PickableDeck>(pool: readonly D[], opts: PickOptions): D[] {
  const random = opts.random ?? Math.random;
  const recentRank = new Map(opts.recent.map((id, i) => [id, i]));
  const fresh = pool.filter((d) => !recentRank.has(d.id));
  // Oldest deal first: a larger index in `recent` means it was dealt longer ago.
  const stale = pool.filter((d) => recentRank.has(d.id)).sort((a, b) => recentRank.get(b.id)! - recentRank.get(a.id)!);

  const picks: D[] = [];
  const taken = new Set<ArchetypeTag>(opts.hostTags);
  const commanders = new Set<string>();
  const usable = (d: D) => !picks.includes(d) && !commanders.has(commanderKey(d));

  while (picks.length < opts.count) {
    const freshLeft = fresh.filter(usable);
    let pick: D | undefined;
    if (freshLeft.length > 0) {
      pick = weightedDraw(freshLeft, (d) => pickWeight(d.tags, taken), random);
    } else {
      pick = stale.find(usable);
    }
    if (!pick) break;
    picks.push(pick);
    commanders.add(commanderKey(pick));
    for (const t of pick.tags) taken.add(t);
  }
  // Last resort for a tiny library: seat the requested number of bots even if a commander repeats.
  for (const d of [...fresh, ...stale]) {
    if (picks.length >= opts.count) break;
    if (!picks.includes(d)) picks.push(d);
  }
  return picks;
}

/** The new "recently dealt" list after a deal: this deal first, then the rest, capped. */
export function rememberDeal(recent: readonly string[], dealt: readonly string[], max = RECENT_DECKS_MAX): string[] {
  const out = [...dealt, ...recent.filter((id) => !dealt.includes(id))];
  return out.slice(0, max);
}
