import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type { CardPrinting, RegisterResponse, ServerMessage } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-engine-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const BOLT = ID(8);
const ATRAXA = ID(10);
const FOREST = ID(11);

type Frame = Record<string, unknown>;

/**
 * A fake rules engine: speaks the control protocol (engine/src/.../EngineServer.java) well
 * enough to prove the relay. It records what CGwF sends and lets the test push frames back.
 */
class FakeEngine {
  server!: WebSocketServer;
  sock: WebSocket | null = null;
  received: Frame[] = [];
  authHeaders: string[] = [];
  port = 0;

  async start(token: string): Promise<void> {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => this.server.once("listening", r));
    this.port = (this.server.address() as { port: number }).port;
    this.server.on("connection", (ws, req) => {
      this.authHeaders.push(String(req.headers.authorization ?? ""));
      if (req.headers.authorization !== `Bearer ${token}`) {
        ws.close(1008, "unauthorized");
        return;
      }
      this.sock = ws;
      ws.send(JSON.stringify({ type: "hello", engine: "fake", forge: "test", ready: true, activeGames: 0 }));
      ws.on("message", (data) => {
        const f = JSON.parse(data.toString()) as Frame;
        this.received.push(f);
        if (f.type === "createGame") {
          const seats = f.seats as Array<{ seat: number; name: string; deck: { name: string; main: unknown[] } }>;
          ws.send(
            JSON.stringify({
              type: "gameCreated",
              rid: f.rid,
              gameId: f.gameId,
              seed: f.seed,
              players: seats.map((s, i) => ({ seat: s.seat, playerId: 100 + i, name: s.name, human: true, deckName: s.deck.name, resolved: s.deck.main.length, exactPrinting: s.deck.main.length, byName: 0, missing: [] })),
            }),
          );
        }
      });
    });
  }
  send(frame: Frame): void {
    this.sock!.send(JSON.stringify(frame));
  }
  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const start = Date.now();
    for (;;) {
      const hit = this.received.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error("fake engine: timed out waiting for a frame");
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  close(): void {
    this.server.close();
  }
}

class Client {
  ws!: WebSocket;
  frames: ServerMessage[] = [];
  text: string[] = [];
  printings: Record<string, CardPrinting> = {};
  constructor(
    readonly name: string,
    readonly token: string,
  ) {}
  async connect(port: number, code: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws.on("message", (data) => {
      const s = data.toString();
      this.text.push(s);
      const msg = JSON.parse(s) as ServerMessage;
      this.frames.push(msg);
      if (msg.t === "state") Object.assign(this.printings, msg.printings);
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
  mark(): number {
    return this.frames.length;
  }
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, from = 0, timeoutMs = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`${this.name}: timed out waiting for a frame`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  stateSince(mark: number) {
    return this.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state", mark);
  }
  async errorSince(mark: number): Promise<string> {
    const m = await this.waitFor((f): f is Extract<ServerMessage, { t: "error" }> => f.t === "error", mark);
    return m.message;
  }
  states(): Array<Extract<ServerMessage, { t: "state" }>> {
    return this.frames.filter((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state");
  }
}

/** A card object in the engine's own shape (SeatView.card). */
function card(id: number, name: string | null, zone: string, controller: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const c: Record<string, unknown> = { id, zone, controller, owner: controller, tapped: false, faceDown: false, token: false, ...extra };
  if (name) Object.assign(c, { name, set: "ONE", scryfallSet: "one", number: "196", types: "Legendary Creature - Phyrexian Angel Horror" });
  return c;
}

const TOKEN = "test-engine-token";

describe("engine tables (relay to the rules engine)", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let engine: FakeEngine;
  let port = 0;
  let alex: Client;
  let blair: Client;
  let casey: Client;
  let code = "";

  const register = async (name: string, ip: string) => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip });
    return (res.json() as RegisterResponse).token;
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const makeDeck = async (token: string, name: string, cards: Array<{ cardId: string; quantity: number; board: string }>) => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(token), payload: { name, cards } });
    expect(res.statusCode).toBe(201);
    return (res.json() as { deck: { id: string } }).deck.id;
  };
  // 99 Forests + Atraxa: legal (basics may repeat, Forest is inside Atraxa's identity).
  const legal = [{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: FOREST, quantity: 99, board: "main" }];

  beforeAll(async () => {
    engine = new FakeEngine();
    await engine.start(TOKEN);
    ctx = await buildApp({ logger: false, engineUrl: `ws://127.0.0.1:${engine.port}`, engineToken: TOKEN });
    await ctx.ingestor.run({ file: fixture });
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(new URL(address).port);
    // wait for the control socket
    for (let i = 0; i < 200 && !ctx.engine.connected; i++) await new Promise((r) => setTimeout(r, 10));
    alex = new Client("alex", await register("Alex", "10.0.0.1"));
    blair = new Client("blair", await register("Blair", "10.0.0.2"));
    casey = new Client("casey", await register("Casey", "10.0.0.3"));
  });

  afterAll(async () => {
    // let the sockets' close handlers (detach -> broadcastRoom) run before the database goes away
    await new Promise((r) => setTimeout(r, 150));
    await ctx.app.close();
    engine.close();
  });

  it("connects to the engine with the bearer token and reports the feature", async () => {
    expect(ctx.engine.connected).toBe(true);
    expect(engine.authHeaders[0]).toBe(`Bearer ${TOKEN}`);
    const res = await ctx.app.inject({ method: "GET", url: "/api/features" });
    expect(res.json()).toEqual({ engine: true });
  });

  it("opens an engine table and refuses illegal decks with a clear message", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex.token), payload: { engine: true } });
    expect(res.statusCode).toBe(201);
    const room = (res.json() as { room: { code: string; engine: boolean } }).room;
    expect(room.engine).toBe(true);
    code = room.code;

    const badDeck = await makeDeck(alex.token, "Tiny", [{ cardId: ATRAXA, quantity: 1, board: "commander" }, { cardId: SOL_RING, quantity: 1, board: "main" }]);
    const goodDeck = await makeDeck(blair.token, "Forests", legal);
    await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/join`, headers: auth(blair.token) });
    await alex.connect(port, code);
    await blair.connect(port, code);
    alex.send({ t: "seat", seat: 0, deckId: badDeck });
    blair.send({ t: "seat", seat: 1, deckId: goodDeck });
    await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.members.filter((m) => m.deckId).length === 2);
    const m = alex.mark();
    alex.send({ t: "start" });
    const err = await alex.errorSince(m);
    expect(err).toMatch(/legal Commander decks/);
    expect(err).toMatch(/Tiny/);
    expect(engine.received.find((f) => f.type === "createGame")).toBeUndefined();
  });

  it("starts the game through the engine with decks by set and collector number", async () => {
    const good = await makeDeck(alex.token, "Forests A", legal);
    alex.send({ t: "seat", seat: 0, deckId: good });
    await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.members.every((x) => x.role !== "player" || x.deckName?.startsWith("Forests") === true));
    const m = alex.mark();
    alex.send({ t: "start" });
    const created = await engine.waitFor((f) => f.type === "createGame");
    const seats = created.seats as Array<{ seat: number; kind: string; name: string; deck: { commanders: Array<{ name: string; setCode: string; number: string }>; main: Array<{ count: number }> } }>;
    expect(seats.map((s) => s.kind)).toEqual(["human", "human"]);
    expect(seats[0]!.deck.commanders[0]!.name).toBe("Atraxa, Praetors' Voice");
    expect(seats[0]!.deck.commanders[0]!.setCode).toBeTruthy();
    expect(seats[0]!.deck.main[0]!.count).toBe(99);
    const room = await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.status === "playing", m);
    expect(room.room.status).toBe("playing");
    expect(ctx.roomsManager.get(code)!.engineTable!.seatInfos().map((s) => s.playerId)).toEqual([100, 101]);
  });

  it("renders each seat its own frame only, and never another seat's hand", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const base = { type: "state", gameId, turn: 1, phase: "MAIN1", activePlayer: 100, priorityPlayer: 100, gameOver: false, stack: [], combat: null, log: [] };
    const players = (viewer: number) => [
      {
        id: 100, seat: 0, name: "Alex", isYou: viewer === 100, human: true, life: 40, poison: 0, lost: false, handCount: 2, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {},
        ...(viewer === 100 ? { hand: [card(11, "Forest", "Hand", 100), card(12, "Forest", "Hand", 100)] } : {}),
        battlefield: [card(13, "Forest", "Battlefield", 100, { tapped: true })], graveyard: [], exile: [], command: [card(14, "Atraxa, Grand Unifier", "Command", 100, { commander: true, power: 7, toughness: 7 })],
      },
      {
        id: 101, seat: 1, name: "Blair", isYou: viewer === 101, human: true, life: 40, poison: 0, lost: false, handCount: 3, libraryCount: 96, landsPlayedThisTurn: 0, commanderDamage: {},
        ...(viewer === 101 ? { hand: [card(21, "Forest", "Hand", 101), card(22, "Forest", "Hand", 101), card(23, "Forest", "Hand", 101)] } : {}),
        battlefield: [], graveyard: [], exile: [], command: [card(24, "Atraxa, Grand Unifier", "Command", 101, { commander: true, power: 7, toughness: 7 })],
      },
    ];
    // the engine tells the relay about every card once
    engine.send({ type: "cards", gameId, seat: -1, cards: [11, 12, 13, 21, 22, 23].map((id) => ({ cardId: id, owner: id < 20 ? 0 : 1, name: "Forest", set: "ONE", scryfallSet: "one", number: "276" })) });
    const ma = alex.mark();
    const mb = blair.mark();
    engine.send({ ...base, seat: 0, viewer: 100, players: players(100) });
    engine.send({ ...base, seat: 1, viewer: 101, players: players(101) });
    engine.send({ ...base, seat: -1, viewer: null, players: players(-1) });

    const full = (f: ServerMessage): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.viewer !== null && Object.keys(f.view.players).length === 2;
    const va = (await alex.waitFor(full, ma)).view;
    const vb = (await blair.waitFor(full, mb)).view;
    const alexId = va.viewer!;
    const blairId = vb.viewer!;
    expect(va.players[alexId]!.hand.cards.length).toBe(2);
    expect(va.players[blairId]!.hand.cards.length).toBe(0);
    expect(va.players[blairId]!.hand.count).toBe(3);
    expect(vb.players[blairId]!.hand.cards.length).toBe(3);
    expect(vb.players[alexId]!.hand.cards.length).toBe(0);
    expect(va.step).toBe("main1");
    expect(va.players[alexId]!.command[0]!.isCommander).toBe(true);
    expect(va.players[alexId]!.command[0]!.engine?.power).toBe(7);
    // printings resolved to CGwF ids, so the image proxy works
    expect(alex.printings[va.players[alexId]!.hand.cards[0]!.printingId!]?.name).toBe("Forest");
    // Blair's hand card ids never reached Alex's socket and vice versa
    for (const id of [21, 22, 23]) expect(alex.text.join("\n")).not.toMatch(new RegExp(`"iid":"${id}"`));
    for (const id of [11, 12]) expect(blair.text.join("\n")).not.toMatch(new RegExp(`"iid":"${id}"`));
  });

  it("delivers a prompt only to its seat, marks who the table waits on, and relays the answer with Forge ids", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const ma = alex.mark();
    const mb = blair.mark();
    engine.send({
      type: "prompt", gameId, seat: 0, promptId: 7, prompt: "priority", title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false,
      options: [{ index: 0, cardId: 11, cardName: "Forest", zone: "Hand", kind: "land", description: "Play Forest", cost: null, targets: false }],
    });
    const sa = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.prompt !== null && f.view.engine?.prompt !== undefined, ma)).view;
    expect(sa.engine?.prompt?.kind).toBe("priority");
    expect(sa.engine?.playable).toEqual(["11"]);
    const sb = (await blair.stateSince(mb)).view;
    expect(sb.engine?.prompt).toBeNull();
    expect(sb.engine?.waitingOn).toEqual([sa.viewer]);
    expect(blair.text.slice(mb).join("\n")).not.toMatch(/"prompt":\{/);

    // Blair cannot answer Alex's prompt
    const mb2 = blair.mark();
    blair.send({ t: "engine", answer: { promptId: 7, option: 0 } });
    expect(await blair.errorSince(mb2)).toMatch(/no longer open|spectators/);

    alex.send({ t: "engine", answer: { promptId: 7, option: 0 } });
    const answer = await engine.waitFor((f) => f.type === "answer");
    expect(answer).toMatchObject({ gameId, seat: 0, promptId: 7, option: 0 });
    // and the answer is on the room's event log
    const events = ctx.roomsManager.get(code)!.currentState() === null ? "engine" : "classic";
    expect(events).toBe("engine");
  });

  it("maps attack answers back to Forge ids and refuses classic events on an engine table", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const ma = alex.mark();
    engine.send({
      type: "prompt", gameId, seat: 0, promptId: 8, prompt: "attackers", title: "Declare attackers",
      candidates: [card(14, "Atraxa, Grand Unifier", "Battlefield", 100, { power: 7, toughness: 7, index: 0, canAttack: [{ kind: "player", id: 101, name: "Blair" }] })],
      defenders: [{ kind: "player", id: 101, name: "Blair", life: 40 }],
    });
    const s = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.prompt?.kind === "attackers" && Object.keys(f.view.players).length === 2, ma)).view;
    const prompt = s.engine!.prompt!;
    expect(prompt.kind).toBe("attackers");
    if (prompt.kind !== "attackers") throw new Error("unreachable");
    const blairId = s.turnOrder[1]!;
    expect(prompt.candidates[0]!.canAttack![0]).toEqual({ kind: "player", player: blairId, name: "Blair" });
    alex.send({ t: "engine", answer: { promptId: 8, attacks: [{ iid: "14", defender: { kind: "player", player: blairId } }] } });
    const answer = await engine.waitFor((f) => f.type === "answer" && f.promptId === 8);
    expect(answer.attacks).toEqual([{ cardId: 14, defender: { kind: "player", id: 101 } }]);

    const m2 = alex.mark();
    alex.send({ t: "event", event: { type: "LifeChanged", payload: { player: s.viewer, delta: -1 } } });
    expect(await alex.errorSince(m2)).toMatch(/rules engine runs this table/);
  });

  it("ends the table when the engine reports game over, and survives a spectator joining late", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/join`, headers: auth(casey.token) });
    await casey.connect(port, code);
    const sc = (await casey.stateSince(0)).view;
    expect(sc.viewer).toBeNull();
    for (const p of Object.values(sc.players)) expect(p.hand.cards.length).toBe(0);
    const ma = alex.mark();
    engine.send({ type: "gameOver", gameId, seat: -1, winnerSeat: 1, winner: "Blair", endReason: "AllOpponentsLost", turns: 9 });
    const room = await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.status === "ended", ma);
    expect(room.room.status).toBe("ended");
    const res = await ctx.app.inject({ method: "GET", url: `/api/rooms/${code}`, headers: auth(alex.token) });
    expect((res.json() as { room: { status: string } }).room.status).toBe("ended");
    await Promise.all([alex.close(), blair.close(), casey.close()]);
  });
});
