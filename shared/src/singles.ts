import type { PurchaseLinks } from "./cards.js";

/**
 * Phase 10: the local-stores bridge. CGwF asks the owner's Singles site
 * (vegas-mtg, Las Vegas store inventory) which stores have a card in stock and
 * shows the answer with outbound links. CGwF never sells anything: every link
 * leaves the app and goes to the store (or to Scryfall's marketplaces).
 *
 * The first half mirrors the Singles service API (`/api/v1/*`) so the two
 * apps never disagree on field names; the second half is what CGwF serves.
 */

export type SinglesFinish = "nonfoil" | "foil" | "etched";

/** One in-stock offer at one store, as the Singles API reports it. */
export interface SinglesListing {
  storeId: string;
  storeName: string;
  storeWebsite: string;
  finish: SinglesFinish | string;
  /** NM | LP | MP | HP | DMG, or null when the store does not say. */
  condition: string | null;
  price: number | null;
  currency: string;
  /** null when the store hides counts. */
  quantity: number | null;
  /** Product page, the catalog page the card sits on, or a name search on the store site. */
  url: string;
  urlKind: "product" | "page" | "search";
  searchUrl: string;
  setName: string | null;
  scryfallId: string | null;
  /** When that store was last scraped (ISO). */
  lastSeen: string;
}

export interface SinglesStore {
  id: string;
  name: string;
  website: string;
  platform: string;
  city: string | null;
  state: string | null;
  address: string | null;
  lastRefresh: string | null;
  listingCount: number;
}

export interface SinglesAvailabilityCard {
  oracleId: string;
  name: string;
  listings: SinglesListing[];
}

/** POST /api/v1/availability on the Singles site. */
export interface SinglesAvailabilityResponse {
  dataAsOf: string | null;
  source: string;
  requested: number;
  cards: Record<string, SinglesAvailabilityCard>;
}

/** GET /api/v1/stores on the Singles site. */
export interface SinglesStoresResponse {
  dataAsOf: string | null;
  source: string;
  stores: SinglesStore[];
}

/* ------------------------------------------------------------------ */
/* What CGwF serves                                                    */
/* ------------------------------------------------------------------ */

/** The label every bridge response carries, so the UI can say where the data came from. */
export const LOCAL_STORES_SOURCE = "local stores" as const;

/**
 * ok           = fresh or cached answer from the Singles site
 * unavailable  = the Singles site did not answer in time (timeout, error, breaker open)
 * unconfigured = SINGLES_API_URL / SINGLES_API_TOKEN are not set on this server
 */
export type BridgeStatus = "ok" | "unavailable" | "unconfigured";

export interface BridgeMeta {
  status: BridgeStatus;
  /** Short reason when status is not ok. */
  reason?: string;
  source: typeof LOCAL_STORES_SOURCE;
  /** The Singles site's own "data as of" (newest scrape); null when not ok. */
  dataAsOf: string | null;
  /** When CGwF fetched this answer from the Singles site; null when not ok. */
  fetchedAt: string | null;
  /** True when the answer came from CGwF's in-memory cache. */
  cached: boolean;
}

export interface StoreRef {
  id: string;
  name: string;
  website: string;
}

/** One store's offers for one card, cheapest first. */
export interface StoreOffers {
  store: StoreRef;
  cheapest: number | null;
  listings: SinglesListing[];
}

/** GET /api/cards/:id/availability */
export interface CardAvailabilityResponse extends BridgeMeta {
  card: { id: string; oracleId: string | null; name: string };
  /** Stores that have the card, cheapest store first. Empty when none (or when not ok). */
  stores: StoreOffers[];
  /** Scryfall's marketplace links for this printing (the fallback when no local store has it). */
  purchaseLinks: PurchaseLinks | null;
}

export interface ShoppingPick {
  storeId: string;
  storeName: string;
  price: number | null;
  finish: string;
  condition: string | null;
  url: string;
}

/** One deck entry with its best local option. */
export interface ShoppingCard {
  cardId: string;
  oracleId: string | null;
  name: string;
  quantity: number;
  board: string;
  /** Cheapest in-stock listing anywhere, or null when no local store has it. */
  cheapest: ShoppingPick | null;
  /** Ids of every store with the card in stock. */
  storeIds: string[];
  purchaseLinks: PurchaseLinks | null;
}

/** How much of the deck one store can supply. */
export interface ShoppingStore {
  store: StoreRef;
  /** Distinct deck entries this store has in stock. */
  cardsCovered: number;
  cardsTotal: number;
  /** Sum of (cheapest price at this store x quantity needed) over the covered cards. */
  total: number;
  /** Names of the deck entries this store does not have. */
  missing: string[];
}

export interface ShoppingSummary {
  cardsTotal: number;
  cardsAvailable: number;
  cardsMissing: number;
  /** Sum over available cards of the cheapest price anywhere x quantity. */
  cheapestAnywhereTotal: number;
  missingNames: string[];
}

/** GET /api/decks/:id/shopping and GET /api/library/:id/shopping */
export interface ShoppingReport extends BridgeMeta {
  deck: { id: string; name: string; cardCount: number };
  cards: ShoppingCard[];
  /** Every store, most coverage first (then cheapest total). */
  stores: ShoppingStore[];
  /** The store that covers the most of the deck (ties: cheaper total); null when none has anything. */
  bestStore: ShoppingStore | null;
  summary: ShoppingSummary;
}

/** GET /api/stores */
export interface StoresResponse extends BridgeMeta {
  stores: SinglesStore[];
}
