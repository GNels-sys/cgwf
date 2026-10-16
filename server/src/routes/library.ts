import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isArchetypeTag, isBracket, type LibraryDeckDetail, type LibraryListResponse, type LibraryPatchRequest } from "@cgwf/shared";
import { requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { deckCards, decks } from "../db/schema.js";
import type { PreconImporter } from "../library/precons.js";
import type { LibraryEntry, LibraryService } from "../library/service.js";

interface Deps {
  handle: DbHandle;
  library: LibraryService;
  precons: PreconImporter;
}

/**
 * Owner-only deck library.
 *   GET    /api/library?bracket=&tag=&q=&source=&agent=    list + import state
 *   POST   /api/library/import-precons {force?, combos?}   background MTGJSON import (202)
 *   GET    /api/library/import-status
 *   POST   /api/library/from-deck/:deckId                  copy one of the owner's decks in
 *   GET    /api/library/:id
 *   PATCH  /api/library/:id {name, bracket, tags, primer, agentEligible}
 *   DELETE /api/library/:id
 *   POST   /api/library/:id/analyze                        re-run the engine (+ Spellbook)
 *   GET    /api/library/:id/primer-skeleton
 */
export function registerLibraryRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, library, precons } = deps;
  // requireUser first so req.user is set; requireOwner then checks users.is_owner (Phase 5).
  const owner = [requireUser(handle), requireOwner(handle)];

  app.get<{ Querystring: { bracket?: string; tag?: string; q?: string; source?: string; agent?: string } }>("/api/library", { preHandler: owner }, async (req): Promise<LibraryListResponse> => {
    const bracket = Number(req.query.bracket);
    const tag = req.query.tag;
    const source = req.query.source;
    return {
      decks: library.list({
        bracket: isBracket(bracket) ? bracket : undefined,
        tag: isArchetypeTag(tag) ? tag : undefined,
        q: req.query.q?.trim().slice(0, 60) || undefined,
        source: source === "precon" || source === "user" ? source : undefined,
        agentEligible: req.query.agent === "1" ? true : req.query.agent === "0" ? false : undefined,
      }),
      importState: precons.state,
    };
  });

  app.get("/api/library/import-status", { preHandler: owner }, async () => ({ importState: precons.state }));

  app.post<{ Body: { force?: boolean; combos?: boolean } | null }>("/api/library/import-precons", { preHandler: owner }, async (req, reply) => {
    if (precons.state.running) return reply.code(409).send({ error: "import already running", importState: precons.state });
    void precons.run({ force: Boolean(req.body?.force), combos: req.body?.combos !== false });
    return reply.code(202).send({ started: true, importState: precons.state });
  });

  app.post<{ Params: { deckId: string }; Body: { name?: string } | null }>("/api/library/from-deck/:deckId", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const deck = handle.db
      .select()
      .from(decks)
      .where(and(eq(decks.id, req.params.deckId), eq(decks.userId, req.user!.id)))
      .get();
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const existing = library.bySourceKey(`deck:${deck.id}`);
    if (existing) return reply.code(409).send({ error: "this deck is already in the library", id: existing.id });
    const rows = handle.db.select().from(deckCards).where(eq(deckCards.deckId, deck.id)).orderBy(deckCards.position).all();
    const entries: LibraryEntry[] = rows
      .filter((r) => r.board === "main" || r.board === "commander" || r.board === "sideboard")
      .map((r) => ({ cardId: r.cardId, quantity: r.quantity, board: r.board as LibraryEntry["board"] }));
    if (entries.length === 0) return reply.code(400).send({ error: "deck has no cards" });
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : deck.name;
    const created = await library.create({ name, source: "user", sourceKey: `deck:${deck.id}`, createdBy: req.user!.id, entries }, { combos: "cached" });
    return reply.code(201).send({ deck: created });
  });

  app.get<{ Params: { id: string } }>("/api/library/:id", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const deck = library.detail(req.params.id);
    if (!deck) return reply.code(404).send({ error: "library deck not found" });
    return { deck };
  });

  app.patch<{ Params: { id: string }; Body: LibraryPatchRequest }>("/api/library/:id", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const r = library.patch(req.params.id, req.body ?? {});
    if (!r.ok) return reply.code(r.error.includes("not found") ? 404 : 400).send({ error: r.error });
    return { deck: r.deck };
  });

  app.delete<{ Params: { id: string } }>("/api/library/:id", { preHandler: owner }, async (req, reply) => {
    if (!library.remove(req.params.id)) return reply.code(404).send({ error: "library deck not found" });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/library/:id/analyze", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const deck = await library.reanalyze(req.params.id, { combos: "refresh" });
    if (!deck) return reply.code(404).send({ error: "library deck not found" });
    return { deck };
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/primer-skeleton", { preHandler: owner }, async (req, reply): Promise<{ primer: string } | void> => {
    const primer = library.primerSkeleton(req.params.id);
    if (primer === null) return reply.code(404).send({ error: "library deck not found" });
    return { primer };
  });
}
