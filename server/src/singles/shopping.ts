import type {
  CardAvailabilityResponse,
  PurchaseLinks,
  ShoppingCard,
  ShoppingReport,
  ShoppingStore,
  SinglesAvailabilityResponse,
  SinglesListing,
  StoreOffers,
  StoreRef,
} from "@cgwf/shared";

/**
 * Pure aggregation over a Singles availability answer. No I/O, so it is unit
 * tested on its own. Prices are the store's listed price; a card's "cheapest"
 * is the lowest-priced in-stock listing (any finish or condition), and a deck
 * total multiplies that by the quantity needed. Stock counts are not enforced
 * (a store may list fewer copies than a deck wants); the UI shows the listing's
 * quantity so the player can judge.
 */

export interface DeckEntryForShopping {
  cardId: string;
  oracleId: string | null;
  name: string;
  quantity: number;
  board: string;
  purchaseLinks: PurchaseLinks | null;
}

const byPrice = (a: SinglesListing, b: SinglesListing) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.storeName.localeCompare(b.storeName);

function storeRef(l: SinglesListing): StoreRef {
  return { id: l.storeId, name: l.storeName, website: l.storeWebsite };
}

/** Group one card's listings by store, cheapest store first. */
export function groupByStore(listings: SinglesListing[]): StoreOffers[] {
  const groups = new Map<string, StoreOffers>();
  for (const l of listings.slice().sort(byPrice)) {
    let g = groups.get(l.storeId);
    if (!g) {
      g = { store: storeRef(l), cheapest: null, listings: [] };
      groups.set(l.storeId, g);
    }
    g.listings.push(l);
    if (l.price != null && (g.cheapest == null || l.price < g.cheapest)) g.cheapest = l.price;
  }
  return [...groups.values()].sort((a, b) => (a.cheapest ?? Infinity) - (b.cheapest ?? Infinity) || a.store.name.localeCompare(b.store.name));
}

/** The lowest-priced in-stock listing, or the first unpriced one when nothing has a price. */
export function cheapestListing(listings: SinglesListing[]): SinglesListing | null {
  if (listings.length === 0) return null;
  return listings.slice().sort(byPrice)[0] ?? null;
}

export type AvailabilityMeta = Pick<CardAvailabilityResponse, "status" | "dataAsOf" | "fetchedAt" | "cached"> & { reason?: string | undefined };

/** Build the deck shopping report from the deck's entries and the Singles answer (null when not ok). */
export function buildShoppingReport(
  deck: { id: string; name: string },
  entries: DeckEntryForShopping[],
  answer: SinglesAvailabilityResponse | null,
  meta: AvailabilityMeta,
): ShoppingReport {
  const cards: ShoppingCard[] = [];
  const storesById = new Map<string, { store: StoreRef; covered: number; total: number; missing: string[] }>();
  const allStoreIds = new Set<string>();

  // First pass: find every store that appears anywhere, so coverage lists the misses too.
  if (answer) {
    for (const e of entries) {
      const listings = e.oracleId ? (answer.cards[e.oracleId]?.listings ?? []) : [];
      for (const l of listings) {
        allStoreIds.add(l.storeId);
        if (!storesById.has(l.storeId)) storesById.set(l.storeId, { store: storeRef(l), covered: 0, total: 0, missing: [] });
      }
    }
  }

  let cardsAvailable = 0;
  let cheapestAnywhereTotal = 0;
  const missingNames: string[] = [];

  for (const e of entries) {
    const listings = answer && e.oracleId ? (answer.cards[e.oracleId]?.listings ?? []) : [];
    const cheapest = cheapestListing(listings);
    const storeIds = [...new Set(listings.map((l) => l.storeId))];
    cards.push({
      cardId: e.cardId,
      oracleId: e.oracleId,
      name: e.name,
      quantity: e.quantity,
      board: e.board,
      cheapest: cheapest
        ? { storeId: cheapest.storeId, storeName: cheapest.storeName, price: cheapest.price, finish: cheapest.finish, condition: cheapest.condition, url: cheapest.url }
        : null,
      storeIds,
      purchaseLinks: e.purchaseLinks,
    });
    if (cheapest) {
      cardsAvailable++;
      cheapestAnywhereTotal += (cheapest.price ?? 0) * e.quantity;
    } else {
      missingNames.push(e.name);
    }
    // Per-store coverage and totals.
    const perStoreCheapest = new Map<string, SinglesListing>();
    for (const l of listings.slice().sort(byPrice)) if (!perStoreCheapest.has(l.storeId)) perStoreCheapest.set(l.storeId, l);
    for (const [storeId, s] of storesById) {
      const pick = perStoreCheapest.get(storeId);
      if (pick) {
        s.covered++;
        s.total += (pick.price ?? 0) * e.quantity;
      } else {
        s.missing.push(e.name);
      }
    }
  }

  const round = (n: number) => Math.round(n * 100) / 100;
  const stores: ShoppingStore[] = [...storesById.values()]
    .map((s) => ({ store: s.store, cardsCovered: s.covered, cardsTotal: entries.length, total: round(s.total), missing: s.missing }))
    .sort((a, b) => b.cardsCovered - a.cardsCovered || a.total - b.total || a.store.name.localeCompare(b.store.name));

  return {
    status: meta.status,
    ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
    source: "local stores",
    dataAsOf: meta.dataAsOf,
    fetchedAt: meta.fetchedAt,
    cached: meta.cached,
    deck: { id: deck.id, name: deck.name, cardCount: entries.reduce((n, e) => n + e.quantity, 0) },
    cards,
    stores,
    bestStore: stores.find((s) => s.cardsCovered > 0) ?? null,
    summary: {
      cardsTotal: entries.length,
      cardsAvailable,
      cardsMissing: entries.length - cardsAvailable,
      cheapestAnywhereTotal: round(cheapestAnywhereTotal),
      missingNames,
    },
  };
}
