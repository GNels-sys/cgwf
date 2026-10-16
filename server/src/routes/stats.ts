import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DeckStats, DeckStatsResponse } from "@cgwf/shared";
import { rateLimitKey, requireOwner, requireUser } from "../auth.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import { computeStats } from "../analysis/stats.js";
import type { DbHandle } from "../db/index.js";
import { decks } from "../db/schema.js";
import type { LibraryService } from "../library/service.js";

interface Deps {
  handle: DbHandle;
  analyzer: DeckAnalyzer;
  library: LibraryService;
}

/**
 * In-memory cache of computed stats, keyed by deck and stamped with the deck's
 * version (`updatedAt`, which every card change bumps). Nothing is stored in
 * the database (Phase 8 owns migrations this round); a restart simply recomputes
 * on the next view, which takes well under a millisecond per deck.
 */
export class StatsCache {
  private readonly entries = new Map<string, { version: string; stats: DeckStats }>();
  constructor(private readonly max = 300) {}

  get(key: string, version: string): DeckStats | null {
    const e = this.entries.get(key);
    if (!e || e.version !== version) return null;
    // Refresh insertion order so the oldest-viewed deck is evicted first.
    this.entries.delete(key);
    this.entries.set(key, e);
    return e.stats;
  }

  set(key: string, version: string, stats: DeckStats): void {
    this.entries.delete(key);
    this.entries.set(key, { version, stats });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * GET /api/decks/:id/stats     (signed in, own deck)
 * GET /api/library/:id/stats   (owner)
 * -> {stats, cached}. Pure computation over the deck's cards (main + commander).
 */
export function registerStatsRoutes(app: FastifyInstance, deps: Deps, cache = new StatsCache()): StatsCache {
  const { handle, analyzer, library } = deps;
  const auth = requireUser(handle);
  const owner = [auth, requireOwner(handle)];
  const keyGenerator = rateLimitKey(handle);
  const limit = { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator } };

  app.get<{ Params: { id: string } }>("/api/decks/:id/stats", { preHandler: auth, config: limit }, async (req, reply): Promise<DeckStatsResponse | void> => {
    const deck = handle.db
      .select({ id: decks.id, updatedAt: decks.updatedAt })
      .from(decks)
      .where(and(eq(decks.id, req.params.id), eq(decks.userId, req.user!.id)))
      .get();
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const key = `deck:${deck.id}`;
    const hit = cache.get(key, deck.updatedAt);
    if (hit) return { stats: hit, cached: true };
    const stats = computeStats(analyzer.loadDeckCards(deck.id));
    cache.set(key, deck.updatedAt, stats);
    return { stats, cached: false };
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/stats", { preHandler: owner, config: limit }, async (req, reply): Promise<DeckStatsResponse | void> => {
    const row = library.getRow(req.params.id);
    if (!row) return reply.code(404).send({ error: "library deck not found" });
    const key = `library:${row.id}`;
    const hit = cache.get(key, row.updatedAt);
    if (hit) return { stats: hit, cached: true };
    const stats = computeStats(analyzer.loadCardsByIds(library.entries(row.id)));
    cache.set(key, row.updatedAt, stats);
    return { stats, cached: false };
  });

  return cache;
}
