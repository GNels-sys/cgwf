import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DeckDetail, DoctorAiState, DoctorAiUsage, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-doctor-ai-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards, users } = await import("../db/schema.js");
const { messageCost, renderContext } = await import("../analysis/doctor/ai.js");
type DoctorLlm = import("../analysis/doctor/ai.js").DoctorLlm;
type DoctorLlmRequest = import("../analysis/doctor/ai.js").DoctorLlmRequest;
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const PAGE = {
  container: {
    json_dict: {
      card: { name: "Atraxa, Praetors' Voice" },
      cardlists: [{ cardviews: [{ name: "Rancor", synergy: 0.4, num_decks: 500, potential_decks: 1000 }, { name: "Tireless Tracker", synergy: 0.45, num_decks: 600, potential_decks: 1000 }] }],
    },
  },
};

/** A scripted "model": each call returns the next turn's tool calls; records what it was sent. */
class ScriptedDoctorLlm implements DoctorLlm {
  readonly model = "claude-opus-5-5";
  calls: DoctorLlmRequest[] = [];
  constructor(private readonly turns: Array<(req: DoctorLlmRequest) => Partial<BetaMessage>>) {}
  async call(req: DoctorLlmRequest): Promise<BetaMessage> {
    this.calls.push(structuredClone(req));
    const turn = this.turns[Math.min(this.calls.length - 1, this.turns.length - 1)]!(req);
    return {
      id: `msg_${this.calls.length}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content: [],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 10000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...turn,
    } as unknown as BetaMessage;
  }
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

describe("Deck Doctor AI upgrade (owner only)", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken = "";
  let otherToken = "";
  let deck: DeckDetail;
  let llm: ScriptedDoctorLlm;
  const auth = (t = ownerToken) => ({ authorization: `Bearer ${t}` });
  const idOf = (name: string) => ctx.handle.db.select().from(cards).where(eq(cards.name, name)).all().find((c) => (c.legalities as Record<string, string>).commander === "legal")!;

  beforeAll(async () => {
    llm = new ScriptedDoctorLlm([
      () => ({ content: [use("t1", "lookup_card", { name: "Rancor" }), use("t2", "lookup_card", { name: "Rancr" })] } as Partial<BetaMessage>),
      () => ({ content: [use("t3", "submit_recommendations", { read: "Atraxa wants counters.", swaps: [{ add: "Lightning Bolt", cut: "Atraxa, Praetors' Voice", reason: "burn" }] })] } as Partial<BetaMessage>),
      () => ({ content: [{ type: "thinking", thinking: "", signature: "x" }, use("t4", "submit_recommendations", { read: "Atraxa proliferates counters; light on ramp and card advantage.", swaps: [{ add: "Rancor", cut: "Lotus Cobra", reason: "Keeps coming back and turns Atraxa into a threat." }] })] } as Partial<BetaMessage>),
    ]);
    ctx = await buildApp({
      logger: false,
      edhrecFetch: async (url: string) => (url.endsWith("commanders/atraxa-praetors-voice.json") ? new Response(JSON.stringify(PAGE), { status: 200 }) : new Response("no", { status: 403 })),
      edhrecCacheDir: path.join(tmp, "edhrec"),
      edhrecGapMs: 0,
      spellbookFetch: async () => new Response(JSON.stringify({ results: { included: [], almostIncluded: [] } }), { status: 200 }),
      doctorLlm: llm,
      doctorAiEnabled: true,
      doctorCaps: { perRun: 2, perDay: 5, maxCalls: 6 },
    });
    await ctx.ingestor.run({ file: fixture });
    const reg = (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Owner", avatar: "dragon", color: "gold" } })).json() as RegisterResponse;
    ownerToken = reg.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, reg.user.id)).run();
    otherToken = ((await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Sam", avatar: "owl", color: "jade" }, remoteAddress: "10.7.7.7" })).json() as RegisterResponse).token;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(),
      payload: { name: "AI test", cards: [{ cardId: idOf("Atraxa, Praetors' Voice").id, quantity: 1, board: "commander" }, { cardId: idOf("Lotus Cobra").id, quantity: 1, board: "main" }, { cardId: idOf("Sol Ring").id, quantity: 1, board: "main" }, { cardId: idOf("Forest").id, quantity: 20, board: "main" }] },
    });
    deck = (created.json() as { deck: DeckDetail }).deck;
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const waitDone = async () => {
    for (let i = 0; i < 400; i++) {
      const s = (await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth() })).json() as DoctorAiState;
      if (s.run && s.run.status !== "running") return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run did not finish");
  };

  it("is owner only", async () => {
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth(otherToken) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth(otherToken), payload: {} })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: "/api/admin/doctor-ai", headers: auth(otherToken) })).statusCode).toBe(403);
    const s = (await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth() })).json() as DoctorAiState;
    expect(s).toMatchObject({ enabled: true, problem: null, model: "claude-opus-5-5", run: null });
  });

  it("looks cards up, rejects an invalid answer with the reasons, accepts the fixed one, and records usage", async () => {
    const start = await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth(), payload: {} });
    expect(start.statusCode).toBe(202);
    const s = await waitDone();
    const run = s.run!;
    expect(run.status).toBe("done");
    expect(run).toMatchObject({ calls: 3, toolCalls: 4, invalidSubmissions: 1, inputTokens: 30000, outputTokens: 3000, current: true });
    // 3 x (10k in at $4/MTok + 1k out at $20/MTok) = 3 x $0.06
    expect(run.costUsd).toBeCloseTo(0.18, 4);
    expect(run.result!.read).toMatch(/proliferates/);
    expect(run.result!.swaps).toHaveLength(1);
    expect(run.result!.swaps[0]).toMatchObject({ add: { name: "Rancor", synergy: 0.4 }, cut: { name: "Lotus Cobra" }, bracket: { raises: false } });
    expect(run.result!.swaps[0]!.cut.entryId).toEqual(expect.any(Number));

    // What the model was told: the deck with oracle text; the lookups and the rejection it got back.
    const first = llm.calls[0]!;
    const context = JSON.stringify(first.messages[0]);
    expect(context).toMatch(/Lotus Cobra/);
    expect(context).toMatch(/Landfall/i);
    const toolReplies = JSON.stringify(llm.calls[1]!.messages.at(-1));
    expect(toolReplies).toMatch(/"found\\":true/);
    expect(toolReplies).toMatch(/closeMatches/);
    const rejection = JSON.stringify(llm.calls[2]!.messages.at(-1));
    expect(rejection).toMatch(/Lightning Bolt is outside the commander's colour identity/);
    expect(rejection).toMatch(/Atraxa, Praetors' Voice is a commander and cannot be cut/);
    expect(rejection).toMatch(/is_error/);
  });

  it("re-opening the same deck version costs nothing; Run again starts a new run", async () => {
    const before = llm.calls.length;
    const again = await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth(), payload: {} });
    expect(again.statusCode).toBe(200);
    expect(llm.calls.length).toBe(before);
    const forced = await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/doctor/ai`, headers: auth(), payload: { force: true } });
    expect(forced.statusCode).toBe(202);
    await waitDone();
    expect(llm.calls.length).toBeGreaterThan(before);
    const usage = (await ctx.app.inject({ method: "GET", url: "/api/admin/doctor-ai", headers: auth() })).json() as DoctorAiUsage;
    expect(usage.runs.length).toBe(2);
    expect(usage.todayUsd).toBeCloseTo(0.24, 4); // the first run (3 calls) + the forced one (1 call)
    expect(usage).toMatchObject({ enabled: true, maxUsdPerRun: 2, maxUsdPerDay: 5 });
  });

  it("stops at the per-run cap and on a refusal; refuses to start past the daily cap", async () => {
    const capped = await buildApp({ logger: false, doctorLlm: new ScriptedDoctorLlm([() => ({ content: [use("a", "lookup_card", { name: "Rancor" })], usage: { input_tokens: 400000, output_tokens: 0 } } as unknown as Partial<BetaMessage>)]), doctorAiEnabled: true, doctorCaps: { perRun: 1, perDay: 5 }, dbFile: path.join(tmp, "cgwf.db") });
    const t = { kind: "own" as const, deckId: deck.id, userId: (ctx.handle.db.select().from(users).where(eq(users.isOwner, true)).get())!.id };
    const r1 = await capped.doctorAi.runNow(t);
    expect(r1.status).toBe("capped");
    expect(r1.error).toMatch(/per-run cap/);
    expect(r1.calls).toBe(1);
    await capped.app.close();

    const refuser = await buildApp({ logger: false, doctorLlm: new ScriptedDoctorLlm([() => ({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [] } as unknown as Partial<BetaMessage>)]), doctorAiEnabled: true, dbFile: path.join(tmp, "cgwf.db") });
    const r2 = await refuser.doctorAi.runNow(t);
    expect(r2).toMatchObject({ status: "refused", error: "the model declined (cyber)" });
    await refuser.app.close();

    const broke = await buildApp({ logger: false, doctorLlm: llm, doctorAiEnabled: true, doctorCaps: { perDay: 0.01 }, dbFile: path.join(tmp, "cgwf.db") });
    await expect(broke.doctorAi.start(t, { force: true })).rejects.toThrow(/Today's AI budget/);
    await broke.app.close();

    const off = await buildApp({ logger: false, doctorLlm: llm, doctorAiEnabled: false, dbFile: path.join(tmp, "cgwf.db") });
    await expect(off.doctorAi.start(t, { force: true })).rejects.toThrow(/DOCTOR_AI_ENABLED/);
    await off.app.close();
  });

  it("prices refusal fallbacks per model attempt", () => {
    expect(messageCost("claude-opus-5-5", { model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } } as never)).toBeCloseTo(4, 6);
    const fallback = { model: "claude-opus-4-8", usage: { input_tokens: 0, output_tokens: 0, iterations: [{ type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 }, { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000_000, output_tokens: 0 }] } };
    expect(messageCost("claude-opus-5-5", fallback as never)).toBeCloseTo(9, 6);
  });

  it("the context names pinned and dismissed cards", async () => {
    await ctx.app.inject({ method: "POST", url: "/api/doctor/prefs", headers: auth(), payload: { deckRef: deck.id, oracleId: idOf("Sol Ring").oracleId, name: "Sol Ring", kind: "keep" } });
    const built = await ctx.doctorAi["d"].doctor.build({ kind: "own", deckId: deck.id, userId: (ctx.handle.db.select().from(users).where(eq(users.isOwner, true)).get())!.id });
    const text = renderContext(built);
    expect(text).toMatch(/Sol Ring \[PINNED: keep\]/);
    expect(text).toMatch(/Pinned to keep \(never cut\): Sol Ring/);
    expect(text).toMatch(/Top EDHREC cards for this commander not in the deck/);
  });
});
