import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { DeckAnalysisResponse } from "@cgwf/shared";
import { rateLimitKey, requireUser } from "../auth.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import type { DbHandle } from "../db/index.js";
import { decks } from "../db/schema.js";

interface Deps {
  handle: DbHandle;
  analyzer: DeckAnalyzer;
}

/**
 * GET /api/decks/:id/analysis[?refresh=1]
 * Bracket floor + suggestion + reasons + archetype tags for one of the caller's
 * decks. Recomputed on every call (the engine is cheap); only the Commander
 * Spellbook answer is cached per exact card list. `refresh=1` re-asks Spellbook.
 */
export function registerAnalysisRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, analyzer } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    "/api/decks/:id/analysis",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator } } },
    async (req, reply): Promise<DeckAnalysisResponse | void> => {
      const deck = handle.db
        .select({ id: decks.id })
        .from(decks)
        .where(and(eq(decks.id, req.params.id), eq(decks.userId, req.user!.id)))
        .get();
      if (!deck) return reply.code(404).send({ error: "deck not found" });
      const cards = analyzer.loadDeckCards(deck.id);
      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const result = await analyzer.analyze(cards, { combos: refresh ? "refresh" : "cached" });
      return { analysis: result.analysis, combosCached: result.combosCached };
    },
  );
}
