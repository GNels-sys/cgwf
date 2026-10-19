import { describe, expect, it } from "vitest";
import type { ArchetypeTag } from "@cgwf/shared";
import { RECENT_DECKS_MAX, pickAgentDecks, pickWeight, rememberDeal, tagOverlap, type PickableDeck } from "./pick.js";

/** Small deterministic generator so the tests do not depend on Math.random. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAGS: ArchetypeTag[] = ["tokens", "counters", "aristocrats", "voltron", "spellslinger", "reanimator", "landfall", "artifacts"];

/** 40 decks: the first four carry no tags at all (the decks the old picker always dealt). */
function pool(): PickableDeck[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `deck-${i}`,
    commanders: [`Commander ${i}`],
    tags: i < 4 ? [] : [TAGS[i % TAGS.length]!, TAGS[(i * 3) % TAGS.length]!],
  }));
}

/** Deal `rolls` times like the lobby's Re-roll does, remembering each deal. */
function rollMany(decks: PickableDeck[], rolls: number, count: number, seed: number): PickableDeck[][] {
  const random = seeded(seed);
  let recent: string[] = [];
  const deals: PickableDeck[][] = [];
  for (let r = 0; r < rolls; r++) {
    const picks = pickAgentDecks(decks, { count, hostTags: ["tokens"], recent, random });
    recent = rememberDeal(recent, picks.map((d) => d.id));
    deals.push(picks);
  }
  return deals;
}

describe("bot deck picks", () => {
  it("never deals the same deck twice until the pool has been cycled through", () => {
    const deals = rollMany(pool(), 13, 3, 7); // 13 deals x 3 = 39 of the 40 decks
    const ids = deals.flat().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("decks without tags no longer win every deal", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const first = pickAgentDecks(pool(), { count: 3, hostTags: ["tokens"], recent: [], random: seeded(seed) });
      expect(first).toHaveLength(3);
    }
    // Over many independent first deals, the four untagged decks show up about as often as any others.
    const counts = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed++) {
      for (const d of pickAgentDecks(pool(), { count: 3, hostTags: ["tokens"], recent: [], random: seeded(seed) })) {
        counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
      }
    }
    expect(counts.size).toBeGreaterThan(30); // most of the 40 decks were dealt at least once
    const untagged = ["deck-0", "deck-1", "deck-2", "deck-3"].reduce((n, id) => n + (counts.get(id) ?? 0), 0);
    expect(untagged / 1200).toBeLessThan(0.25); // 4 of 40 decks: an even share is 10%, the old picker gave ~100%
  });

  it("re-rolls give different decks", () => {
    const deals = rollMany(pool(), 2, 3, 11);
    const [a, b] = deals.map((d) => new Set(d.map((x) => x.id)));
    expect([...a!].some((id) => b!.has(id))).toBe(false);
  });

  it("never seats two bots with the same commander while another commander is available", () => {
    const twins: PickableDeck[] = [
      { id: "a1", commanders: ["Atraxa, Praetors' Voice"], tags: ["counters"] },
      { id: "a2", commanders: ["Atraxa, Praetors' Voice"], tags: ["tokens"] },
      { id: "a3", commanders: ["atraxa, praetors' voice"], tags: [] },
      { id: "k1", commanders: ["Krenko, Mob Boss"], tags: ["tokens"] },
    ];
    for (let seed = 1; seed <= 50; seed++) {
      const two = pickAgentDecks(twins, { count: 2, hostTags: [], recent: [], random: seeded(seed) });
      expect(new Set(two.map((d) => d.commanders[0]!.toLowerCase())).size).toBe(2);
      // Three bots but only two commanders: still three seats, and only then does one repeat.
      expect(pickAgentDecks(twins, { count: 3, hostTags: [], recent: [], random: seeded(seed) })).toHaveLength(3);
    }
  });

  it("when every deck was dealt recently, the least recently dealt come back first", () => {
    const decks = pool().slice(0, 6);
    const recent = ["deck-5", "deck-4", "deck-3", "deck-2", "deck-1", "deck-0"]; // deck-0 dealt longest ago
    const picks = pickAgentDecks(decks, { count: 3, hostTags: [], recent, random: seeded(3) });
    expect(picks.map((d) => d.id)).toEqual(["deck-0", "deck-1", "deck-2"]);
  });

  it("fresh decks are drawn before any recent one", () => {
    const decks = pool().slice(0, 5);
    const picks = pickAgentDecks(decks, { count: 3, hostTags: [], recent: ["deck-0", "deck-1", "deck-2"], random: seeded(9) });
    expect(picks.slice(0, 2).map((d) => d.id).sort()).toEqual(["deck-3", "deck-4"]);
    expect(picks[2]!.id).toBe("deck-2"); // then the least recently dealt
  });

  it("variety is a preference: a deck repeating the table's strategies is less likely, never impossible", () => {
    expect(tagOverlap([], new Set())).toBe(0.5);
    expect(tagOverlap(["tokens", "counters"], new Set<ArchetypeTag>(["tokens"]))).toBe(0.5);
    expect(pickWeight(["tokens"], new Set<ArchetypeTag>(["tokens"]))).toBe(0.25);
    expect(pickWeight(["voltron"], new Set<ArchetypeTag>(["tokens"]))).toBe(1);
  });

  it("remembers a bounded, newest-first list", () => {
    expect(rememberDeal(["a", "b", "c"], ["d", "b"])).toEqual(["d", "b", "a", "c"]);
    const long = Array.from({ length: RECENT_DECKS_MAX + 10 }, (_, i) => `x${i}`);
    expect(rememberDeal(long, ["new"])).toHaveLength(RECENT_DECKS_MAX);
  });
});
