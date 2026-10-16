import { describe, expect, it } from "vitest";
import type { SinglesAvailabilityResponse } from "@cgwf/shared";
import { listing } from "./fixtures.js";
import { buildShoppingReport, cheapestListing, groupByStore, type DeckEntryForShopping } from "./shopping.js";

const SOL = "11111111-0000-4000-8000-000000000001";
const BOLT = "11111111-0000-4000-8000-000000000002";
const FOREST = "11111111-0000-4000-8000-000000000003";
const SIGNET = "11111111-0000-4000-8000-000000000004";

const P9 = { storeId: "power9", storeName: "Power 9 Games", storeWebsite: "https://www.power9games.com" };
const SG = { storeId: "stomping-grounds", storeName: "Stomping Grounds", storeWebsite: "https://singles.stompinggroundstcg.com" };

/**
 * Fixture deck: Sol Ring x1 (both stores), Lightning Bolt x1 (Power 9 only, foil cheaper than
 * nonfoil), Forest x3 (Stomping Grounds only, 0.25 each), Arcane Signet x1 (nowhere).
 * Hand-worked expectations:
 *   cheapest anywhere: Sol Ring 1.50 (SG) + Bolt 0.80 (P9 foil) + Forest 3 x 0.25 = 0.75 -> 3.05
 *   Power 9: covers Sol Ring (1.99) + Bolt (0.80) = 2 cards, 2.79; missing Forest, Arcane Signet
 *   Stomping Grounds: covers Sol Ring (1.50) + Forest (0.75) = 2 cards, 2.25; missing Bolt, Signet
 *   best store = Stomping Grounds (tie on coverage, cheaper total)
 */
const entries: DeckEntryForShopping[] = [
  { cardId: "p-sol", oracleId: SOL, name: "Sol Ring", quantity: 1, board: "main", purchaseLinks: { tcgplayer: "https://t/sol", cardmarket: null, cardhoarder: null } },
  { cardId: "p-bolt", oracleId: BOLT, name: "Lightning Bolt", quantity: 1, board: "main", purchaseLinks: null },
  { cardId: "p-forest", oracleId: FOREST, name: "Forest", quantity: 3, board: "main", purchaseLinks: null },
  { cardId: "p-signet", oracleId: SIGNET, name: "Arcane Signet", quantity: 1, board: "commander", purchaseLinks: null },
];

const answer: SinglesAvailabilityResponse = {
  dataAsOf: "2026-10-16T15:30:00.000Z",
  source: "vegas-mtg",
  requested: 4,
  cards: {
    [SOL]: { oracleId: SOL, name: "Sol Ring", listings: [listing({ ...P9, price: 1.99 }), listing({ ...SG, price: 1.5, condition: "LP" }), listing({ ...P9, price: 5.0, finish: "foil" })] },
    [BOLT]: { oracleId: BOLT, name: "Lightning Bolt", listings: [listing({ ...P9, price: 1.2 }), listing({ ...P9, price: 0.8, finish: "foil", condition: "MP" })] },
    [FOREST]: { oracleId: FOREST, name: "Forest", listings: [listing({ ...SG, price: 0.25, quantity: null })] },
    [SIGNET]: { oracleId: SIGNET, name: "", listings: [] },
  },
};

const meta = { status: "ok" as const, dataAsOf: answer.dataAsOf, fetchedAt: "2026-10-16T16:00:00.000Z", cached: false };

describe("groupByStore / cheapestListing", () => {
  it("groups one card's listings by store, cheapest store first, listings cheapest first", () => {
    const groups = groupByStore(answer.cards[SOL]!.listings);
    expect(groups.map((g) => g.store.id)).toEqual(["stomping-grounds", "power9"]);
    expect(groups[1]?.cheapest).toBe(1.99);
    expect(groups[1]?.listings.map((l) => l.price)).toEqual([1.99, 5.0]);
  });

  it("picks the lowest price regardless of finish and condition; unpriced listings sort last", () => {
    expect(cheapestListing(answer.cards[BOLT]!.listings)?.price).toBe(0.8);
    expect(cheapestListing([listing({ price: null }), listing({ price: 2 })])?.price).toBe(2);
    expect(cheapestListing([])).toBeNull();
  });
});

describe("buildShoppingReport", () => {
  it("works out the cheapest option per card, per-store coverage and the best single store", () => {
    const r = buildShoppingReport({ id: "d1", name: "Test deck" }, entries, answer, meta);
    expect(r.status).toBe("ok");
    expect(r.source).toBe("local stores");
    expect(r.deck).toEqual({ id: "d1", name: "Test deck", cardCount: 6 });
    expect(r.summary).toEqual({ cardsTotal: 4, cardsAvailable: 3, cardsMissing: 1, cheapestAnywhereTotal: 3.05, missingNames: ["Arcane Signet"] });

    const sol = r.cards.find((c) => c.name === "Sol Ring")!;
    expect(sol.cheapest).toMatchObject({ storeId: "stomping-grounds", price: 1.5, condition: "LP" });
    expect(sol.storeIds.sort()).toEqual(["power9", "stomping-grounds"]);
    expect(sol.purchaseLinks?.tcgplayer).toBe("https://t/sol");
    const bolt = r.cards.find((c) => c.name === "Lightning Bolt")!;
    expect(bolt.cheapest).toMatchObject({ storeId: "power9", price: 0.8, finish: "foil" });
    const signet = r.cards.find((c) => c.name === "Arcane Signet")!;
    expect(signet.cheapest).toBeNull();
    expect(signet.storeIds).toEqual([]);

    expect(r.stores.map((s) => [s.store.id, s.cardsCovered, s.total])).toEqual([
      ["stomping-grounds", 2, 2.25],
      ["power9", 2, 2.79],
    ]);
    expect(r.stores[0]?.missing).toEqual(["Lightning Bolt", "Arcane Signet"]);
    expect(r.stores[0]?.cardsTotal).toBe(4);
    expect(r.bestStore?.store.name).toBe("Stomping Grounds");
  });

  it("with no answer every card is missing, no stores are listed and the status is carried through", () => {
    const r = buildShoppingReport({ id: "d1", name: "Test deck" }, entries, null, { status: "unavailable", reason: "singles timeout", dataAsOf: null, fetchedAt: null, cached: false });
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("singles timeout");
    expect(r.stores).toEqual([]);
    expect(r.bestStore).toBeNull();
    expect(r.summary.cardsAvailable).toBe(0);
    expect(r.summary.missingNames).toHaveLength(4);
    expect(r.cards.every((c) => c.cheapest === null)).toBe(true);
    expect(r.cards[0]?.purchaseLinks?.tcgplayer).toBe("https://t/sol"); // fallback links survive an outage
  });

  it("a card without an oracle id is simply missing", () => {
    const r = buildShoppingReport({ id: "d", name: "d" }, [{ cardId: "x", oracleId: null, name: "Odd printing", quantity: 1, board: "main", purchaseLinks: null }], answer, meta);
    expect(r.summary.missingNames).toEqual(["Odd printing"]);
    expect(r.stores).toEqual([]);
  });
});
