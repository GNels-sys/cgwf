import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { isArchetypeTag, isBracket, isLibrarySource, type LibraryDeckDetail, type LibraryListResponse, type LibraryPatchRequest } from "@cgwf/shared";
import { requireOwner, requireUser } from "../auth.js";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { deckCards, decks } from "../db/schema.js";
import type { EdhrecImporter } from "../library/edhrec/importer.js";
import type { PreconImporter } from "../library/precons.js";
import type { LibraryEntry, LibraryService } from "../library/service.js";
import type { LibraryCoverage } from "../library/coverage.js";

interface Deps {
  handle: DbHandle;
  library: LibraryService;
  precons: PreconImporter;
  edhrec: EdhrecImporter;
  coverage: LibraryCoverage;
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
  const { handle, library, precons, edhrec, coverage } = deps;
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
        source: isLibrarySource(source) ? source : undefined,
        agentEligible: req.query.agent === "1" ? true : req.query.agent === "0" ? false : undefined,
      }),
      importState: precons.state,
      bracketCounts: library.bracketCounts(),
    };
  });

  app.get("/api/library/import-status", { preHandler: owner }, async () => ({ importState: precons.state }));

  /**
   * Same import, for the machine itself (the CLI over loopback) or the ADMIN_TOKEN secret,
   * mirroring POST /api/admin/ingest. Lets the owner run `node server/dist/cli.js import-precons`
   * through `fly ssh console` without signing in.
   */
  app.post<{ Body: { force?: boolean; combos?: boolean } | null }>("/api/admin/import-precons", async (req, reply) => {
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const token = req.headers["x-admin-token"];
    const authorised = isLoopback || (config.adminToken !== "" && token === config.adminToken);
    if (!authorised) return reply.code(403).send({ error: "forbidden" });
    if (precons.state.running) return reply.code(409).send({ error: "import already running", importState: precons.state });
    void precons.run({ force: Boolean(req.body?.force), combos: req.body?.combos !== false });
    return reply.code(202).send({ started: true, importState: precons.state });
  });
  app.get("/api/admin/import-status", async (req, reply) => {
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const token = req.headers["x-admin-token"];
    if (!(isLoopback || (config.adminToken !== "" && token === config.adminToken))) return reply.code(403).send({ error: "forbidden" });
    return { importState: precons.state };
  });

  /**
   * EDHREC average decks (server/src/library/edhrec): the same background import for the machine
   * (loopback / ADMIN_TOKEN, driven by `cli import-edhrec`) and for the signed-in owner.
   * Body: {refresh?, dryRun?, recheckCoverage?}.
   */
  type EdhrecBody = { refresh?: boolean; dryRun?: boolean; recheckCoverage?: boolean } | null;
  const startEdhrec = (body: EdhrecBody) => void edhrec.run({ refresh: Boolean(body?.refresh), dryRun: Boolean(body?.dryRun), recheckCoverage: Boolean(body?.recheckCoverage) });
  const machine = (req: { ip: string; headers: Record<string, unknown> }) =>
    req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1" || (config.adminToken !== "" && req.headers["x-admin-token"] === config.adminToken);
  app.post<{ Body: EdhrecBody }>("/api/admin/import-edhrec", async (req, reply) => {
    if (!machine(req)) return reply.code(403).send({ error: "forbidden" });
    if (edhrec.state.running) return reply.code(409).send({ error: "import already running", state: edhrec.state });
    startEdhrec(req.body);
    return reply.code(202).send({ started: true, state: edhrec.state });
  });
  app.get("/api/admin/import-edhrec", async (req, reply) => {
    if (!machine(req)) return reply.code(403).send({ error: "forbidden" });
    return { state: edhrec.state };
  });
  app.post<{ Body: EdhrecBody }>("/api/library/import-edhrec", { preHandler: owner }, async (req, reply) => {
    if (edhrec.state.running) return reply.code(409).send({ error: "import already running", state: edhrec.state });
    startEdhrec(req.body);
    return reply.code(202).send({ started: true, state: edhrec.state });
  });
  app.get("/api/library/import-edhrec", { preHandler: owner }, async () => ({ state: edhrec.state }));

  /**
   * Library-wide rules-engine check (library/coverage.ts): the machine (loopback / ADMIN_TOKEN, driven by
   * `cli check-library-coverage`) and the owner. Body {source?, enable?}. Never changes a deck the owner
   * switched on or off by hand.
   */
  type CoverageBody = { source?: string; enable?: boolean } | null;
  const startCoverage = (body: CoverageBody) => coverage.start({ source: isLibrarySource(body?.source) ? body.source : undefined, enable: Boolean(body?.enable) });
  app.post<{ Body: CoverageBody }>("/api/admin/library-coverage", async (req, reply) => {
    if (!machine(req)) return reply.code(403).send({ error: "forbidden" });
    if (!startCoverage(req.body)) return reply.code(409).send({ error: "a check is already running", state: coverage.state });
    return reply.code(202).send({ started: true, state: coverage.state });
  });
  app.get("/api/admin/library-coverage", async (req, reply) => {
    if (!machine(req)) return reply.code(403).send({ error: "forbidden" });
    return { state: coverage.state };
  });
  app.post<{ Body: CoverageBody }>("/api/library/coverage", { preHandler: owner }, async (req, reply) => {
    if (!startCoverage(req.body)) return reply.code(409).send({ error: "a check is already running", state: coverage.state });
    return reply.code(202).send({ started: true, state: coverage.state });
  });
  app.get("/api/library/coverage", { preHandler: owner }, async () => ({ state: coverage.state }));

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

  /** The printing picker on the library deck page: another printing of the same card for one line. */
  app.patch<{ Params: { id: string; entry: string }; Body: { cardId?: string } | null }>("/api/library/:id/cards/:entry", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const r = library.setPrinting(req.params.id, Number(req.params.entry), req.body?.cardId);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return { deck: r.deck };
  });

  app.delete<{ Params: { id: string } }>("/api/library/:id", { preHandler: owner }, async (req, reply) => {
    if (!library.remove(req.params.id)) return reply.code(404).send({ error: "library deck not found" });
    return { ok: true };
  });

  /** Re-run the engine. `?combos=cached` reuses the stored Spellbook answer (no request); default re-asks. */
  app.post<{ Params: { id: string }; Querystring: { combos?: string } }>("/api/library/:id/analyze", { preHandler: owner }, async (req, reply): Promise<{ deck: LibraryDeckDetail } | void> => {
    const deck = await library.reanalyze(req.params.id, { combos: req.query.combos === "cached" ? "cached" : "refresh" });
    if (!deck) return reply.code(404).send({ error: "library deck not found" });
    return { deck };
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/primer-skeleton", { preHandler: owner }, async (req, reply): Promise<{ primer: string } | void> => {
    const primer = library.primerSkeleton(req.params.id);
    if (primer === null) return reply.code(404).send({ error: "library deck not found" });
    return { primer };
  });
}
