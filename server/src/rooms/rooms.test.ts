import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { CardPrinting, CreateRoomResponse, PlayerView, RegisterResponse, ServerMessage } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-rooms-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ID = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SOL_RING = ID(1);
const DELVER = ID(3);
const FIRE_ICE = ID(4);
const BONECRUSHER = ID(5);
const AKKI = ID(6);
const TREASURE = ID(7);
const BOLT = ID(8);
const ATRAXA = ID(10);
const FOREST = ID(11);
const SIGNET = ID(12);

/** A test client that records every frame it receives. */
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
  /** Wait until a frame matching `pred` arrives (counting frames already received after `from`). */
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, from = 0, timeoutMs = 3000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`${this.name}: timed out waiting for a frame`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  /** Frames received so far; pass to stateSince/errorSince to wait for what follows an action. */
  mark(): number {
    return this.frames.length;
  }
  async stateSince(mark: number): Promise<PlayerView> {
    const m = await this.waitFor((f): f is Extract<ServerMessage, { t: "state" }> => f.t === "state", mark);
    return m.view;
  }
  async errorSince(mark: number): Promise<string> {
    const m = await this.waitFor((f): f is Extract<ServerMessage, { t: "error" }> => f.t === "error", mark);
    return m.message;
  }
  lastView(): PlayerView {
    const m = [...this.frames].reverse().find((f) => f.t === "state") as Extract<ServerMessage, { t: "state" }> | undefined;
    if (!m) throw new Error("no state yet");
    return m.view;
  }
  nameOf(printingId: string | null): string {
    return printingId ? (this.printings[printingId]?.name ?? "?") : "(hidden)";
  }
  /** Everything this client has ever received, as one string, for leak checks. */
  everything(): string {
    return this.text.join("\n");
  }
}

describe("rooms over WebSocket", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let port = 0;
  let alex: Client;
  let blair: Client;
  let casey: Client;
  let code = "";
  let alexDeck = "";
  let blairDeck = "";

  const register = async (name: string, ip: string) => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip });
    return (res.json() as RegisterResponse).token;
  };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const makeDeck = async (token: string, name: string, commander: string, main: Array<[string, number]>) => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: auth(token),
      payload: { name, cards: [{ cardId: commander, quantity: 1, board: "commander" }, ...main.map(([cardId, quantity]) => ({ cardId, quantity, board: "main" }))] },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { deck: { id: string } }).deck.id;
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    await ctx.ingestor.run({ file: fixture });
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(new URL(address).port);
    alex = new Client("alex", await register("Alex", "10.0.0.1"));
    blair = new Client("blair", await register("Blair", "10.0.0.2"));
    casey = new Client("casey", await register("Casey", "10.0.0.3"));
    alexDeck = await makeDeck(alex.token, "Atraxa", ATRAXA, [
      [SIGNET, 1],
      [SOL_RING, 1],
      [BOLT, 1],
      [FOREST, 6],
    ]);
    blairDeck = await makeDeck(blair.token, "Akki", AKKI, [
      [DELVER, 1],
      [FIRE_ICE, 1],
      [BONECRUSHER, 1],
      [FOREST, 6],
    ]);
  });

  afterAll(async () => {
    for (const c of [alex, blair, casey]) if (c.ws && c.ws.readyState === WebSocket.OPEN) await c.close();
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a room with a 6-character code; others join by code", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex.token) });
    expect(res.statusCode).toBe(201);
    const body = res.json() as CreateRoomResponse;
    code = body.room.code;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(body.room.members[0]).toMatchObject({ name: "Alex", role: "player", seat: 0 });

    const bad = await ctx.app.inject({ method: "GET", url: "/api/rooms/ZZZZZZ", headers: auth(blair.token) });
    expect(bad.statusCode).toBe(404);
    const join = await ctx.app.inject({ method: "POST", url: `/api/rooms/${code.toLowerCase()}/join`, headers: auth(blair.token) });
    expect(join.statusCode).toBe(200);
    const mine = await ctx.app.inject({ method: "GET", url: "/api/rooms/mine", headers: auth(blair.token) });
    expect((mine.json() as { rooms: Array<{ code: string }> }).rooms[0]?.code).toBe(code);
  });

  it("refuses sockets without a valid token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws?token=not-a-real-token-at-all`);
    const closeCode = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(closeCode).toBe(4001);
  });

  it("seats players with decks, host starts, everyone gets their own view", async () => {
    await alex.connect(port, code);
    await blair.connect(port, code);
    await casey.connect(port, code);
    await casey.waitFor((m): m is Extract<ServerMessage, { t: "room" }> => m.t === "room");

    alex.send({ t: "seat", seat: 0, deckId: alexDeck });
    let m = blair.mark();
    blair.send({ t: "seat", seat: 0, deckId: blairDeck });
    expect(await blair.errorSince(m)).toMatch(/taken/);
    blair.send({ t: "seat", seat: 1, deckId: blairDeck });
    m = blair.mark();
    blair.send({ t: "start" });
    expect(await blair.errorSince(m)).toMatch(/host/);

    const marks = [alex.mark(), blair.mark(), casey.mark()] as const;
    alex.send({ t: "start" });
    const va = await alex.stateSince(marks[0]);
    const vb = await blair.stateSince(marks[1]);
    const vc = await casey.stateSince(marks[2]);
    expect(va.phase).toBe("mulligan");
    expect(va.viewer).not.toBeNull();
    expect(vc.viewer).toBeNull();
    const alexId = va.viewer!;
    const blairId = vb.viewer!;
    expect(va.players[alexId]!.hand.cards).toHaveLength(7);
    expect(va.players[alexId]!.library.count).toBe(2);
    expect(vb.players[alexId]!.hand.cards).toHaveLength(0);
    expect(vb.players[alexId]!.hand.count).toBe(7);
    expect(vb.players[blairId]!.hand.cards).toHaveLength(7);
    expect(vc.players[alexId]!.hand.cards).toHaveLength(0);
    expect(vc.players[blairId]!.hand.cards).toHaveLength(0);
    expect(alex.nameOf(va.players[alexId]!.command[0]!.printingId)).toBe("Atraxa, Praetors' Voice");
    expect(blair.nameOf(vb.players[alexId]!.command[0]!.printingId)).toBe("Atraxa, Praetors' Voice");
  });

  it("never sends hidden identities over the wire (libraries, other hands, face-down), and the seed never leaves", async () => {
    const room = ctx.roomsManager.get(code)!;
    const truth = room.currentState()!;
    const alexId = alex.lastView().viewer!;
    const blairId = blair.lastView().viewer!;
    // Everything in either library is hidden from everyone, including its owner. (A basic land
    // that also sits in the viewer's own hand is legitimately known by printing id, so for those
    // only the instance id must be absent.)
    for (const p of Object.values(truth.players)) {
      for (const iid of p.zones.library) {
        const c = truth.cards[iid]!;
        for (const client of [alex, blair, casey]) {
          expect(client.everything()).not.toContain(c.iid);
          if (client.printings[c.printing!.id]) continue;
          expect(client.everything()).not.toContain(c.printing!.id);
          expect(client.everything()).not.toContain(c.printing!.name);
        }
      }
    }
    // Alex's hand is visible only to Alex (printing ids are what carry identity on the wire).
    for (const iid of truth.players[alexId]!.zones.hand) {
      const c = truth.cards[iid]!;
      expect(alex.everything()).toContain(c.printing!.id);
      expect(alex.everything()).toContain(c.iid);
      expect(blair.everything()).not.toContain(c.iid);
      expect(casey.everything()).not.toContain(c.iid);
      if (c.printing!.name !== "Forest") {
        expect(blair.everything()).not.toContain(c.printing!.id);
        expect(casey.everything()).not.toContain(c.printing!.id);
      }
    }
    for (const iid of truth.players[blairId]!.zones.hand) {
      const c = truth.cards[iid]!;
      expect(blair.everything()).toContain(c.printing!.id);
      expect(alex.everything()).not.toContain(c.iid);
      if (c.printing!.name !== "Forest") expect(alex.everything()).not.toContain(c.printing!.id);
    }
    const seed = (ctx.handle.sqlite.prepare("select seed from rooms").get() as { seed: string }).seed;
    expect(seed.length).toBeGreaterThan(10);
    for (const client of [alex, blair, casey]) {
      expect(client.everything()).not.toContain(seed);
      expect(client.everything()).not.toContain('"rng"');
    }
  });

  it("enforces who may act: spectators cannot, hands are private, host-only start", async () => {
    const alexId = alex.lastView().viewer!;
    const blairId = blair.lastView().viewer!;
    let m = alex.mark();
    alex.send({ t: "event", event: { type: "HandKept", payload: { player: alexId } } });
    await alex.stateSince(m);
    m = blair.mark();
    blair.send({ t: "event", event: { type: "HandKept", payload: { player: blairId } } });
    const v = await blair.stateSince(m);
    expect(v.phase).toBe("playing");

    m = casey.mark();
    casey.send({ t: "event", event: { type: "LifeChanged", payload: { player: alexId, delta: -1 } } });
    expect(await casey.errorSince(m)).toMatch(/spectator/);

    const alexHand = alex.lastView().players[alexId]!.hand.cards[0]!;
    blair.send({ t: "event", event: { type: "CardMoved", payload: { iid: alexHand.iid, to: { kind: "graveyard", owner: alexId } } }, cid: "x1" });
    const err = await blair.waitFor((m): m is Extract<ServerMessage, { t: "error" }> => m.t === "error" && m.cid === "x1");
    expect(err.message).toMatch(/owner/);

    m = blair.mark();
    blair.send({ t: "event", event: { type: "Nope", payload: {} } });
    expect(await blair.errorSince(m)).toMatch(/unknown event/);
    m = blair.mark();
    blair.send({ t: "event", event: { type: "GameStarted", payload: {} } });
    expect(await blair.errorSince(m)).toMatch(/not sent directly/);
  });

  it("library searches show the owner only (nothing reaches other sockets); other players' cards cannot be touched", async () => {
    const room = ctx.roomsManager.get(code)!;
    const alexId = alex.lastView().viewer!;
    const truth = room.currentState()!;
    const libraryIids = truth.players[alexId]!.zones.library.slice();
    expect(libraryIids.length).toBeGreaterThan(0);
    let m = alex.mark();
    const mb = blair.mark();
    const mc = casey.mark();
    alex.send({ t: "event", event: { type: "LibrarySearched", payload: { player: alexId } } });
    const va = await alex.stateSince(m);
    await blair.stateSince(mb);
    await casey.stateSince(mc);
    expect(va.players[alexId]!.library.known.map((c) => c.iid).sort()).toEqual(libraryIids.slice().sort());
    expect(va.log.at(-1)!.text).toBe("Alex searched their library");
    for (const iid of libraryIids) {
      expect(blair.everything()).not.toContain(iid);
      expect(casey.everything()).not.toContain(iid);
    }
    expect(blair.lastView().players[alexId]!.library.known).toHaveLength(0);
    expect(casey.lastView().players[alexId]!.library.known).toHaveLength(0);
    // Nobody else may search, look at or shuffle it.
    m = blair.mark();
    blair.send({ t: "event", event: { type: "LibrarySearched", payload: { player: alexId } } });
    expect(await blair.errorSince(m)).toMatch(/only the owner/);
    m = blair.mark();
    blair.send({ t: "event", event: { type: "LibraryLooked", payload: { player: alexId, count: 2 } } });
    expect(await blair.errorSince(m)).toMatch(/only the owner/);
    // Ownership guardrails over the wire: Blair cannot untap Alex's permanents or move Alex's cards; Casey (spectator) cannot attack.
    m = blair.mark();
    blair.send({ t: "event", event: { type: "UntapAll", payload: { player: alexId } } });
    expect(await blair.errorSince(m)).toMatch(/only that player/);
    const alexCommander = alex.lastView().players[alexId]!.command[0]!;
    m = blair.mark();
    blair.send({ t: "event", event: { type: "CardMoved", payload: { iid: alexCommander.iid, to: { kind: "graveyard", owner: alexId } } } });
    expect(await blair.errorSince(m)).toMatch(/only the owner/);
    m = casey.mark();
    casey.send({ t: "event", event: { type: "AttackersDeclared", payload: { attacks: [{ iid: alexCommander.iid, player: alexId }] } } });
    expect(await casey.errorSince(m)).toMatch(/spectator/);
    // A shuffle forgets what the search showed.
    m = alex.mark();
    alex.send({ t: "event", event: { type: "LibraryShuffled", payload: { player: alexId } } });
    expect((await alex.stateSince(m)).players[alexId]!.library.known).toHaveLength(0);
  });

  it("playing a card reveals it to everyone; tokens come from real printings only; undo and revert", async () => {
    const alexId = alex.lastView().viewer!;
    const blairId = blair.lastView().viewer!;
    const hand = alex.lastView().players[alexId]!.hand.cards;
    const played = hand[0]!;
    const playedName = alex.nameOf(played.printingId);
    let m = blair.mark();
    alex.send({ t: "event", event: { type: "CardMoved", payload: { iid: played.iid, to: { kind: "battlefield", owner: alexId } } } });
    const vb = await blair.stateSince(m);
    const onField = Object.values(vb.players[alexId]!.battlefield).flat().find((c) => c.iid === played.iid)!;
    expect(onField.printingId).toBe(played.printingId);
    expect(blair.nameOf(onField.printingId)).toBe(playedName);
    expect(vb.players[alexId]!.hand.count).toBe(6);
    expect(vb.log.at(-1)!.text).toContain(playedName);

    // Undo: Alex acted last, so Alex may take it back.
    m = blair.mark();
    alex.send({ t: "undo" });
    const vb2 = await blair.stateSince(m);
    expect(vb2.players[alexId]!.hand.count).toBe(7);
    // Quiet undo: the "played" line is gone and nothing else was added.
    expect(vb2.log.at(-1)!.text).not.toContain(playedName);
    expect(vb2.log.map((l) => l.text).join("\n")).not.toMatch(/undo|revert/i);

    // A forged printing is replaced by the real one; an unknown id is refused.
    m = blair.mark();
    blair.send({ t: "event", event: { type: "TokenCreated", payload: { player: blairId, printing: { id: TREASURE, name: "Black Lotus", typeLine: "Artifact" }, custom: null, count: 2, row: "other" } } });
    const vb3 = await blair.stateSince(m);
    const tokens = vb3.players[blairId]!.battlefield.other;
    expect(tokens).toHaveLength(2);
    expect(blair.nameOf(tokens[0]!.printingId)).toBe("Treasure");
    expect(blair.everything()).not.toContain("Black Lotus");
    m = blair.mark();
    blair.send({ t: "event", event: { type: "TokenCreated", payload: { player: blairId, printing: { id: "nope" }, custom: null, count: 1, row: "other" } } });
    expect(await blair.errorSince(m)).toMatch(/unknown token/);

    // Blair acted since, so Alex cannot undo; an explicit revert works and is logged.
    m = alex.mark();
    alex.send({ t: "undo" });
    expect(await alex.errorSince(m)).toMatch(/someone else/i);
    const seqBeforeTokens = vb2.seq;
    m = blair.mark();
    alex.send({ t: "revert", toSeq: seqBeforeTokens });
    const vb4 = await blair.stateSince(m);
    expect(vb4.players[blairId]!.battlefield.other).toHaveLength(0);
    expect(vb4.log.at(-1)!.text).toMatch(/reverted the game to #\d+/);
  });

  it("reconnect: a client that drops rejoins by replaying the persisted log, even after a server restart", async () => {
    const alexId = alex.lastView().viewer!;
    const before = alex.lastView();
    const handBefore = before.players[alexId]!.hand.cards.map((c) => c.printingId);
    await alex.close();
    await blair.close();
    await casey.close();
    await ctx.app.close();

    ctx = await buildApp({ logger: false });
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    port = Number(new URL(address).port);
    const again = new Client("alex2", alex.token);
    await again.connect(port, code);
    const view = await again.stateSince(0);
    expect(view.seq).toBe(before.seq);
    expect(view.phase).toBe("playing");
    expect(view.players[alexId]!.hand.cards.map((c) => c.printingId)).toEqual(handBefore);
    expect(view.log.map((l) => l.text)).toEqual(before.log.map((l) => l.text));
    // Printings arrive again on the fresh connection.
    expect(Object.keys(again.printings).length).toBeGreaterThan(0);
    await again.close();
    alex = again;
  });

  it("rematch: once the game has ended the host opens a new table with the same seats and decks", async () => {
    await alex.connect(port, code);
    await blair.connect(port, code);
    const alexId = (await alex.stateSince(0)).viewer!;
    const blairId = (await blair.stateSince(0)).viewer!;
    let m = alex.mark();
    alex.send({ t: "rematch" });
    expect(await alex.errorSince(m)).toMatch(/still going/);
    m = blair.mark();
    blair.send({ t: "event", event: { type: "PlayerConceded", payload: { player: blairId } } });
    const ended = await blair.stateSince(m);
    expect(ended.phase).toBe("ended");
    expect(ended.winner).toBe(alexId);
    m = alex.mark();
    blair.send({ t: "rematch" });
    expect(await blair.errorSince(blair.mark() - 1)).toMatch(/host/);
    alex.send({ t: "rematch" });
    const info = await alex.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.nextCode !== null, m);
    const nextCode = info.room.nextCode!;
    expect(nextCode).not.toBe(code);
    // Everyone at the old table learns the new code too.
    const blairInfo = await blair.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room" && f.room.nextCode === nextCode);
    expect(blairInfo.room.status).toBe("ended");
    await alex.close();
    await blair.close();

    const alex2 = new Client("alex3", alex.token);
    const blair2 = new Client("blair3", blair.token);
    await alex2.connect(port, nextCode);
    await blair2.connect(port, nextCode);
    const fresh = await alex2.stateSince(0);
    expect(fresh.phase).toBe("mulligan");
    expect(fresh.seq).toBe(1);
    expect(fresh.players[alexId]!.seat).toBe(0);
    expect(fresh.players[blairId]!.seat).toBe(1);
    expect(fresh.players[alexId]!.hand.cards).toHaveLength(7);
    expect(alex2.nameOf(fresh.players[alexId]!.command[0]!.printingId)).toBe("Atraxa, Praetors' Voice");
    const room2 = await alex2.waitFor((f): f is Extract<ServerMessage, { t: "room" }> => f.t === "room");
    expect(room2.room.hostId).toBe(alexId);
    expect(room2.room.members.find((x) => x.userId === blairId)?.seat).toBe(1);
    // A fresh seed: a second press is idempotent and does not open a third room.
    alex2.send({ t: "rematch" });
    expect(await alex2.errorSince(alex2.mark() - 1)).toMatch(/still going/);
    await alex2.close();
    await blair2.close();
    alex = alex2;
    blair = blair2;
  });
});
