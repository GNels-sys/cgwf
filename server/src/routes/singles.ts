import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { BridgeMeta, CardAvailabilityResponse, ShoppingReport, StoresResponse } from "@cgwf/shared";
import { rateLimitKey, requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks } from "../db/schema.js";
import type { LibraryService } from "../library/service.js";
import { toPurchaseLinks } from "../scryfall/map.js";
import type { SinglesClient, SinglesResult } from "../singles/client.js";
import { buildShoppingReport, groupByStore, type AvailabilityMeta, type DeckEntryForShopping } from "../singles/shopping.js";

export interface SinglesRouteDeps {
  handle: DbHandle;
  singles: SinglesClient;
  library: LibraryService;
}

/** The bridge fields every response carries, from a client result. `data` is null unless status is ok. */
function metaOf<T>(r: SinglesResult<T>, dataAsOf: (d: T) => string | null): AvailabilityMeta & { data: T | null } {
  if (r.status === "ok") return { status: "ok", dataAsOf: dataAsOf(r.data), fetchedAt: r.fetchedAt, cached: r.cached, data: r.data };
  return { status: r.status, reason: r.reason, dataAsOf: null, fetchedAt: null, cached: false, data: null };
}

/** Just the meta, without `data`, for spreading into a response. */
function bare(m: AvailabilityMeta & { data: unknown }): Omit<BridgeMeta, "source"> {
  return { status: m.status, ...(m.reason !== undefined ? { reason: m.reason } : {}), dataAsOf: m.dataAsOf, fetchedAt: m.fetchedAt, cached: m.cached };
}

/**
 * Phase 10 "local stores" bridge. Read-only, signed-in users only, rate-limited.
 *   GET /api/cards/:id/availability   one printing -> stores that stock the card (any printing), cheapest first
 *   GET /api/decks/:id/shopping       own deck -> cheapest local option per card, per-store coverage, best single store
 *   GET /api/library/:id/shopping     same for a library deck (owner)
 *   GET /api/stores                   the Singles site's active stores (cached)
 * Nothing here sells anything: every URL in a response leaves CGwF for the store's own site.
 */
export function registerSinglesRoutes(app: FastifyInstance, deps: SinglesRouteDeps): void {
  const { handle, singles, library } = deps;
  const auth = requireUser(handle);
  const owner = [auth, requireOwner(handle)];
  const keyGenerator = rateLimitKey(handle);
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute", keyGenerator } });

  app.get<{ Params: { id: string } }>("/api/cards/:id/availability", { preHandler: auth, config: limit(60) }, async (req, reply): Promise<CardAvailabilityResponse | void> => {
    const row = handle.db.select().from(cards).where(eq(cards.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: "card not found" });
    const purchaseLinks = toPurchaseLinks(row.purchaseUris);
    const base = { card: { id: row.id, oracleId: row.oracleId, name: row.name }, source: "local stores" as const, purchaseLinks };
    if (!row.oracleId) return { ...base, status: "ok", dataAsOf: null, fetchedAt: null, cached: false, stores: [] };
    const m = metaOf(await singles.availability([row.oracleId]), (d) => d.dataAsOf);
    const listings = m.data?.cards[row.oracleId.toLowerCase()]?.listings ?? [];
    return { ...base, ...bare(m), stores: groupByStore(listings) };
  });

  app.get<{ Params: { id: string } }>("/api/decks/:id/shopping", { preHandler: auth, config: limit(30) }, async (req, reply): Promise<ShoppingReport | void> => {
    const deck = handle.db
      .select({ id: decks.id, name: decks.name })
      .from(decks)
      .where(and(eq(decks.id, req.params.id), eq(decks.userId, req.user!.id)))
      .get();
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const rows = handle.db
      .select({ dc: deckCards, card: cards })
      .from(deckCards)
      .innerJoin(cards, eq(cards.id, deckCards.cardId))
      .where(eq(deckCards.deckId, deck.id))
      .orderBy(deckCards.position)
      .all();
    const entries = toEntries(rows.map((r) => ({ cardId: r.dc.cardId, quantity: r.dc.quantity, board: r.dc.board, card: r.card })));
    return shopping(deck, entries);
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/shopping", { preHandler: owner, config: limit(30) }, async (req, reply): Promise<ShoppingReport | void> => {
    const row = library.getRow(req.params.id);
    if (!row) return reply.code(404).send({ error: "library deck not found" });
    const list = library.entries(row.id);
    const ids = [...new Set(list.map((e) => e.cardId))];
    const cardRows = ids.length ? handle.db.select().from(cards).where(inArray(cards.id, ids)).all() : [];
    const byId = new Map(cardRows.map((c) => [c.id, c]));
    const entries = toEntries(list.flatMap((e) => (byId.has(e.cardId) ? [{ cardId: e.cardId, quantity: e.quantity, board: e.board, card: byId.get(e.cardId)! }] : [])));
    return shopping({ id: row.id, name: row.name }, entries);
  });

  app.get("/api/stores", { preHandler: auth, config: limit(30) }, async (): Promise<StoresResponse> => {
    const m = metaOf(await singles.stores(), (d) => d.dataAsOf);
    return { ...bare(m), source: "local stores", stores: m.data?.stores ?? [] };
  });

  /** Main + commander entries only (sideboards and maybeboards are not shopping lists), one per printing. */
  function toEntries(rows: Array<{ cardId: string; quantity: number; board: string; card: typeof cards.$inferSelect }>): DeckEntryForShopping[] {
    return rows
      .filter((r) => r.board === "main" || r.board === "commander")
      .map((r) => ({ cardId: r.cardId, oracleId: r.card.oracleId?.toLowerCase() ?? null, name: r.card.name, quantity: r.quantity, board: r.board, purchaseLinks: toPurchaseLinks(r.card.purchaseUris) }));
  }

  async function shopping(deck: { id: string; name: string }, entries: DeckEntryForShopping[]): Promise<ShoppingReport> {
    const oracleIds = [...new Set(entries.map((e) => e.oracleId).filter((v): v is string => Boolean(v)))];
    const m = metaOf(await singles.availability(oracleIds), (d) => d.dataAsOf);
    return buildShoppingReport(deck, entries, m.data, bare(m));
  }
}
