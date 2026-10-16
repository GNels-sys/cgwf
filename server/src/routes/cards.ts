import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { CardResponse, SearchResponse, StatusResponse } from "@cgwf/shared";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";
import { rowToPrinting, rowToSummary } from "../scryfall/map.js";
import type { Ingestor } from "../scryfall/ingest.js";
import { META_BULK_UPDATED, META_LAST_INGEST } from "../scryfall/ingest.js";
import type { NameIndex } from "../search/index.js";

export interface CardRouteDeps {
  handle: DbHandle;
  index: NameIndex;
  ingestor: Ingestor;
}

export function registerCardRoutes(app: FastifyInstance, deps: CardRouteDeps): void {
  const { handle, index, ingestor } = deps;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async (): Promise<StatusResponse> => ({
    ok: true,
    cardCount: ingestor.cardCount(),
    lastIngestAt: handle.getMeta(META_LAST_INGEST),
    bulkUpdatedAt: handle.getMeta(META_BULK_UPDATED),
    ingestRunning: ingestor.state.running,
    ingestProgress: ingestor.state.progress,
    ingestError: ingestor.state.error,
    version: config.appVersion,
  }));

  app.get<{ Querystring: { q?: string; tokens?: string; limit?: string } }>(
    "/api/cards/search",
    async (req): Promise<SearchResponse> => {
      const q = (req.query.q ?? "").slice(0, 80);
      const tokens = req.query.tokens === "1" || req.query.tokens === "true";
      const limit = Number(req.query.limit ?? 30);
      const hits = index.search(q, { tokens, limit: Number.isFinite(limit) ? limit : 30 });
      if (hits.length === 0) return { query: q, results: [] };
      const rows = handle.db
        .select()
        .from(cards)
        .where(inArray(cards.id, hits.map((h) => h.id)))
        .all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const results = hits.flatMap((h) => {
        const row = byId.get(h.id);
        return row ? [rowToSummary(row)] : [];
      });
      return { query: q, results };
    },
  );

  app.get<{ Params: { id: string } }>("/api/cards/:id", async (req, reply): Promise<CardResponse | void> => {
    const row = handle.db.select().from(cards).where(eq(cards.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: "card not found" });
    return { card: rowToPrinting(row) };
  });

  /** Every printing of a card, newest first (used by deck import and the printing picker). */
  app.get<{ Params: { oracleId: string } }>("/api/cards/oracle/:oracleId/printings", async (req) => {
    const rows = handle.db
      .select()
      .from(cards)
      .where(and(eq(cards.oracleId, req.params.oracleId), eq(cards.isDigital, false)))
      .orderBy(desc(cards.releasedAt), asc(cards.collectorNumber))
      .all();
    return { printings: rows.map(rowToSummary) };
  });

  /**
   * Manual ingest trigger. Allowed from the machine itself (the CLI calls it over
   * loopback) or with the ADMIN_TOKEN secret. Returns immediately; poll /api/status.
   */
  app.post<{ Body: { force?: boolean } | null }>("/api/admin/ingest", async (req, reply) => {
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const token = req.headers["x-admin-token"];
    const authorised = isLoopback || (config.adminToken !== "" && token === config.adminToken);
    if (!authorised) return reply.code(403).send({ error: "forbidden" });
    if (ingestor.state.running) return reply.code(409).send({ error: "ingest already running", state: ingestor.state });
    void ingestor.run({ force: Boolean(req.body?.force) });
    return reply.code(202).send({ started: true });
  });
}
