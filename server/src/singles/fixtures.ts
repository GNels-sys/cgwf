import type { SinglesListing } from "@cgwf/shared";

/** A Singles listing with sensible defaults, for tests. */
export function listing(over: Partial<SinglesListing> = {}): SinglesListing {
  return {
    storeId: "power9",
    storeName: "Power 9 Games",
    storeWebsite: "https://www.power9games.com",
    finish: "nonfoil",
    condition: "NM",
    price: 1.99,
    currency: "USD",
    quantity: 2,
    url: "https://www.power9games.com/products/search?q=Sol%20Ring",
    urlKind: "search",
    searchUrl: "https://www.power9games.com/products/search?q=Sol%20Ring",
    setName: "Commander Legends",
    scryfallId: null,
    lastSeen: "2026-10-16T15:30:00.000Z",
    ...over,
  };
}
