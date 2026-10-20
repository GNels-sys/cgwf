import type { FastifyBaseLogger } from "fastify";
import {
  DEFAULT_ENGINE_STOPS,
  ENGINE_PHASES,
  STARTING_LIFE,
  SYSTEM_ACTOR,
  type CardPrinting,
  type EngineAnswer,
  type EngineNotice,
  type EnginePhase,
  type EnginePrompt,
  type EngineStops,
  type EventInput,
  type GameEvent,
  type GameStartedPayload,
  type LogEntry,
  type PlayerId,
  type ServerMessage,
} from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import type { RoomMemberRow, RoomRow } from "../db/schema.js";
import type { EngineClient, EngineFrame } from "../engine/client.js";
import { deckForEngine } from "../engine/deck.js";
import type { EngineCardRef, PrintingMapper } from "../engine/mapping.js";
import { cleanEngineText, engineToView, toEngineAnswer, toEnginePrompt, type ConvertContext, type EngineCardJson, type EngineStateJson, type SeatInfo } from "../engine/view.js";
import { loadSettings, saveEngineStops } from "../settings.js";
import type { GameResults } from "../stats/results.js";
import type { DecisionRecorder } from "../coach/snapshots.js";

/**
 * The engine side of a LiveRoom: talks to the rules engine for one table and turns its frames into
 * the per-player `state` frames the browser already understands.
 *
 * The relay rule that keeps hidden information hidden: a frame the engine sent for seat N is only
 * ever rendered to sockets of the user sitting in seat N; the spectator frame (seat -1) goes to
 * everyone else. Nothing is ever merged across seats.
 */

export class EngineRoomError extends Error {}

/** What the engine table needs from its LiveRoom (kept small so the two files stay readable). */
export interface RoomPort {
  readonly id: string;
  readonly handle: DbHandle;
  readonly log: FastifyBaseLogger;
  row(): RoomRow;
  members(): RoomMemberRow[];
  connections(): Iterable<{ userId: string; sentPrintings: Set<string>; send: (msg: ServerMessage) => void }>;
  /** Persist an engine-only event (no reducer) and bump last_seq / status. */
  appendEngine(actor: string, input: EventInput, status?: "playing" | "ended"): GameEvent;
  loadedEvents(): GameEvent[];
  saveEngineState(json: string): void;
  broadcastRoom(): void;
  userName(userId: string): string;
  /** Phase 7 computer-opponent users seated here (on engine tables they become Forge AI seats). */
  agentIds(): Set<string>;
  /** Deck-statistics recorder (null when the server has none wired, e.g. some tests). */
  results(): GameResults | null;
  /** AI Coach M1: decision snapshots of human seats (null = not wired). */
  decisions(): DecisionRecorder | null;
}

interface PersistedState {
  seats: SeatInfo[];
  cards: Array<{ cardId: number; printingId: string | null }>;
  gameOver?: { winner: PlayerId | null; endReason: string | null; turns: number } | undefined;
}

const SPECTATOR = -1;
/** A seat whose sockets are all gone keeps the game waiting this long before the AI takes over. */
export const ABSENT_GRACE_MS = Number(process.env.ENGINE_ABSENT_GRACE_MS ?? 3 * 60 * 1000);

/** The relay's own log line for a new round (see the engine's RoundTracker). */
const ROUND_LINE = /^Round (\d+) begins$/;

export class EngineTable {
  private seats: SeatInfo[] = [];
  private readonly lastState = new Map<number, EngineStateJson>();
  private readonly prompts = new Map<number, { raw: Record<string, unknown>; prompt: EnginePrompt }>();
  private readonly stops = new Map<number, EngineStops>();
  /** Seats holding priority this turn (turn number), cleared when the engine reports a later turn. */
  private readonly holds = new Map<number, number>();
  private log: LogEntry[] = [];
  private seq = 0;
  private noticeSeq = 0;
  /** Set when the table was closed without a result (see close()). */
  private closedReason: string | null = null;
  private loaded = false;
  private cardsPersisted = 0;
  engineDown = false;
  /** Seats with no socket left: the timer hands the seat to the AI when it fires (cleared on reattach). */
  private readonly absentTimers = new Map<number, NodeJS.Timeout>();
  /** The last round announced in the log ("Round N begins"), restored from the event log on load. */
  private roundLogged = 0;
  private disposed = false;

  constructor(
    private readonly room: RoomPort,
    private readonly client: EngineClient,
    private readonly mapper: PrintingMapper,
  ) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = this.room.row().engineState;
    if (raw) {
      try {
        const persisted = JSON.parse(raw) as PersistedState;
        this.seats = persisted.seats ?? [];
        this.mapper.restore(persisted.cards ?? []);
        this.cardsPersisted = persisted.cards?.length ?? 0;
      } catch (err) {
        this.room.log.warn({ err }, "engine_state unreadable");
      }
    }
    for (const ev of this.room.loadedEvents()) {
      if (ev.type !== "EngineLog") continue;
      this.log.push({ seq: ev.seq, actor: SYSTEM_ACTOR, text: cleanEngineText(ev.payload.text), ts: ev.ts });
      const round = ROUND_LINE.exec(ev.payload.text);
      if (round) this.roundLogged = Math.max(this.roundLogged, Number(round[1]));
    }
    this.seq = this.room.loadedEvents().length;
    // Loaded mid-game (the relay restarted, or the room was evicted while the engine kept playing): the
    // engine may be waiting on a seat whose socket died with the old process and will not come back.
    // Give every seat that is not connected right now the usual grace, then hand it to the AI.
    if (this.room.row().status === "playing") {
      const online = new Set<string>();
      for (const c of this.room.connections()) online.add(c.userId);
      for (const s of this.seats) if (!online.has(s.userId)) this.armAbsent(s.seat);
    }
  }

  private persist(extra?: Partial<PersistedState>): void {
    const state: PersistedState = { seats: this.seats, cards: this.mapper.entries(), ...extra };
    this.room.saveEngineState(JSON.stringify(state));
    this.cardsPersisted = state.cards.length;
  }

  private seatOf(userId: string): number | null {
    return this.seats.find((s) => s.userId === userId)?.seat ?? null;
  }

  // ------------------------------------------------------------ start

  /** Host starts: convert every seated deck, refuse illegal ones, ask the engine for a game. */
  async start(hostUserId: string): Promise<void> {
    this.ensureLoaded();
    const row = this.room.row();
    if (row.hostUserId !== hostUserId) throw new EngineRoomError("only the host can start the game");
    if (row.status !== "lobby") throw new EngineRoomError("the game has already started");
    if (!this.client.connected) throw new EngineRoomError("the rules engine is not reachable right now; try again in a moment");
    const seated = this.room.members().filter((m) => m.role === "player" && m.seat !== null);
    if (seated.length < 2) throw new EngineRoomError("need at least two seated players");
    const seatsReq: Array<{ seat: number; kind: "human" | "ai"; name: string; deck: unknown }> = [];
    const problems: string[] = [];
    const infos: Array<{ seat: number; userId: string; name: string }> = [];
    const bots = this.room.agentIds();
    for (const m of seated) {
      const name = this.room.userName(m.userId);
      if (!m.deckId) throw new EngineRoomError(`${name} has not picked a deck`);
      const d = deckForEngine(this.room.handle, m.userId, m.deckId);
      if (!d) throw new EngineRoomError(`${name}'s deck was not found`);
      if (d.problems.length) problems.push(`${name} (${d.deck.name}): ${d.problems.join(" ")}`);
      seatsReq.push({ seat: m.seat as number, kind: bots.has(m.userId) ? "ai" : "human", name, deck: d.deck });
      infos.push({ seat: m.seat as number, userId: m.userId, name });
    }
    if (problems.length) throw new EngineRoomError(`The rules engine needs legal Commander decks. ${problems.join(" | ")}`);
    const seed = Number.parseInt(row.seed.slice(0, 12), 16) || Date.now();
    const created = await this.client.createGame(row.id, seed, seatsReq);
    const missing = created.players.filter((p) => p.missing.length).map((p) => `${p.name}: ${p.missing.join(", ")}`);
    if (missing.length) {
      this.client.trySend({ type: "endGame", gameId: row.id });
      throw new EngineRoomError(`The rules engine does not know these cards yet: ${missing.join(" | ")}`);
    }
    this.seats = infos.map((i) => ({ ...i, playerId: created.players.find((p) => p.seat === i.seat)?.playerId ?? -1 }));
    this.persist();
    // deck statistics: freeze the table bracket, the test flag and every seat's deck now
    try {
      this.room.results()?.recordStart(
        { id: row.id, code: row.code, testGame: Boolean(row.testGame), tableBracket: row.tableBracket ?? null },
        seated.map((m) => ({ seat: m.seat as number, userId: m.userId, isBot: bots.has(m.userId), deckId: m.deckId as string })),
      );
    } catch (err) {
      this.room.log.error({ err }, "recording the game start failed");
    }
    // Each player's remembered stops (Personalize / the table's Stops panel) apply from the first priority.
    for (const s of this.seats) {
      const stops = loadSettings(this.room.handle, s.userId).engineStops;
      this.stops.set(s.seat, stops);
      this.client.trySend({ type: "setStops", gameId: row.id, seat: s.seat, stops });
    }
    const payload: GameStartedPayload = { players: this.seats.map((s) => ({ id: s.userId, name: s.name, seat: s.seat })), decks: {}, startingLife: STARTING_LIFE };
    this.room.appendEngine(SYSTEM_ACTOR, { type: "GameStarted", payload }, "playing");
    this.log.push({ seq: this.seq + 1, actor: SYSTEM_ACTOR, text: "The rules engine started the game.", ts: Date.now() });
    this.seq++;
    this.room.broadcastRoom();
  }

  // ------------------------------------------------------------ frames from the engine

  onFrame(frame: EngineFrame): void {
    this.ensureLoaded();
    const seat = typeof frame.seat === "number" ? frame.seat : SPECTATOR;
    switch (frame.type) {
      case "cards": {
        const list = Array.isArray(frame.cards) ? (frame.cards as Array<EngineCardJson & { cardId: number }>) : [];
        for (const c of list) this.mapper.learn(c.cardId, { name: c.name ?? "", scryfallSet: c.scryfallSet, set: c.set, number: c.number });
        this.persist();
        break;
      }
      case "state": {
        this.seq++;
        this.lastState.set(seat, frame as unknown as EngineStateJson);
        const turn = (frame as unknown as EngineStateJson).turn;
        for (const [s, held] of this.holds) if (typeof turn === "number" && turn > held) this.holds.delete(s);
        // A fresh state for a seat means its earlier prompt view is stale, not its prompt.
        this.sendSeat(seat);
        if (this.mapper.entries().length !== this.cardsPersisted) this.persist();
        break;
      }
      case "prompt": {
        this.seq++;
        const raw = frame as Record<string, unknown>;
        if (raw.view && typeof raw.view === "object") this.lastState.set(seat, raw.view as EngineStateJson);
        const prompt = toEnginePrompt(raw, this.ctx(null));
        if (prompt) this.prompts.set(seat, { raw, prompt });
        else this.room.log.warn({ prompt: raw.prompt }, "unknown engine prompt kind");
        this.sendSeat(seat);
        // everyone else learns who the table is waiting on
        for (const s of this.seats) if (s.seat !== seat) this.sendSeat(s.seat, true);
        this.sendSeat(SPECTATOR, true);
        break;
      }
      case "log": {
        const text = cleanEngineText(String(frame.text ?? "")); // Forge names cards with internal ids: "Shock (108)"
        // The first turn of a new round: "Round N begins" goes in just before Forge's "Turn T (player)" line.
        const round = typeof frame.round === "number" ? frame.round : 0;
        if (String(frame.logType ?? "") === "TURN" && round > this.roundLogged) {
          this.roundLogged = round;
          const rt = `Round ${round} begins`;
          const rev = this.room.appendEngine(SYSTEM_ACTOR, { type: "EngineLog", payload: { engineSeq: 0, turn: Number(frame.turn ?? 0), logType: "ROUND", text: rt } });
          this.log.push({ seq: rev.seq, actor: SYSTEM_ACTOR, text: rt, ts: rev.ts });
          this.seq = rev.seq;
        }
        const ev = this.room.appendEngine(SYSTEM_ACTOR, { type: "EngineLog", payload: { engineSeq: Number(frame.seq ?? 0), turn: Number(frame.turn ?? 0), logType: String(frame.logType ?? ""), text } });
        this.log.push({ seq: ev.seq, actor: SYSTEM_ACTOR, text, ts: ev.ts });
        this.seq = ev.seq;
        break;
      }
      case "gameOver": {
        const winnerSeat = typeof frame.winnerSeat === "number" ? frame.winnerSeat : null;
        const winner = winnerSeat === null ? null : (this.seats.find((s) => s.seat === winnerSeat)?.userId ?? null);
        const payload = { winner, endReason: frame.endReason == null ? null : String(frame.endReason), turns: Number(frame.turns ?? 0) };
        try {
          const results = Array.isArray(frame.results) ? (frame.results as Array<{ seat: number; place?: number; won?: boolean; conceded?: boolean }>) : [];
          this.room.results()?.recordFinish(this.room.id, { winnerSeat, endReason: payload.endReason, turns: payload.turns, results }, this.closedReason);
        } catch (err) {
          this.room.log.error({ err }, "recording the game result failed");
        }
        if (this.closedReason || this.room.row().status === "ended") break; // the table was closed first: already ended
        this.room.appendEngine(SYSTEM_ACTOR, { type: "EngineGameOver", payload }, "ended");
        this.prompts.clear();
        this.dispose();
        this.persist({ gameOver: payload });
        this.seq++;
        this.broadcast();
        this.room.broadcastRoom();
        break;
      }
      case "notice": {
        // Shown to ONE seat: the engine sends a notice only for cards Forge revealed to that player.
        if (seat === SPECTATOR) break;
        const user = this.seats.find((s) => s.seat === seat)?.userId;
        if (!user) break;
        const printings: Record<string, CardPrinting> = {};
        const toCard = (raw: unknown): { name: string; printingId: string | null } => {
          const c = (raw ?? {}) as EngineCardRef;
          const name = typeof c.name === "string" && c.name ? c.name : "a card";
          const p = typeof c.name === "string" && c.name ? this.mapper.resolve(c) : null;
          if (p) printings[p.id] = p;
          return { name, printingId: p?.id ?? null };
        };
        const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
        const src = list(frame.source)[0];
        const notice: EngineNotice = {
          id: ++this.noticeSeq,
          kind: frame.kind === "reveal" ? "reveal" : "info",
          title: cleanEngineText(String(frame.title ?? "")),
          text: frame.text == null ? null : cleanEngineText(String(frame.text)),
          cards: list(frame.cards).slice(0, 60).map(toCard),
          source: src === undefined ? null : toCard(src),
        };
        for (const conn of this.room.connections()) if (conn.userId === user) conn.send({ t: "notice", notice, printings });
        break;
      }
      case "error": {
        const message = String(frame.message ?? "engine error");
        if (message.startsWith("unknown gameId") && this.room.row().status === "playing") this.lostGame();
        else this.sendError(seat, message);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Close the table without a result (host "End table", the owner, or the idle sweep): the engine game is
   * torn down (Forge ends it as a draw on its own thread; that frame is ignored here), the room ends now
   * (the engine may be unreachable), and the game is recorded as abandoned, never counted.
   */
  close(reason: string): void {
    this.ensureLoaded();
    const row = this.room.row();
    if (row.status === "ended") return;
    this.closedReason = reason;
    if (row.status === "playing") this.client.trySend({ type: "endGame", gameId: this.room.id });
    this.room.results()?.abandon(this.room.id, reason);
    const payload = { winner: null, endReason: reason, turns: this.lastState.get(SPECTATOR)?.turn ?? 0 };
    this.room.appendEngine(SYSTEM_ACTOR, { type: "EngineGameOver", payload }, "ended");
    this.log.push({ seq: this.seq + 1, actor: SYSTEM_ACTOR, text: reason, ts: Date.now() });
    this.prompts.clear();
    this.dispose();
    this.persist({ gameOver: payload });
    this.seq++;
    this.broadcast();
    this.room.broadcastRoom();
  }

  /** The engine forgot the game (it restarted): end the table honestly. */
  private lostGame(): void {
    this.room.results()?.abandon(this.room.id, "the rules engine restarted");
    const payload = { winner: null, endReason: "The rules engine restarted and lost this game.", turns: this.lastState.get(SPECTATOR)?.turn ?? 0 };
    this.room.appendEngine(SYSTEM_ACTOR, { type: "EngineGameOver", payload }, "ended");
    this.log.push({ seq: this.seq + 1, actor: SYSTEM_ACTOR, text: payload.endReason, ts: Date.now() });
    this.prompts.clear();
    this.persist({ gameOver: payload });
    this.seq++;
    this.broadcast();
    this.room.broadcastRoom();
  }

  onEngineReconnected(): void {
    this.engineDown = false;
    if (this.room.row().status !== "playing") return;
    for (const s of this.seats) this.client.trySend({ type: "resync", gameId: this.room.id, seat: s.seat });
    this.client.trySend({ type: "resync", gameId: this.room.id, seat: SPECTATOR });
    this.broadcast();
  }

  onEngineDown(): void {
    this.engineDown = true;
    if (this.room.row().status === "playing") this.broadcast();
  }

  // ------------------------------------------------------------ messages from players

  answer(userId: string, answer: EngineAnswer): void {
    this.ensureLoaded();
    const seat = this.seatOf(userId);
    if (seat === null) throw new EngineRoomError("spectators cannot act");
    const open = this.prompts.get(seat);
    if (!open || open.prompt.promptId !== answer.promptId) throw new EngineRoomError("that prompt is no longer open");
    const out = toEngineAnswer(answer, this.ctx(userId));
    if ("passUntilTurn" in answer && answer.passUntilTurn !== undefined) this.holds.delete(seat); // "End turn" releases a hold (the engine does the same)
    this.client.send({ type: "answer", gameId: this.room.id, seat, ...out });
    this.prompts.delete(seat);
    this.room.appendEngine(userId, { type: "EngineAnswer", payload: { seat, promptId: answer.promptId, prompt: open.prompt.kind, answer: out } });
    this.seq++;
    // AI Coach: what this human seat saw and chose (its own audited prompt view only); async, never fails the game
    try {
      this.room.decisions()?.record({ roomId: this.room.id, seat, userId, seq: this.seq }, open.raw, out);
    } catch (err) {
      this.room.log.warn({ err }, "decision snapshot failed");
    }
    this.sendSeat(seat);
  }

  setStops(userId: string, stops: EngineStops): void {
    this.ensureLoaded();
    const seat = this.seatOf(userId);
    if (seat === null) throw new EngineRoomError("spectators have no stops");
    const clean: EngineStops = {
      myTurn: (Array.isArray(stops.myTurn) ? stops.myTurn : []).filter((p): p is EnginePhase => (ENGINE_PHASES as readonly string[]).includes(p)),
      theirTurn: (Array.isArray(stops.theirTurn) ? stops.theirTurn : []).filter((p): p is EnginePhase => (ENGINE_PHASES as readonly string[]).includes(p)),
      respond: stops.respond !== false,
      autoPassEmpty: stops.autoPassEmpty !== false,
    };
    this.stops.set(seat, clean);
    this.client.trySend({ type: "setStops", gameId: this.room.id, seat, stops: clean });
    saveEngineStops(this.room.handle, userId, clean);
    this.sendSeat(seat);
  }

  /** Hold priority for the rest of a turn (every priority stops, nothing auto-passes); null releases. */
  hold(userId: string, turn: number | null): void {
    this.ensureLoaded();
    const seat = this.seatOf(userId);
    if (seat === null) throw new EngineRoomError("spectators have no priority");
    if (turn === null || !Number.isFinite(turn) || turn <= 0) this.holds.delete(seat);
    else this.holds.set(seat, Math.floor(turn));
    this.client.trySend({ type: "hold", gameId: this.room.id, seat, turn: this.holds.get(seat) ?? null });
    this.sendSeat(seat);
  }

  concede(userId: string): void {
    const seat = this.seatOf(userId);
    if (seat === null) return;
    this.client.trySend({ type: "concede", gameId: this.room.id, seat });
  }

  // ------------------------------------------------------------ sockets

  onAttach(conn: { userId: string; sentPrintings: Set<string>; send: (msg: ServerMessage) => void }): void {
    this.ensureLoaded();
    if (this.room.row().status === "lobby") return;
    const seat = this.seatOf(conn.userId);
    this.sendTo(conn);
    if (this.room.row().status === "playing") {
      this.client.trySend({ type: "resync", gameId: this.room.id, seat: seat ?? SPECTATOR });
      if (seat !== null) {
        const t = this.absentTimers.get(seat);
        if (t) clearTimeout(t);
        this.absentTimers.delete(seat);
        this.client.trySend({ type: "attachSeat", gameId: this.room.id, seat });
      }
    }
  }

  /** A socket closed: when the seat has no socket left, start the grace timer; the AI plays for it after that until it is back. */
  onDetach(userId: string): void {
    this.ensureLoaded();
    const seat = this.seatOf(userId);
    if (seat === null || this.room.row().status !== "playing") return;
    for (const c of this.room.connections()) if (c.userId === userId) return; // another device is still here
    this.armAbsent(seat);
  }

  private armAbsent(seat: number): void {
    if (this.disposed || this.absentTimers.has(seat)) return;
    const timer = setTimeout(() => {
      this.absentTimers.delete(seat);
      this.client.trySend({ type: "detachSeat", gameId: this.room.id, seat });
      const name = this.seats.find((s) => s.seat === seat)?.name ?? "A player";
      this.log.push({ seq: this.seq + 1, actor: SYSTEM_ACTOR, text: `${name} has been away for a while; the engine's AI plays their seat until they return.`, ts: Date.now() });
      this.seq++;
      this.broadcast();
    }, ABSENT_GRACE_MS);
    timer.unref();
    this.absentTimers.set(seat, timer);
  }

  /** Room closed, evicted or game over: forget the timers, and never arm another (a late socket close may still call in). */
  dispose(): void {
    this.disposed = true;
    for (const t of this.absentTimers.values()) clearTimeout(t);
    this.absentTimers.clear();
  }

  /** Every socket at the table gets its own view (used after room-wide changes). */
  broadcast(): void {
    for (const conn of this.room.connections()) this.sendTo(conn);
  }

  /** Sockets of the user in `seat` (or every spectator for -1) get a fresh view. */
  private sendSeat(seat: number, quiet = false): void {
    const user = this.seats.find((s) => s.seat === seat)?.userId ?? null;
    for (const conn of this.room.connections()) {
      const connSeat = this.seatOf(conn.userId);
      if (seat === SPECTATOR ? connSeat !== null : conn.userId !== user) continue;
      this.sendTo(conn);
    }
    void quiet;
  }

  private sendTo(conn: { userId: string; sentPrintings: Set<string>; send: (msg: ServerMessage) => void }): void {
    const seat = this.seatOf(conn.userId);
    const state = (seat === null ? undefined : this.lastState.get(seat)) ?? this.lastState.get(SPECTATOR);
    if (!state) return;
    const viewer = seat === null ? null : conn.userId;
    const { view, printings } = engineToView(state, this.ctx(viewer));
    const delta: Record<string, CardPrinting> = {};
    for (const [id, printing] of printings) {
      if (conn.sentPrintings.has(id)) continue;
      conn.sentPrintings.add(id);
      delta[id] = printing;
    }
    conn.send({ t: "state", view, printings: delta });
  }

  private sendError(seat: number, message: string): void {
    const user = this.seats.find((s) => s.seat === seat)?.userId ?? null;
    for (const conn of this.room.connections()) {
      if (seat !== SPECTATOR && conn.userId !== user) continue;
      conn.send({ t: "error", message });
    }
  }

  private ctx(viewer: PlayerId | null): ConvertContext {
    const seat = viewer === null ? null : this.seatOf(viewer);
    const open = seat === null ? undefined : this.prompts.get(seat);
    const waitingOn = [...this.prompts.keys()].map((s) => this.seats.find((x) => x.seat === s)?.userId).filter((u): u is string => Boolean(u));
    const playable = open && open.prompt.kind === "priority" ? open.prompt.options.map((o) => o.iid) : [];
    return {
      viewer,
      seats: this.seats,
      printingOf: (card) => this.mapper.forCard(card.id, card.name ? { name: card.name, scryfallSet: card.scryfallSet, set: card.set, number: card.number, token: card.token, power: card.power, toughness: card.toughness } : null),
      log: this.log,
      seq: this.seq,
      engine: {
        prompt: open?.prompt ?? null,
        waitingOn,
        playable,
        stops: (seat === null ? undefined : this.stops.get(seat)) ?? DEFAULT_ENGINE_STOPS,
        holdTurn: (seat === null ? undefined : this.holds.get(seat)) ?? null,
        engineDown: this.engineDown,
      },
    };
  }

  /** Test/diagnostic: the seats as persisted. */
  seatInfos(): SeatInfo[] {
    this.ensureLoaded();
    return this.seats;
  }
}
