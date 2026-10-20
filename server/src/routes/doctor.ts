import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DoctorAiRun, DoctorAiStartRequest, DoctorAiState, DoctorAiUsage, DoctorApplyRequest, DoctorPrefRequest, DoctorResponse } from "@cgwf/shared";
import type { DoctorAi } from "../analysis/doctor/ai.js";
import { DeckDoctor, DoctorError } from "../analysis/doctor/service.js";
import { rateLimitKey, requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { decks, libraryDecks } from "../db/schema.js";

/**
 * Deck Doctor (free, no model spend; analysis/doctor):
 *   GET    /api/decks/:id/doctor?bracket=N&allowHigher=1     own deck
 *   GET    /api/library-decks/:id/doctor?bracket=N&...       library deck, read-only (any signed-in player)
 *   POST   /api/decks/:id/doctor/apply {cutEntryId, addOracleId}   own deck only
 *   POST   /api/doctor/prefs {deckRef, oracleId, name, kind}        keep / dismiss
 *   DELETE /api/doctor/prefs {deckRef, oracleId, kind}
 */
export function registerDoctorRoutes(app: FastifyInstance, deps: { handle: DbHandle; doctor: DeckDoctor; ai: DoctorAi }): void {
  const { handle, doctor, ai } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);
  const limited = { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator } } };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof DoctorError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  const opts = (q: { bracket?: string; allowHigher?: string }) => ({ target: q.bracket ? Number(q.bracket) : undefined, allowHigher: q.allowHigher === "1" || q.allowHigher === "true" });

  app.get<{ Params: { id: string }; Querystring: { bracket?: string; allowHigher?: string } }>("/api/decks/:id/doctor", limited, async (req, reply): Promise<DoctorResponse | void> => {
    try {
      return await doctor.run({ kind: "own", deckId: req.params.id, userId: req.user!.id }, opts(req.query));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { bracket?: string; allowHigher?: string } }>("/api/library-decks/:id/doctor", limited, async (req, reply): Promise<DoctorResponse | void> => {
    try {
      return await doctor.run({ kind: "library", libraryId: req.params.id, userId: req.user!.id }, opts(req.query));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: Partial<DoctorApplyRequest> | null }>("/api/decks/:id/doctor/apply", limited, async (req, reply) => {
    const cut = Number(req.body?.cutEntryId);
    const add = typeof req.body?.addOracleId === "string" ? req.body.addOracleId : "";
    if (!Number.isInteger(cut) || !add) return reply.code(400).send({ error: "cutEntryId and addOracleId are required" });
    try {
      doctor.applySwap(req.user!.id, req.params.id, cut, add);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** A deck reference the caller may read: their own deck, or any library deck. */
  const readable = (userId: string, ref: string): boolean => {
    if (ref.startsWith("library:")) return Boolean(handle.db.select({ id: libraryDecks.id }).from(libraryDecks).where(eq(libraryDecks.id, ref.slice(8))).get());
    return Boolean(handle.db.select({ id: decks.id }).from(decks).where(and(eq(decks.id, ref), eq(decks.userId, userId))).get());
  };
  const prefBody = (b: Partial<DoctorPrefRequest> | null) => {
    const kind = b?.kind === "keep" || b?.kind === "dismiss" ? b.kind : null;
    const deckRef = typeof b?.deckRef === "string" ? b.deckRef : "";
    const oracleId = typeof b?.oracleId === "string" ? b.oracleId : "";
    return kind && deckRef && oracleId ? { kind, deckRef, oracleId, name: typeof b?.name === "string" ? b.name : "" } : null;
  };
  app.post<{ Body: Partial<DoctorPrefRequest> | null }>("/api/doctor/prefs", { preHandler: auth }, async (req, reply) => {
    const b = prefBody(req.body);
    if (!b) return reply.code(400).send({ error: "deckRef, oracleId and kind (keep | dismiss) are required" });
    if (!readable(req.user!.id, b.deckRef)) return reply.code(404).send({ error: "deck not found" });
    doctor.setPref(req.user!.id, b.deckRef, b.oracleId, b.name, b.kind);
    return { ok: true };
  });
  app.delete<{ Body: Partial<DoctorPrefRequest> | null }>("/api/doctor/prefs", { preHandler: auth }, async (req, reply) => {
    const b = prefBody(req.body);
    if (!b) return reply.code(400).send({ error: "deckRef, oracleId and kind (keep | dismiss) are required" });
    if (!readable(req.user!.id, b.deckRef)) return reply.code(404).send({ error: "deck not found" });
    doctor.clearPref(req.user!.id, b.deckRef, b.oracleId, b.kind);
    return { ok: true };
  });

  /*
   * AI deck upgrade (M2): OWNER ONLY (requireOwner; the UI is hidden for everyone else) and only with
   * DOCTOR_AI_ENABLED=1 (state.enabled false otherwise; starting a run answers 503).
   *   GET  /api/decks/:id/doctor/ai            state + the newest run for this deck (cached per deck version)
   *   POST /api/decks/:id/doctor/ai {bracket?, allowHigher?, force?}   start (or return the cached run)
   *   GET|POST /api/library-decks/:id/doctor/ai                          the same for library decks
   *   GET  /api/admin/doctor-ai                runs, spend, caps (Admin page)
   */
  const owner = [auth, requireOwner(handle)];
  const state = (run: DoctorAiRun | null): DoctorAiState => ({
    enabled: ai.enabled,
    problem: ai.enabled ? ai.problem() : null,
    model: ai.usage().model,
    maxUsdPerRun: ai.usage().maxUsdPerRun,
    maxUsdPerDay: ai.usage().maxUsdPerDay,
    todayUsd: ai.usage().todayUsd,
    run,
  });
  const targetOf = (kind: string, id: string, userId: string) => (kind === "decks" ? { kind: "own" as const, deckId: id, userId } : { kind: "library" as const, libraryId: id, userId });
  for (const kind of ["decks", "library-decks"] as const) {
    app.get<{ Params: { id: string } }>(`/api/${kind}/:id/doctor/ai`, { preHandler: owner }, async (req, reply): Promise<DoctorAiState | void> => {
      try {
        return state(ai.latest(req.user!.id, targetOf(kind, req.params.id, req.user!.id)));
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.post<{ Params: { id: string }; Body: Partial<DoctorAiStartRequest> | null }>(`/api/${kind}/:id/doctor/ai`, { preHandler: owner, config: { rateLimit: { max: 6, timeWindow: "1 minute", keyGenerator } } }, async (req, reply) => {
      try {
        const run = await ai.start(targetOf(kind, req.params.id, req.user!.id), {
          target: req.body?.bracket ? Number(req.body.bracket) : undefined,
          allowHigher: Boolean(req.body?.allowHigher),
          force: Boolean(req.body?.force),
        });
        return reply.code(run.status === "running" ? 202 : 200).send(state(run));
      } catch (err) {
        return fail(reply, err);
      }
    });
  }
  app.get("/api/admin/doctor-ai", { preHandler: owner }, async (): Promise<DoctorAiUsage> => ai.usage());
}
