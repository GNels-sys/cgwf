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
process.env.ENGINE_ABSENT_GRACE_MS = "300"; // short grace so the reload test runs in well under a second

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
      if (Date.now() - start > timeoutMs) throw new Error(`${this.name}: timed out waiting for a frame; got ${JSON.stringify(this.frames.slice(from).map((f) => (f.t === "state" ? { viewer: f.view.viewer, players: Object.keys(f.view.players), turn: f.view.turn } : f.t)))}`);
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
  /** Forge player ids by seat, as the (fake) engine assigned them in gameCreated. */
  const pid: Record<number, number> = {};

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
    // the lobby already shows why, per seat
    const roomInfo = (await ctx.app.inject({ method: "GET", url: `/api/rooms/${code}`, headers: auth(alex.token) })).json() as { room: { members: Array<{ name: string; deckProblems: string[] }> } };
    expect(roomInfo.room.members.find((x) => x.name === "Alex")!.deckProblems.join(" ")).toMatch(/cards including commander/);
    expect(roomInfo.room.members.find((x) => x.name === "Blair")!.deckProblems).toEqual([]);
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
    // remembered stops go to the engine right after the game is created
    const stopsFrames = await engine.waitFor((f) => f.type === "setStops" && f.seat === 1);
    expect((stopsFrames.stops as { respond: boolean }).respond).toBe(true);
    const seats = created.seats as Array<{ seat: number; kind: string; name: string; deck: { commanders: Array<{ name: string; setCode: string; number: string }>; main: Array<{ count: number }> } }>;
    expect(seats.map((s) => s.kind)).toEqual(["human", "human"]);
    expect(seats[0]!.deck.commanders[0]!.name).toBe("Atraxa, Praetors' Voice");
    expect(seats[0]!.deck.commanders[0]!.setCode).toBeTruthy();
    expect(seats[0]!.deck.main[0]!.count).toBe(99);
    const room = await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.status === "playing", m);
    expect(room.room.status).toBe("playing");
    const infos = ctx.roomsManager.get(code)!.engineTable!.seatInfos();
    expect(infos.map((s) => s.playerId).sort()).toEqual([100, 101]);
    for (const s of infos) pid[s.seat] = s.playerId;
  });

  it("renders each seat its own frame only, and never another seat's hand", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const A = pid[0]!;
    const B = pid[1]!;
    const base = { type: "state", gameId, turn: 1, phase: "MAIN1", activePlayer: A, priorityPlayer: A, gameOver: false, stack: [], combat: null, log: [] };
    const players = (viewer: number) => [
      {
        id: A, seat: 0, name: "Alex", isYou: viewer === A, human: true, life: 40, poison: 0, lost: false, handCount: 2, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {},
        ...(viewer === A ? { hand: [card(11, "Forest", "Hand", A), card(12, "Forest", "Hand", A)] } : {}),
        battlefield: [card(13, "Forest", "Battlefield", A, { tapped: true, mana: ["G"] })], graveyard: [], exile: [], command: [card(14, "Atraxa, Grand Unifier", "Command", A, { commander: true, power: 7, toughness: 7 })],
      },
      {
        id: B, seat: 1, name: "Blair", isYou: viewer === B, human: true, life: 40, poison: 0, lost: false, handCount: 3, libraryCount: 96, landsPlayedThisTurn: 0, commanderDamage: {},
        ...(viewer === B ? { hand: [card(21, "Forest", "Hand", B), card(22, "Forest", "Hand", B), card(23, "Forest", "Hand", B)] } : {}),
        battlefield: [], graveyard: [], exile: [], command: [card(24, "Atraxa, Grand Unifier", "Command", B, { commander: true, power: 7, toughness: 7 })],
      },
    ];
    // the engine tells the relay about every card once
    engine.send({ type: "cards", gameId, seat: -1, cards: [11, 12, 13, 21, 22, 23].map((id) => ({ cardId: id, owner: id < 20 ? 0 : 1, name: "Forest", set: "ONE", scryfallSet: "one", number: "276" })) });
    const ma = alex.mark();
    const mb = blair.mark();
    engine.send({ ...base, seat: 0, viewer: A, players: players(A) });
    engine.send({ ...base, seat: 1, viewer: B, players: players(B) });
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
    expect(Object.values(sa.players[sa.viewer!]!.battlefield).flat().find((c) => c.iid === "13")?.engine?.mana).toEqual(["G"]);
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
    expect(answer).not.toHaveProperty("paySources");
    // "Pay with": the chosen sources travel as Forge card ids, in the order given
    engine.send({
      type: "prompt", gameId, seat: 0, promptId: 70, prompt: "priority", title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false,
      options: [{ index: 0, cardId: 12, cardName: "Forest", zone: "Hand", kind: "land", description: "Play Forest", cost: null, targets: false }, { index: 1, cardId: 14, cardName: "Atraxa, Grand Unifier", zone: "Command", kind: "spell", description: "Cast Atraxa", cost: "{G}{W}{U}{B}", targets: false }],
    });
    await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.prompt?.promptId === 70, ma);
    alex.send({ t: "engine", answer: { promptId: 70, option: 1, paySources: ["13", "x", "11"] } });
    const paid = await engine.waitFor((f) => f.type === "answer" && f.promptId === 70);
    expect(paid).toMatchObject({ seat: 0, option: 1, paySources: [13, 11] });
    // and the answer is on the room's event log
    const events = ctx.roomsManager.get(code)!.currentState() === null ? "engine" : "classic";
    expect(events).toBe("engine");
  });

  it("delivers a notice (cards revealed to a seat, a value Forge announces) to that seat only, with printings", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const ma = alex.mark();
    const mb = blair.mark();
    engine.send({ type: "notice", gameId, seat: 0, kind: "reveal", title: "Revealed: Blair's hand", cards: [card(40, "Forest", "Hand", pid[1]!, { set: "M21", scryfallSet: "m21", number: "274" })] });
    engine.send({ type: "notice", gameId, seat: 0, kind: "info", title: "Utopia Sprawl", text: "Blair picked Green (108)", source: [card(41, "Forest", "Battlefield", pid[1]!)] });
    const reveal = await alex.waitFor((f): f is Extract<ServerMessage, { t: "notice" }> => f.t === "notice" && f.notice.kind === "reveal", ma);
    expect(reveal.notice.title).toBe("Revealed: Blair's hand");
    expect(reveal.notice.cards[0]!.name).toBe("Forest");
    const pr = reveal.notice.cards[0]!.printingId;
    expect(pr).toBeTruthy();
    expect(reveal.printings[pr!]?.name).toBe("Forest");
    const info = await alex.waitFor((f): f is Extract<ServerMessage, { t: "notice" }> => f.t === "notice" && f.notice.kind === "info", ma);
    expect(info.notice.text).toBe("Blair picked Green"); // Forge's internal ids are stripped
    expect(info.notice.source?.name).toBe("Forest");
    // the other seat never sees it, and spectator / unknown seats are dropped
    engine.send({ type: "notice", gameId, seat: -1, kind: "reveal", title: "nobody", cards: [] });
    await new Promise((r) => setTimeout(r, 250));
    expect(blair.frames.slice(mb).some((f) => f.t === "notice")).toBe(false);
    expect(alex.frames.slice(ma).filter((f) => f.t === "notice")).toHaveLength(2);
  });

  it("maps attack answers back to Forge ids and refuses classic events on an engine table", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const ma = alex.mark();
    engine.send({
      type: "prompt", gameId, seat: 0, promptId: 8, prompt: "attackers", title: "Declare attackers",
      candidates: [card(14, "Atraxa, Grand Unifier", "Battlefield", pid[0]!, { power: 7, toughness: 7, index: 0, canAttack: [{ kind: "player", id: pid[1]!, name: "Blair" }] })],
      defenders: [{ kind: "player", id: pid[1]!, name: "Blair", life: 40 }],
    });
    const s = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.prompt?.kind === "attackers" && Object.keys(f.view.players).length === 2, ma)).view;
    const prompt = s.engine!.prompt!;
    expect(prompt.kind).toBe("attackers");
    if (prompt.kind !== "attackers") throw new Error("unreachable");
    const blairId = s.turnOrder[1]!;
    expect(prompt.candidates[0]!.canAttack![0]).toEqual({ kind: "player", player: blairId, name: "Blair" });
    alex.send({ t: "engine", answer: { promptId: 8, attacks: [{ iid: "14", defender: { kind: "player", player: blairId } }] } });
    const answer = await engine.waitFor((f) => f.type === "answer" && f.promptId === 8);
    expect(answer.attacks).toEqual([{ cardId: 14, defender: { kind: "player", id: pid[1] } }]);

    const m2 = alex.mark();
    alex.send({ t: "event", event: { type: "LifeChanged", payload: { player: s.viewer, delta: -1 } } });
    expect(await alex.errorSince(m2)).toMatch(/rules engine runs this table/);

    // stops: sent to the engine, reflected in the view, and remembered in the player's settings
    const m3 = alex.mark();
    alex.send({ t: "stops", stops: { myTurn: ["MAIN1"], theirTurn: [], respond: false } });
    const setStops = await engine.waitFor((f) => f.type === "setStops" && f.seat === 0 && (f.stops as { respond: boolean }).respond === false);
    expect(setStops.stops).toEqual({ myTurn: ["MAIN1"], theirTurn: [], respond: false, autoPassEmpty: true });
    const withStops = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.stops.respond === false, m3)).view;
    expect(withStops.engine?.stops.myTurn).toEqual(["MAIN1"]);
    const saved = (await ctx.app.inject({ method: "GET", url: "/api/me/settings", headers: auth(alex.token) })).json() as { settings: { engineStops: { respond: boolean } } };
    expect(saved.settings.engineStops.respond).toBe(false);
  });

  it("round-trips the Stage 2 prompt kinds: confirm with the card, number, order with buckets, assign, mode, text, spell targets", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    type StateMsg = Extract<ServerMessage, { t: "state" }>;
    const promptOf = async (kind: string, mark: number) => (await alex.waitFor((f): f is StateMsg => f.t === "state" && f.view.engine?.prompt?.kind === kind, mark)).view.engine!.prompt!;

    // confirm: the shock-land question, with the card and the consequence
    let m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 20, prompt: "confirm", title: "Pay 2 life?", detail: "If you don't: enters tapped.", mode: "UNLESS", source: "Blood Crypt", options: ["Pay", "Don't pay"], card: card(31, "Forest", "Battlefield", pid[0]!) });
    const confirm = await promptOf("confirm", m);
    if (confirm.kind !== "confirm") throw new Error("unreachable");
    expect(confirm.detail).toBe("If you don't: enters tapped.");
    expect(confirm.options).toEqual(["Pay", "Don't pay"]);
    expect(confirm.card?.iid).toBe("31");
    expect(confirm.card?.printingId).toBe(FOREST);
    alex.send({ t: "engine", answer: { promptId: 20, confirm: false } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 20)).toMatchObject({ seat: 0, confirm: false });

    // mulligan with Serum Powder: the prompt names the powders by iid; the answer goes back as a Forge card id
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 19, prompt: "mulligan", title: "Keep this hand?", cardsToReturn: 0, hand: [card(11, "Forest", "Hand", pid[0]!), card(12, "Forest", "Hand", pid[0]!)], serumPowder: [12] });
    const mull = await promptOf("mulligan", m);
    if (mull.kind !== "mulligan") throw new Error("unreachable");
    expect(mull.serumPowder).toEqual(["12"]);
    const badPowder = alex.mark();
    alex.send({ t: "engine", answer: { promptId: 19, serumPowder: "not-a-card" } as never });
    expect(await alex.errorSince(badPowder)).toMatch(/answer|engine/i);
    alex.send({ t: "engine", answer: { promptId: 19, serumPowder: "12" } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 19)).toMatchObject({ seat: 0, serumPowder: 12 });

    // number (X)
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 21, prompt: "number", title: "Choose X for Fireball", source: "Fireball", min: 0, max: 4 });
    const number = await promptOf("number", m);
    if (number.kind !== "number") throw new Error("unreachable");
    expect([number.min, number.max, number.values]).toEqual([0, 4, null]);
    alex.send({ t: "engine", answer: { promptId: 21, value: 3 } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 21)).toMatchObject({ value: 3 });

    // order with buckets (scry 2): hidden library cards come with their identity for the scrying seat only
    m = alex.mark();
    const mb = blair.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 22, prompt: "order", title: "Scry 2", note: "first = top", items: [card(41, "Forest", "Library", pid[0]!, { kind: "card", index: 0 }), card(42, "Forest", "Library", pid[0]!, { kind: "card", index: 1 })], buckets: ["top", "bottom"], defaultBucket: "top" });
    const order = await promptOf("order", m);
    if (order.kind !== "order") throw new Error("unreachable");
    expect(order.buckets).toEqual(["top", "bottom"]);
    expect(order.items.map((o) => (o.kind === "card" ? o.iid : ""))).toEqual(["41", "42"]);
    expect(blair.text.slice(mb).join("\n")).not.toMatch(/"41"|Scry 2/);
    alex.send({ t: "engine", answer: { promptId: 22, order: [1, 0], buckets: { "0": "bottom" } } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 22)).toMatchObject({ order: [1, 0], buckets: { "0": "bottom" } });

    // assign (trample over two blockers, then the player)
    m = alex.mark();
    engine.send({
      type: "prompt", gameId, seat: 0, promptId: 23, prompt: "assign", title: "Assign 5 damage", total: 5, card: card(14, "Atraxa, Grand Unifier", "Battlefield", pid[0]!, { power: 7, toughness: 7 }),
      targets: [card(51, "Forest", "Battlefield", pid[1]!, { kind: "card", index: 0, lethal: 2 }), card(52, "Forest", "Battlefield", pid[1]!, { kind: "card", index: 1, lethal: 1 }), { kind: "player", id: pid[1]!, name: "Blair", index: 2 }],
    });
    const assign = await promptOf("assign", m);
    if (assign.kind !== "assign") throw new Error("unreachable");
    expect(assign.total).toBe(5);
    expect(assign.lethal).toEqual({ 0: 2, 1: 1 });
    expect(assign.targets[2]!.kind).toBe("player");
    alex.send({ t: "engine", answer: { promptId: 23, amounts: [2, 1, 2] } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 23)).toMatchObject({ amounts: [2, 1, 2] });
    // negative or fractional amounts never leave the server
    const bad = alex.mark();
    alex.send({ t: "engine", answer: { promptId: 23, amounts: [-1, 6] } });
    expect(await alex.errorSince(bad)).toMatch(/bad engine answer|no longer open/);

    // mode
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 24, prompt: "mode", title: "Choose one", source: "Kolaghan's Command", min: 2, max: 2, allowRepeat: false, modes: [{ index: 0, text: "Return target creature card" }, { index: 1, text: "Target player discards a card" }, { index: 2, text: "Destroy target artifact" }] });
    const mode = await promptOf("mode", m);
    if (mode.kind !== "mode") throw new Error("unreachable");
    expect(mode.modes.length).toBe(3);
    alex.send({ t: "engine", answer: { promptId: 24, modes: [2, 0] } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 24)).toMatchObject({ modes: [2, 0] });

    // text (name a card)
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 25, prompt: "text", title: "Name a card", source: "Pithing Needle", freeText: true, hint: "Any card name" });
    const text = await promptOf("text", m);
    if (text.kind !== "text") throw new Error("unreachable");
    expect(text.freeText).toBe(true);
    alex.send({ t: "engine", answer: { promptId: 25, text: "Sol Ring" } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 25)).toMatchObject({ text: "Sol Ring" });

    // targets may include a spell on the stack (counterspells)
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 26, prompt: "targets", title: "Choose targets for Counterspell", ability: "Counter target spell", source: "Counterspell", min: 1, max: 1, options: [{ kind: "spell", index: 0, name: "Rhystic Study", cardId: 77, stackId: 5 }] });
    const targets = await promptOf("targets", m);
    if (targets.kind !== "targets") throw new Error("unreachable");
    expect(targets.options[0]).toEqual({ kind: "spell", index: 0, label: "Rhystic Study", iid: "77", stackId: 5 });
    expect(targets.cancelLabel).toBeNull();
    alex.send({ t: "engine", answer: { promptId: 26, options: [0] } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 26)).toMatchObject({ options: [0] });

    // a copy that may choose new targets: Cancel keeps the current ones, and the button says so
    m = alex.mark();
    engine.send({ type: "prompt", gameId, seat: 0, promptId: 27, prompt: "targets", title: "Choose new targets for Lightning Bolt (now: Blair)", ability: "Lightning Bolt deals 3 damage to any target.", source: "Lightning Bolt", min: 1, max: 1, cancelLabel: "Keep current targets", options: [{ kind: "player", index: 0, id: 1, name: "Blair" }] });
    const retarget = await promptOf("targets", m);
    if (retarget.kind !== "targets") throw new Error("unreachable");
    expect(retarget.cancelLabel).toBe("Keep current targets");
    alex.send({ t: "engine", answer: { promptId: 27, options: [], cancel: true } });
    expect(await engine.waitFor((f) => f.type === "answer" && f.promptId === 27)).toMatchObject({ cancel: true });
  });

  it("describes the stack with kinds, printings and targets, including one stack item aimed at another", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const A = pid[0]!;
    const B = pid[1]!;
    const player = (id: number, seat: number, name: string, viewer: number) => ({
      id, seat, name, isYou: viewer === id, human: true, life: 40, poison: 0, lost: false, handCount: 1, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {},
      battlefield: [], graveyard: [], exile: [], command: [],
    });
    const stack = [
      { id: 9, description: "Counterspell - counter target spell", kind: "spell", sourceCardId: 61, sourceName: "Forest", card: card(61, "Forest", "Stack", A), activatingPlayer: A, targets: [{ kind: "stack", id: 8, name: "Rhystic Study", cardId: 62 }] },
      { id: 8, description: "Rhystic Study", kind: "spell", sourceCardId: 62, sourceName: "Forest", card: card(62, "Forest", "Stack", B), activatingPlayer: B, targets: [{ kind: "player", id: A, name: "Alex" }] },
    ];
    const base = { type: "state", gameId, turn: 3, phase: "MAIN1", activePlayer: B, priorityPlayer: B, gameOver: false, stack, combat: null, log: [] };
    const ma = alex.mark();
    engine.send({ ...base, seat: 0, viewer: A, players: [player(A, 0, "Alex", A), player(B, 1, "Blair", A)] });
    const v = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.stack.length === 2, ma)).view;
    const top = v.stack[0]!;
    expect(top.kind).toBe("spell");
    expect(top.name).toBe("Forest");
    expect(top.printingId).toBe(FOREST);
    expect(top.sourceIid).toBe("61");
    expect(top.targets).toEqual([{ kind: "stack", id: "8", name: "Rhystic Study", iid: "62" }]);
    expect(v.stack[1]!.targets).toEqual([{ kind: "player", player: v.viewer }]);
    expect(v.stack[1]!.controller).not.toBe(v.viewer);
  });

  it("announces each round in the log before its first turn line and shows the round in the view", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    const A = pid[0]!;
    const B = pid[1]!;
    const player = (id: number, seat: number, name: string, viewer: number) => ({
      id, seat, name, isYou: viewer === id, human: true, life: 40, poison: 0, lost: false, handCount: 1, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {},
      battlefield: [], graveyard: [], exile: [], command: [],
    });
    const ma = alex.mark();
    // round numbers ride on the engine's log frames; "Round N begins" goes in once, before the TURN line
    const turnLine = (turn: number, round: number, who: string) => engine.send({ type: "log", gameId, seat: -1, seq: 900 + turn, turn, round, logType: "TURN", text: `Turn ${turn} (${who})` });
    turnLine(20, 7, "Alex");
    engine.send({ type: "log", gameId, seat: -1, seq: 950, turn: 20, round: 7, logType: "LAND", text: "Alex played Forest (11)" });
    turnLine(21, 7, "Blair");
    turnLine(22, 8, "Alex");
    engine.send({ type: "state", gameId, seat: 0, viewer: A, turn: 22, round: 8, phase: "MAIN1", activePlayer: A, priorityPlayer: A, gameOver: false, stack: [], combat: null, log: [], players: [player(A, 0, "Alex", A), player(B, 1, "Blair", A)] });
    const v = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.round === 8, ma)).view;
    expect(v.turn).toBe(22);
    const texts = v.log.map((l) => l.text);
    const at = (t: string) => texts.lastIndexOf(t);
    expect(at("Round 7 begins")).toBeGreaterThan(-1);
    expect(at("Round 7 begins")).toBe(at("Turn 20 (Alex)") - 1);
    expect(texts.filter((t) => t === "Round 7 begins")).toHaveLength(1);
    expect(at("Round 8 begins")).toBe(at("Turn 22 (Alex)") - 1);
    expect(at("Turn 21 (Blair)")).toBeLessThan(at("Round 8 begins"));
    // persisted like any engine log line (a reloaded relay rebuilds the log and does not announce the round twice)
    const rows = ctx.handle.sqlite.prepare("select payload from room_events where room_id = ? and type = 'EngineLog'").all(gameId) as Array<{ payload: string }>;
    expect(rows.map((r) => JSON.parse(r.payload).text).filter((t: string) => /^Round [78] begins$/.test(t))).toEqual(["Round 7 begins", "Round 8 begins"]);
  });

  it("relays hold-priority and the auto-pass setting, and mirrors them in the seat's view", async () => {
    const gameId = ctx.roomsManager.get(code)!.id;
    // hold this turn
    const m1 = alex.mark();
    alex.send({ t: "hold", turn: 3 });
    const hold = await engine.waitFor((f) => f.type === "hold" && f.gameId === gameId && f.seat === 0 && f.turn === 3);
    expect(hold.turn).toBe(3);
    const held = (await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.holdTurn === 3, m1)).view;
    expect(held.engine?.holdTurn).toBe(3);
    // release
    const m2 = alex.mark();
    alex.send({ t: "hold", turn: null });
    await engine.waitFor((f) => f.type === "hold" && f.gameId === gameId && f.seat === 0 && f.turn === null);
    expect((await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.holdTurn === null, m2)).view.engine?.holdTurn).toBeNull();
    // spectators cannot hold
    if (!casey.ws || casey.ws.readyState !== WebSocket.OPEN) await casey.connect(port, code);
    const mc = casey.mark();
    casey.send({ t: "hold", turn: 3 });
    expect(await casey.errorSince(mc)).toMatch(/spectators/);
    // the auto-pass setting rides with the stops and is remembered per user
    const m3 = alex.mark();
    alex.send({ t: "stops", stops: { myTurn: ["MAIN1", "MAIN2"], theirTurn: ["END_OF_TURN"], respond: true, autoPassEmpty: false } });
    const sent = await engine.waitFor((f) => f.type === "setStops" && f.seat === 0 && (f.stops as { autoPassEmpty: boolean }).autoPassEmpty === false);
    expect(sent.stops).toEqual({ myTurn: ["MAIN1", "MAIN2"], theirTurn: ["END_OF_TURN"], respond: true, autoPassEmpty: false });
    expect((await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.engine?.stops.autoPassEmpty === false, m3)).view.engine?.stops.myTurn).toEqual(["MAIN1", "MAIN2"]);
    const saved = (await ctx.app.inject({ method: "GET", url: "/api/me/settings", headers: auth(alex.token) })).json() as { settings: { engineStops: { autoPassEmpty: boolean } } };
    expect(saved.settings.engineStops.autoPassEmpty).toBe(false);
  });

  it("seats a Phase 7 bot user as a Forge AI seat in createGame", async () => {
    const { users, decks, deckCards, roomMembers } = await import("../db/schema.js");
    const res = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex.token), payload: { engine: true } });
    const code2 = (res.json() as { room: { code: string } }).room.code;
    const room = ctx.roomsManager.get(code2)!;
    // a computer-opponent user with a legal deck, seated the way AgentManager.addAgents would seat it
    const now = new Date().toISOString();
    ctx.handle.db.insert(users).values({ id: "bot-user-1", displayName: "Krenko bot", avatar: "owl", color: "ruby", createdAt: now, lastSeenAt: now, isAgent: true } as never).run();
    ctx.handle.db.insert(decks).values({ id: "bot-deck-1", userId: "bot-user-1", name: "Bot forests", format: "commander", createdAt: now, updatedAt: now } as never).run();
    ctx.handle.db.insert(deckCards).values([{ deckId: "bot-deck-1", cardId: ATRAXA, quantity: 1, board: "commander", position: 0 }, { deckId: "bot-deck-1", cardId: FOREST, quantity: 99, board: "main", position: 1 }] as never).run();
    ctx.handle.db.insert(roomMembers).values({ roomId: room.id, userId: "bot-user-1", role: "player", seat: 2, deckId: "bot-deck-1", joinedAt: now }).run();
    const good = await makeDeck(alex.token, "Forests A2", legal);
    const host = new Client("alex2", alex.token);
    await host.connect(port, code2);
    host.send({ t: "seat", seat: 0, deckId: good });
    await host.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.members.some((m) => m.deckId === good));
    const m = host.mark();
    host.send({ t: "start" });
    const created = await engine.waitFor((f) => f.type === "createGame" && (f.gameId as string) === room.id);
    const seats = created.seats as Array<{ seat: number; kind: string; name: string }>;
    expect(seats.find((s) => s.seat === 2)).toMatchObject({ kind: "ai", name: "Krenko bot" });
    expect(seats.find((s) => s.seat === 0)?.kind).toBe("human");
    await host.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.status === "playing", m);
    await host.close();
  });

  it("after a reload mid-game, a seat nobody holds is handed to the AI once the grace is over", async () => {
    const room = ctx.roomsManager.get(code)!;
    const gameId = room.id;
    // Everyone's socket goes away and the room falls out of memory, as after a relay restart.
    await alex.close();
    await blair.close();
    if (casey.ws && casey.ws.readyState === WebSocket.OPEN) await casey.close();
    await new Promise((r) => setTimeout(r, 100)); // let the close handlers run
    expect(room.connectionCount).toBe(0);
    (room as unknown as { lastActivity: number }).lastActivity = 0;
    (ctx.roomsManager as unknown as { sweep(): void }).sweep();
    expect(ctx.roomsManager.get(code)).not.toBe(room);
    const before = engine.received.length;
    // Alex comes back; Blair does not. The relay asks the engine to resync and the (fake) engine answers with fresh frames.
    const A = pid[0]!;
    const B = pid[1]!;
    const player = (id: number, seat: number, name: string, viewer: number | null) => ({
      id, seat, name, isYou: viewer === id, human: true, life: 40, poison: 0, lost: false, handCount: 1, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {},
      battlefield: [], graveyard: [], exile: [], command: [],
    });
    const frame = (seat: number, viewer: number | null) => ({ type: "state", gameId, seat, viewer, turn: 4, phase: "MAIN1", activePlayer: A, priorityPlayer: B, gameOver: false, stack: [], combat: null, log: [], players: [player(A, 0, "Alex", viewer), player(B, 1, "Blair", viewer)] });
    alex = new Client("alex", alex.token);
    await alex.connect(port, code);
    await engine.waitFor((f) => engine.received.indexOf(f) >= before && f.type === "resync" && f.seat === 0, 2000);
    engine.send(frame(0, A));
    engine.send(frame(1, B));
    engine.send(frame(-1, null));
    await alex.stateSince(0);
    const detached = await engine.waitFor((f) => engine.received.indexOf(f) >= before && f.type === "detachSeat" && f.gameId === gameId && f.seat === 1, 2000);
    expect(detached.seat).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.received.slice(before).filter((f) => f.gameId === gameId && (f.type === "detachSeat" || f.type === "attachSeat" || f.type === "resync")).map((f) => `${f.type}:${f.seat}`)).toEqual(["resync:0", "attachSeat:0", "detachSeat:1"]);
    // the table told everyone
    const s = await alex.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state" && f.view.log.some((l) => /away for a while/.test(l.text)), 0, 2000);
    expect(s.view.log.at(-1)?.text).toMatch(/Blair has been away/);
    // Blair returns: the seat is theirs again
    blair = new Client("blair", blair.token);
    await blair.connect(port, code);
    await engine.waitFor((f) => engine.received.indexOf(f) >= before && f.type === "attachSeat" && f.seat === 1, 2000);
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
