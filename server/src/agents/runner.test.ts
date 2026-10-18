import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { viewFor, type RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-agents-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { AgentManager } = await import("./manager.js");
const { ScriptedLlm, textBlock, toolUse } = await import("./llm.js");
const { config } = await import("../config.js");
const { users, rooms, agentRuns, agentDecisions } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const LIST = "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Lightning Bolt\n1 Lotus Cobra\n1 Scute Swarm\n1 Tireless Tracker\n1 Glorious Anthem\n1 Rancor\n1 Lightning Greaves\n10 Forest\n";

/** The owner passes every time it is their turn, until the turn counter reaches `turn`. */
async function playUntil(room: { currentState(): { turn: number; activePlayer: string; phase: string } | null; submit(u: string, e: { type: "TurnAdvanced"; payload: Record<string, never> }): void }, ownerId: string, turn: number, ms = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const s = room.currentState();
    if (s && s.turn >= turn && s.activePlayer === ownerId) return;
    if (s && s.phase === "playing" && s.activePlayer === ownerId) room.submit(ownerId, { type: "TurnAdvanced", payload: {} });
    if (Date.now() - start > ms) throw new Error(`timed out before turn ${turn} (at ${s?.turn}, active ${s?.activePlayer})`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function waitFor(pred: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("computer opponents play through the normal event path", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken = "";
  let ownerId = "";
  let ownerDeckId = "";

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, agentLlm: null, agentsEnabled: true, spellbookFetch: async () => new Response(JSON.stringify({ results: { included: [] } }), { status: 200 }) });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Owner", avatar: "dragon", color: "gold" } });
    const owner = reg.json() as RegisterResponse;
    ownerToken = owner.token;
    ownerId = owner.user.id;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, ownerId)).run();
    const auth = { authorization: `Bearer ${ownerToken}` };
    const parsed = await ctx.app.inject({ method: "POST", url: "/api/decks/parse", headers: auth, payload: { text: LIST } });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const cards = lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board }));
    const created = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth, payload: { name: "Owner deck", cards } });
    ownerDeckId = (created.json() as { deck: { id: string } }).deck.id;
    // Two agent-eligible library decks (same cards, different names).
    for (const name of ["Atraxa A", "Atraxa B"]) {
      const lib = await ctx.library.create({ name, source: "user", sourceKey: `test:${name}`, entries: cards.map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board as "main" | "commander" })) }, { combos: "skip" });
      ctx.library.patch(lib.id, { agentEligible: true, bracket: 2, primer: `# ${name}\nRamp, deploy, attack.` });
    }
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${ownerToken}` });

  it("owner-only routes are gated, and the feature flag hides them", async () => {
    const anon = await ctx.app.inject({ method: "GET", url: "/api/agents/status" });
    expect(anon.statusCode).toBe(401);
    const other = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Guest", avatar: "owl", color: "jade" }, remoteAddress: "10.4.4.4" });
    const guest = await ctx.app.inject({ method: "GET", url: "/api/agents/status", headers: { authorization: `Bearer ${(other.json() as RegisterResponse).token}` } });
    expect(guest.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: "GET", url: "/api/agents/status", headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ enabled: true, dryRun: true, maxUsdPerGame: config.agentMaxUsdPerGame });
  });

  it("adds agents to a lobby with distinct decks, re-rolls, and plays a dry-run game through the reducer", async () => {
    const roomRes = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(), payload: {} });
    const code = (roomRes.json() as { room: { code: string } }).room.code;
    const room = ctx.roomsManager.get(code)!;
    room.takeSeat(ownerId, 0, ownerDeckId);

    const add = await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/agents`, headers: auth(), payload: { count: 2, bracket: 2 } });
    expect(add.statusCode).toBe(200);
    const picks = (add.json() as { agents: Array<{ seat: number; deckName: string; name: string }> }).agents;
    expect(picks).toHaveLength(2);
    expect(new Set(picks.map((p) => p.deckName)).size).toBe(2);
    expect(picks.every((p) => /bot$/.test(p.name))).toBe(true);
    const info = room.info(ownerId);
    expect(info.members.filter((m) => m.isAgent)).toHaveLength(2);

    // Re-roll replaces them (old bot users are gone).
    const again = await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/agents`, headers: auth(), payload: { count: 1, bracket: 2 } });
    expect((again.json() as { agents: unknown[] }).agents).toHaveLength(1);
    expect(room.info(ownerId).members.filter((m) => m.isAgent)).toHaveLength(1);
    expect(ctx.handle.db.select().from(users).where(eq(users.isAgent, true)).all()).toHaveLength(1);
    const final = await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/agents`, headers: auth(), payload: { count: 2, bracket: 2 } });
    const agentIds = (final.json() as { agents: Array<{ userId: string }> }).agents.map((a) => a.userId);

    // The deal is seeded by the room: pin it, so the agents' hands are the same on every run. (With a
    // random seed about one run in nine dealt an agent a hand outside its keep rule, which added a
    // legitimate third "mulligan" decision and failed the counts below.)
    ctx.handle.db.update(rooms).set({ seed: "5eed000000000000000000000000c0de" }).where(eq(rooms.id, room.id)).run();
    room.refreshRow();
    room.start(ownerId);
    ctx.agents.onGameStarted(room);
    // Agents keep their hands by rule; the owner keeps too.
    await waitFor(() => agentIds.every((id) => room.currentState()?.players[id]?.kept === true));
    room.submit(ownerId, { type: "HandKept", payload: { player: ownerId } });
    await waitFor(() => room.currentState()?.phase === "playing");

    // Whoever starts, the owner passes on their turns; both agents must take theirs and pass back.
    await playUntil(room, ownerId, 4);
    const state = room.currentState()!;
    expect(state.activePlayer).toBe(ownerId);
    for (const id of agentIds) {
      const p = state.players[id]!;
      expect(p.zones.battlefield.lands.length).toBeGreaterThanOrEqual(1);
      // Everything the agent did went through room.submit: actor = the agent, hand/library rules intact.
      expect(p.zones.hand.length).toBeLessThanOrEqual(7);
    }
    const runs = ctx.handle.db.select().from(agentRuns).all();
    expect(runs).toHaveLength(2);
    const decisions = ctx.handle.db.select().from(agentDecisions).all();
    expect(decisions.filter((d) => d.kind === "turn" && d.outcome === "dry_run").length).toBeGreaterThanOrEqual(2);
    expect(decisions.filter((d) => d.kind === "mulligan")).toHaveLength(2);
    expect(decisions.every((d) => d.costUsd === 0)).toBe(true);

    const drawer = await ctx.app.inject({ method: "GET", url: `/api/rooms/${code}/agents`, headers: auth() });
    expect(drawer.statusCode).toBe(200);
    const body = drawer.json() as { runs: Array<{ status: string; mode: string }>; decisions: Array<{ toolCalls: Array<{ name: string; ok: boolean }> }>; totalUsd: number };
    expect(body.runs.every((r) => r.mode === "dry_run" && r.status === "running")).toBe(true);
    expect(body.decisions.some((d) => d.toolCalls.some((c) => c.name === "play_land" && c.ok))).toBe(true);
    expect(body.totalUsd).toBe(0);
    // The agent's prompt view never contains the owner's hand: checked structurally by prompt.test.ts; here the host's hand is untouched.
    expect(state.players[ownerId]!.zones.hand.length).toBe(7);
  }, 40000);

  it("with a model: one call per decision, rationale and cost recorded, and the game cap concedes politely", async () => {
    const roomRes = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(), payload: {} });
    const code = (roomRes.json() as { room: { code: string } }).room.code;
    const room = ctx.roomsManager.get(code)!;
    room.takeSeat(ownerId, 0, ownerDeckId);

    const llm = new ScriptedLlm((req) => {
      // Find a land in the agent's hand from the rendered state and play it, then pass.
      const last = req.messages.at(-1)!;
      const text = typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const hand = text.split("== Your hand ==")[1] ?? "";
      const land = hand.match(/^\s+(c\w+) Forest/m)?.[1];
      const calls = land ? [toolUse("play_land", { iid: land }), toolUse("play_land", { iid: "bogus" }), toolUse("pass_turn", {})] : [toolUse("pass_turn", {})];
      return { content: [textBlock("Land drop, then pass."), ...calls] };
    });
    const manager = new AgentManager({ handle: ctx.handle, library: ctx.library, analyzer: ctx.analyzer, log: null, llm, enabled: true });
    const { agents } = await manager.addAgents(room, ownerId, { count: 1, bracket: 2 });
    const agentId = agents[0]!.userId;
    room.start(ownerId);
    manager.onGameStarted(room);
    await waitFor(() => room.currentState()?.players[agentId]?.kept === true);
    room.submit(ownerId, { type: "HandKept", payload: { player: ownerId } });
    await waitFor(() => room.currentState()?.phase === "playing");
    await playUntil(room, ownerId, 3);

    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    const req = llm.requests[0]!;
    expect(req.system).toContain("Ramp, deploy, attack."); // deck primer
    expect(req.system).toContain("How this table works"); // rules primer
    expect(req.tools.some((t) => t.name === "pass_turn")).toBe(true);
    const state = room.currentState()!;
    expect(state.players[agentId]!.zones.battlefield.lands).toHaveLength(llm.requests.length); // one land per turn it played
    const decisions = ctx.handle.db.select().from(agentDecisions).where(eq(agentDecisions.roomId, room.id)).all();
    const turn = decisions.find((d) => d.kind === "turn")!;
    expect(turn.rationale).toBe("Land drop, then pass.");
    expect(turn.costUsd).toBeCloseTo(0.003, 6); // 1000 in + 100 out on Sonnet pricing
    const calls = turn.toolCalls as Array<{ name: string; ok: boolean; error?: string }>;
    expect(calls.map((c) => [c.name, c.ok])).toEqual([
      ["play_land", true],
      ["play_land", false],
      ["pass_turn", true],
    ]);
    expect(calls[1]!.error).toMatch(/no visible card/);
    const run = ctx.handle.db.select().from(agentRuns).where(eq(agentRuns.userId, agentId)).get()!;
    expect(run.decisions).toBeGreaterThanOrEqual(2); // mulligan rule + model decisions
    expect(run.costUsd).toBeCloseTo(0.003 * llm.requests.length, 6);

    // Now the cap: with the game cap at $0 the next turn starts with a concession and a log line.
    const before = config.agentMaxUsdPerGame;
    (config as { agentMaxUsdPerGame: number }).agentMaxUsdPerGame = 0;
    try {
      const callsBefore = llm.requests.length;
      room.submit(ownerId, { type: "TurnAdvanced", payload: {} }); // agent's turn again
      await waitFor(() => room.currentState()?.players[agentId]?.conceded === true, 20000);
      const log = room.currentState()!.log.map((l) => l.text).join("\n");
      expect(log).toMatch(/stops playing: game spending cap reached/);
      expect(llm.requests.length).toBe(callsBefore); // no further model call
      await waitFor(() => ctx.handle.db.select().from(agentRuns).where(eq(agentRuns.userId, agentId)).get()!.status === "capped");
    } finally {
      (config as { agentMaxUsdPerGame: number }).agentMaxUsdPerGame = before;
    }
  }, 40000);

  it("a model that only sends invalid calls is cut off and the turn still passes", async () => {
    const roomRes = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(), payload: {} });
    const code = (roomRes.json() as { room: { code: string } }).room.code;
    const room = ctx.roomsManager.get(code)!;
    room.takeSeat(ownerId, 0, ownerDeckId);
    const llm = new ScriptedLlm(() => ({ content: [toolUse("play_land", { iid: "nope" }), toolUse("change_life", { player: "ghost", delta: -1 })] }));
    const manager = new AgentManager({ handle: ctx.handle, library: ctx.library, analyzer: ctx.analyzer, log: null, llm, enabled: true });
    const { agents } = await manager.addAgents(room, ownerId, { count: 1, bracket: 2 });
    const agentId = agents[0]!.userId;
    room.start(ownerId);
    manager.onGameStarted(room);
    await waitFor(() => room.currentState()?.players[agentId]?.kept === true);
    room.submit(ownerId, { type: "HandKept", payload: { player: ownerId } });
    await waitFor(() => room.currentState()?.phase === "playing");
    await playUntil(room, ownerId, 3);
    expect(room.currentState()!.activePlayer).toBe(ownerId);
    expect(llm.requests.length).toBeLessThanOrEqual(4);
    expect(room.currentState()!.log.map((l) => l.text).join("\n")).toMatch(/passes \(too many invalid actions\)/);
    manager.close();
  }, 40000);
});
