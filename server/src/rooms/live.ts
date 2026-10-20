import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import {
  GameError,
  MAX_SEATS,
  STARTING_LIFE,
  SYSTEM_ACTOR,
  applyEvent,
  isEventType,
  isRow,
  lookOf,
  replay,
  viewFor,
  type CardPrinting,
  type CustomToken,
  type EventInput,
  type GameEvent,
  type GameStartedPayload,
  type GameState,
  type RoomInfo,
  type RoomMember,
  type RoomStatus,
  type ServerMessage,
} from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, decks, roomEvents, roomMembers, rooms, users, type RoomMemberRow, type RoomRow } from "../db/schema.js";
import { rowToPrinting } from "../scryfall/map.js";
import { newRoomCode } from "./codes.js";
import { describeDeck, loadDeckForGame } from "./deck.js";
import { loadSettings } from "../settings.js";
import type { EngineClient, EngineFrame } from "../engine/client.js";
import { PrintingMapper } from "../engine/mapping.js";
import type { NameIndex } from "../search/index.js";
import { EngineRoomError, EngineTable, type RoomPort } from "./engineTable.js";
import { deckForEngine } from "../engine/deck.js";
import type { GameResults } from "../stats/results.js";
import type { DiscordVoice } from "../discord/voice.js";
import type { DecisionRecorder } from "../coach/snapshots.js";
import { normaliseInvite, type RoomVoice } from "@cgwf/shared";
import type { AdminOpenTable, EngineAnswer, EngineStops } from "@cgwf/shared";

/** What the rules-engine integration needs (null when no engine is configured). */
export interface EngineDeps {
  client: EngineClient;
  index: NameIndex;
  /** Deck-statistics recorder, wired after construction (RoomManager.setResults). */
  results?: GameResults | null;
  /** AI Coach M1 decision snapshots, wired after construction (RoomManager.setDecisions). */
  decisions?: DecisionRecorder | null;
}

/**
 * In-memory runtime for rooms. The database is the source of truth
 * (rooms, room_members, room_events); a LiveRoom caches the event log and the
 * reduced state while anyone is connected, and fans out per-player views.
 */

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomError";
  }
}

interface Conn {
  ws: WebSocket;
  userId: string;
  /** Printing ids already sent on this connection (sent once, then referenced by id). */
  sentPrintings: Set<string>;
  /** Simple per-socket flood guard. */
  window: { start: number; count: number };
  /** The engine table's handle on this socket (engine rooms only). */
  port: { userId: string; sentPrintings: Set<string>; send: (msg: ServerMessage) => void };
}

const MSGS_PER_SECOND = 25;
const IDLE_EVICT_MS = 30 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function sanitizeCustom(raw: unknown): CustomToken | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(r.name, 40);
  if (!name) return null;
  const colors = Array.isArray(r.colors) ? r.colors.filter((c): c is CustomToken["colors"][number] => typeof c === "string" && "WUBRG".includes(c)).slice(0, 5) : [];
  return {
    name,
    typeLine: str(r.typeLine, 60) || "Token",
    power: str(r.power, 4) || null,
    toughness: str(r.toughness, 4) || null,
    colors,
    text: str(r.text, 300),
  };
}

export class LiveRoom {
  readonly id: string;
  private events: GameEvent[] = [];
  private state: GameState | null = null;
  private loaded = false;
  private conns = new Set<Conn>();
  lastActivity = Date.now();
  /** Phase 7: agent runners subscribe here; they get the TRUE state and must build their own view with viewFor(). */
  private stateListeners = new Set<(state: GameState) => void>();
  /** Agents seated in this room that have a live runner, and whether a decision is in flight. */
  private agentPresence = new Map<string, { thinking: boolean }>();
  /** Rules-engine tables: the relay to the Forge service. Null on classic tables. */
  readonly engineTable: EngineTable | null;

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
    private row: RoomRow,
    private readonly engineDeps: EngineDeps | null = null,
  ) {
    this.id = row.id;
    this.engineTable = row.engine && engineDeps ? new EngineTable(this.port(), engineDeps.client, new PrintingMapper(handle, engineDeps.index)) : null;
  }

  /** The narrow face the engine table sees of this room. */
  private port(): RoomPort {
    return {
      id: this.id,
      handle: this.handle,
      log: this.log,
      row: () => this.refreshRow(),
      members: () => this.members(),
      connections: () => [...this.conns].map((c) => c.port),
      appendEngine: (actor, input, status) => this.appendEngine(actor, input, status),
      loadedEvents: () => {
        this.ensureLoaded();
        return this.events;
      },
      saveEngineState: (json) => {
        this.handle.db.update(rooms).set({ engineState: json, updatedAt: now() }).where(eq(rooms.id, this.id)).run();
        this.refreshRow();
      },
      broadcastRoom: () => this.broadcastRoom(),
      userName: (userId) => this.handle.db.select({ name: users.displayName }).from(users).where(eq(users.id, userId)).get()?.name ?? "Player",
      agentIds: () => new Set(this.agentMemberIds()),
      results: () => this.engineDeps?.results ?? null,
      decisions: () => this.engineDeps?.decisions ?? null,
    };
  }

  /** True when the Forge rules engine runs this table instead of the manual reducer. */
  get isEngine(): boolean {
    return Boolean(this.row.engine);
  }

  get code(): string {
    return this.row.code;
  }
  get status(): RoomStatus {
    return this.row.status as RoomStatus;
  }
  get connectionCount(): number {
    return this.conns.size;
  }

  // ------------------------------------------------------------ loading

  refreshRow(): RoomRow {
    const before = this.row.status;
    this.row = this.handle.db.select().from(rooms).where(eq(rooms.id, this.id)).get() ?? this.row;
    // Discord voice: a game that ended on its own keeps its channel for a rematch grace, then loses it
    if (before !== this.row.status && this.voice) {
      if (this.row.status === "ended") this.voice.scheduleRelease(this.id);
      else if (before === "ended") this.voice.keep(this.id);
    }
    return this.row;
  }

  /** Discord voice service (null when the server has none); set by the RoomManager. */
  voice: DiscordVoice | null = null;

  /** Members of this table only: the voice invite (the bot's channel, else the host's manual link). */
  private voiceFor(row: RoomRow, isMember: boolean): RoomVoice | null {
    if (!isMember) return null;
    const bot = this.voice?.usable ?? false;
    if (row.voiceInviteUrl) return { url: row.voiceInviteUrl, source: "discord", unavailable: false, botEnabled: bot };
    const failed = bot && (this.voice?.failed.has(this.id) ?? false);
    if (row.voiceManualUrl) return { url: row.voiceManualUrl, source: "manual", unavailable: failed, botEnabled: bot };
    return { url: null, source: null, unavailable: failed || (!bot && this.voice !== null && this.voice.status.state === "error"), botEnabled: bot };
  }

  /** Host: the manual voice link (a Discord invite), or null to clear it. */
  setVoiceLink(userId: string, raw: unknown): void {
    const row = this.refreshRow();
    if (row.hostUserId !== userId) throw new RoomError("only the host can set the voice link");
    if (row.status === "ended") throw new RoomError("this table has ended");
    let url: string | null = null;
    if (raw !== null && raw !== "" && raw !== undefined) {
      url = normaliseInvite(raw);
      if (!url) throw new RoomError("That is not a Discord invite link (discord.gg/... or discord.com/invite/...).");
    }
    this.handle.db.update(rooms).set({ voiceManualUrl: url }).where(eq(rooms.id, this.id)).run();
    this.touch();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const rows = this.handle.db.select().from(roomEvents).where(eq(roomEvents.roomId, this.id)).orderBy(roomEvents.seq).all();
    this.events = rows.map((r) => ({ seq: r.seq, actor: r.actor, type: r.type, payload: JSON.parse(r.payload), ts: r.ts }) as GameEvent);
    // Engine tables keep their log as EngineLog rows; the classic reducer never runs on them.
    this.state = this.events.length && !this.isEngine ? replay(this.events, this.row.seed) : null;
    this.loaded = true;
  }

  members(): RoomMemberRow[] {
    return this.handle.db.select().from(roomMembers).where(eq(roomMembers.roomId, this.id)).all();
  }

  member(userId: string): RoomMemberRow | undefined {
    return this.handle.db.select().from(roomMembers).where(and(eq(roomMembers.roomId, this.id), eq(roomMembers.userId, userId))).get();
  }

  private onlineIds(): Set<string> {
    return new Set([...this.conns].map((c) => c.userId));
  }

  /** Phase 8: users with an open socket to this table (for friends' presence). */
  connectedUserIds(): string[] {
    return [...this.onlineIds()];
  }

  info(forUserId: string | null): RoomInfo {
    const row = this.refreshRow();
    const rows = this.members();
    const userRows = rows.length ? this.handle.db.select().from(users).where(inArray(users.id, rows.map((m) => m.userId))).all() : [];
    const byId = new Map(userRows.map((u) => [u.id, u]));
    const online = this.onlineIds();
    const results = this.engineDeps?.results ?? null;
    const members: RoomMember[] = rows
      .map((m): RoomMember | null => {
        const u = byId.get(m.userId);
        if (!u) return null;
        const deck = m.deckId ? describeDeck(this.handle, m.userId, m.deckId) : null;
        return {
          userId: m.userId,
          name: u.displayName,
          avatar: u.avatar as RoomMember["avatar"],
          color: u.color as RoomMember["color"],
          role: m.role as RoomMember["role"],
          seat: m.seat,
          deckId: deck?.id ?? null,
          deckName: deck?.name ?? null,
          commanders: deck?.commanders ?? [],
          online: online.has(m.userId) || this.agentPresence.has(m.userId),
          look: lookOf(loadSettings(this.handle, m.userId)),
          isAgent: Boolean(u.isAgent),
          thinking: this.agentPresence.get(m.userId)?.thinking ?? false,
          deckProblems: row.engine && m.deckId && m.role === "player" ? (deckForEngine(this.handle, m.userId, m.deckId)?.problems ?? []) : [],
          deckBracket: row.engine && m.deckId && m.role === "player" && results ? results.brackets.forSeat(m.userId, m.deckId) : null,
        };
      })
      .filter((m): m is RoomMember => m !== null)
      .sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99) || a.name.localeCompare(b.name));
    const me = forUserId ? members.find((m) => m.userId === forUserId) : undefined;
    const next = row.nextRoomId ? this.handle.db.select({ code: rooms.code }).from(rooms).where(eq(rooms.id, row.nextRoomId)).get() : undefined;
    return {
      id: row.id,
      code: row.code,
      status: row.status as RoomStatus,
      hostId: row.hostUserId,
      format: "commander",
      members,
      createdAt: row.createdAt,
      nextCode: next?.code ?? null,
      you: me ? { userId: me.userId, role: me.role, seat: me.seat } : null,
      engine: Boolean(row.engine),
      testGame: Boolean(row.testGame),
      tableBracket: row.tableBracket ?? this.autoTableBracket(members),
      tableBracketChosen: row.tableBracket !== null && row.tableBracket !== undefined,
      voice: this.voiceFor(row, Boolean(forUserId && rows.some((m) => m.userId === forUserId))),
    };
  }

  /** The table bracket when the host has not picked one: the highest bracket among the seated decks. */
  private autoTableBracket(members: RoomMember[]): number | null {
    let best: number | null = null;
    for (const m of members) if (m.role === "player" && m.deckBracket != null && (best === null || m.deckBracket > best)) best = m.deckBracket;
    return best;
  }

  /** Host, lobby only: the Test-game toggle and the table bracket (null = automatic). Frozen at start. */
  setTableSettings(userId: string, s: { testGame?: unknown; tableBracket?: unknown }): void {
    const row = this.refreshRow();
    if (row.hostUserId !== userId) throw new RoomError("only the host can change the table settings");
    if (row.status !== "lobby") throw new RoomError("the game has started; the table settings are frozen");
    const set: Partial<typeof rooms.$inferInsert> = {};
    if (typeof s.testGame === "boolean") set.testGame = s.testGame;
    if (s.tableBracket === null) set.tableBracket = null;
    else if (s.tableBracket !== undefined) {
      const b = Number(s.tableBracket);
      if (!Number.isInteger(b) || b < 1 || b > 5) throw new RoomError("the table bracket is 1 to 5");
      set.tableBracket = b;
    }
    if (!Object.keys(set).length) return;
    this.handle.db.update(rooms).set(set).where(eq(rooms.id, this.id)).run();
    this.touch();
  }

  /**
   * Close the table without a result: the host ("End table"), the owner (Admin) or the idle sweep.
   * An engine game is torn down and recorded as abandoned (never counted); a lobby simply ends.
   */
  closeTable(reason: string): boolean {
    const row = this.refreshRow();
    if (row.status === "ended") return false;
    if (this.engineTable && row.status === "playing") {
      this.engineTable.close(reason);
    } else {
      this.engineDeps?.results?.abandon(this.id, reason);
      this.handle.db.update(rooms).set({ status: "ended", updatedAt: now() }).where(eq(rooms.id, this.id)).run();
      this.refreshRow();
      this.engineTable?.dispose();
    }
    this.voice?.release(this.id);
    this.lastActivity = Date.now();
    this.broadcastRoom();
    return true;
  }

  // ------------------------------------------------------------ membership

  join(userId: string): void {
    if (this.member(userId)) return;
    this.handle.db.insert(roomMembers).values({ roomId: this.id, userId, role: "spectator", seat: null, deckId: null, joinedAt: now() }).run();
    this.touch();
  }

  takeSeat(userId: string, seat: number, deckId: string | null): void {
    if (this.status !== "lobby") throw new RoomError("the game has already started");
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) throw new RoomError("no such seat");
    const m = this.member(userId);
    if (!m) throw new RoomError("join the room first");
    const taken = this.members().find((o) => o.seat === seat && o.userId !== userId);
    if (taken) throw new RoomError("that seat is taken");
    if (deckId && !describeDeck(this.handle, userId, deckId)) throw new RoomError("deck not found");
    this.handle.db.update(roomMembers).set({ role: "player", seat, deckId }).where(and(eq(roomMembers.roomId, this.id), eq(roomMembers.userId, userId))).run();
    this.touch();
  }

  leaveSeat(userId: string): void {
    if (this.status !== "lobby") throw new RoomError("the game has already started");
    this.handle.db.update(roomMembers).set({ role: "spectator", seat: null, deckId: null }).where(and(eq(roomMembers.roomId, this.id), eq(roomMembers.userId, userId))).run();
    this.touch();
  }

  /** Leave the room. During a game a seated player concedes first and stays visible in the log. */
  leave(userId: string): void {
    const m = this.member(userId);
    if (!m) return;
    if (this.status === "playing" && m.role === "player") {
      if (this.engineTable) this.engineTable.concede(userId);
      else {
        this.ensureLoaded();
        const p = this.state?.players[userId];
        if (p && !p.conceded) this.append(userId, { type: "PlayerConceded", payload: { player: userId } });
      }
    }
    this.handle.db.delete(roomMembers).where(and(eq(roomMembers.roomId, this.id), eq(roomMembers.userId, userId))).run();
    if (this.row.hostUserId === userId) {
      const bots = new Set(this.agentMemberIds());
      const rest = this.members();
      const next = rest.find((o) => o.role === "player" && !bots.has(o.userId)) ?? rest.find((o) => !bots.has(o.userId)) ?? rest[0];
      if (next) this.handle.db.update(rooms).set({ hostUserId: next.userId }).where(eq(rooms.id, this.id)).run();
    }
    this.touch();
  }

  private touch(): void {
    this.lastActivity = Date.now();
    this.handle.db.update(rooms).set({ updatedAt: now() }).where(eq(rooms.id, this.id)).run();
    this.refreshRow();
  }

  // ------------------------------------------------------------ game

  /** Start the game: the rules engine for engine tables, the classic reducer otherwise. */
  async startAny(userId: string): Promise<void> {
    if (this.engineTable) {
      try {
        await this.engineTable.start(userId);
      } catch (err) {
        if (err instanceof EngineRoomError) throw new RoomError(err.message);
        this.log.warn({ err }, "engine start failed");
        throw new RoomError(err instanceof Error ? err.message : "the rules engine could not start the game");
      }
      return;
    }
    if (this.isEngine) throw new RoomError("the rules engine is not configured on this server");
    this.start(userId);
  }

  start(userId: string): void {
    const row = this.refreshRow();
    if (row.hostUserId !== userId) throw new RoomError("only the host can start the game");
    if (row.status !== "lobby") throw new RoomError("the game has already started");
    const seated = this.members().filter((m) => m.role === "player" && m.seat !== null);
    if (seated.length < 2) throw new RoomError("need at least two seated players");
    const userRows = this.handle.db.select().from(users).where(inArray(users.id, seated.map((m) => m.userId))).all();
    const names = new Map(userRows.map((u) => [u.id, u.displayName]));
    const payload: GameStartedPayload = { players: [], decks: {}, startingLife: STARTING_LIFE };
    for (const m of seated) {
      if (!m.deckId) throw new RoomError(`${names.get(m.userId) ?? "a player"} has not picked a deck`);
      const deck = loadDeckForGame(this.handle, m.userId, m.deckId);
      if (!deck || deck.library.length === 0) throw new RoomError(`${names.get(m.userId) ?? "a player"}'s deck is empty`);
      payload.players.push({ id: m.userId, name: names.get(m.userId) ?? "Player", seat: m.seat as number });
      payload.decks[m.userId] = deck;
    }
    this.ensureLoaded();
    this.append(SYSTEM_ACTOR, { type: "GameStarted", payload });
  }

  /** Engine tables: a seat answers the prompt the engine is waiting on. */
  engineAnswer(userId: string, answer: EngineAnswer): void {
    if (!this.engineTable) throw new RoomError("this table is not run by the rules engine");
    if (this.status !== "playing") throw new RoomError("no game in progress");
    try {
      this.engineTable.answer(userId, answer);
    } catch (err) {
      if (err instanceof EngineRoomError) throw new RoomError(err.message);
      throw new RoomError(err instanceof Error ? err.message : "the rules engine refused that");
    }
  }

  /** Concede from the menu: engine tables tell the engine, classic tables append the event. */
  concede(userId: string): void {
    if (this.status !== "playing") throw new RoomError("no game in progress");
    if (this.engineTable) {
      this.engineTable.concede(userId);
      return;
    }
    this.ensureLoaded();
    if (!this.state?.players[userId]) throw new RoomError("spectators cannot concede");
    this.append(userId, { type: "PlayerConceded", payload: { player: userId } });
  }

  engineStops(userId: string, stops: EngineStops): void {
    if (!this.engineTable) throw new RoomError("this table is not run by the rules engine");
    try {
      this.engineTable.setStops(userId, stops);
    } catch (err) {
      if (err instanceof EngineRoomError) throw new RoomError(err.message);
      throw err;
    }
  }

  engineHold(userId: string, turn: number | null): void {
    if (!this.engineTable) throw new RoomError("this table is not run by the rules engine");
    try {
      this.engineTable.hold(userId, turn);
    } catch (err) {
      if (err instanceof EngineRoomError) throw new RoomError(err.message);
      throw err;
    }
  }

  onEngineFrame(frame: EngineFrame): void {
    try {
      this.engineTable?.onFrame(frame);
    } catch (err) {
      this.log.error({ err, type: frame.type }, "engine frame failed");
    }
  }

  /** Persist an engine-only event without running the reducer. */
  private appendEngine(actor: string, input: EventInput, status?: "playing" | "ended"): GameEvent {
    this.ensureLoaded();
    const seq = this.events.length + 1;
    const ev = { ...input, seq, actor, ts: Date.now() } as GameEvent;
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(roomEvents).values({ roomId: this.id, seq, actor, type: ev.type, payload: JSON.stringify(ev.payload), ts: ev.ts }).run();
      const set: Partial<typeof rooms.$inferInsert> = { lastSeq: seq, updatedAt: now() };
      if (status) set.status = status;
      this.handle.db.update(rooms).set(set).where(eq(rooms.id, this.id)).run();
    })();
    this.events.push(ev);
    this.lastActivity = Date.now();
    this.refreshRow();
    return ev;
  }

  /** Validate, persist and apply one event from a client. */
  submit(userId: string, raw: unknown): void {
    if (this.isEngine) throw new RoomError("the rules engine runs this table; use its prompts");
    this.ensureLoaded();
    if (this.status !== "playing") throw new RoomError("no game in progress");
    if (!this.state?.players[userId]) throw new RoomError("spectators cannot act");
    if (!raw || typeof raw !== "object") throw new RoomError("bad event");
    const { type, payload } = raw as { type?: unknown; payload?: unknown };
    if (!isEventType(type)) throw new RoomError("unknown event type");
    if (type === "GameStarted" || type === "Revert") throw new RoomError("that event is not sent directly");
    if (!payload || typeof payload !== "object") throw new RoomError("bad payload");
    const input = { type, payload: this.cleanPayload(type, payload as Record<string, unknown>) } as EventInput;
    this.append(userId, input);
  }

  /** Server-side trust boundary for client payloads: real printings only, bounded text. */
  private cleanPayload(type: string, p: Record<string, unknown>): Record<string, unknown> {
    if (type === "TokenCreated") {
      let printing: CardPrinting | null = null;
      const id = p.printing && typeof p.printing === "object" ? (p.printing as { id?: unknown }).id : null;
      if (typeof id === "string") {
        const row = this.handle.db.select().from(cards).where(eq(cards.id, id)).get();
        if (!row) throw new RoomError("unknown token printing");
        printing = rowToPrinting(row);
      }
      const custom = printing ? null : sanitizeCustom(p.custom);
      if (!printing && !custom) throw new RoomError("token needs a card or a name");
      return { player: p.player, printing, custom, count: p.count ?? 1, row: isRow(p.row) ? p.row : "creatures" };
    }
    return p;
  }

  undo(userId: string): void {
    if (this.isEngine) throw new RoomError("there is no undo on a rules-engine table");
    this.ensureLoaded();
    // Allowed after the game ended too: an automatic elimination from a mistyped life total must be reversible.
    if (this.status !== "playing" && this.status !== "ended") throw new RoomError("no game in progress");
    const last = this.events.at(-1);
    if (!last || last.type === "GameStarted") throw new RoomError("nothing to undo");
    if (last.type === "Revert") throw new RoomError("the last action was already a revert");
    if (last.actor !== userId) throw new RoomError("someone else acted since; use Revert from the log");
    this.append(userId, { type: "Revert", payload: { toSeq: last.seq - 1, reason: "undo" } });
  }

  revert(userId: string, toSeq: number): void {
    if (this.isEngine) throw new RoomError("there is no rewind on a rules-engine table");
    this.ensureLoaded();
    if (this.status !== "playing" && this.status !== "ended") throw new RoomError("no game in progress");
    if (!this.state?.players[userId]) throw new RoomError("spectators cannot revert");
    const last = this.events.at(-1);
    if (!last || !Number.isInteger(toSeq) || toSeq < 1 || toSeq >= last.seq) throw new RoomError("bad revert point");
    this.append(userId, { type: "Revert", payload: { toSeq } });
  }

  private append(actor: string, input: EventInput): void {
    this.ensureLoaded();
    const seq = this.events.length + 1;
    const ev = { ...input, seq, actor, ts: Date.now() } as GameEvent;
    let next: GameState | null;
    try {
      next = ev.type === "Revert" ? replay([...this.events, ev], this.row.seed) : applyEvent(this.state, ev, this.row.seed);
    } catch (err) {
      if (err instanceof GameError) throw new RoomError(err.message);
      this.log.warn({ err, type: ev.type }, "reducer threw");
      throw new RoomError("that action is not possible");
    }
    const status: RoomStatus = next?.phase === "ended" ? "ended" : "playing";
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(roomEvents).values({ roomId: this.id, seq, actor, type: ev.type, payload: JSON.stringify(ev.payload), ts: ev.ts }).run();
      this.handle.db.update(rooms).set({ lastSeq: seq, status, updatedAt: now() }).where(eq(rooms.id, this.id)).run();
    })();
    this.events.push(ev);
    this.state = next;
    this.lastActivity = Date.now();
    this.refreshRow();
    this.broadcastState();
    if (next) for (const fn of this.stateListeners) fn(next);
  }

  /** Phase 7: notified after every applied event. Returns the unsubscribe function. */
  onState(fn: (state: GameState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** Phase 7: mark an agent seat as live (and thinking or not); null removes it. Rebroadcasts the room. */
  setAgentPresence(userId: string, presence: { thinking: boolean } | null): void {
    if (presence) this.agentPresence.set(userId, presence);
    else this.agentPresence.delete(userId);
    this.broadcastRoom();
  }

  /** Phase 7: user ids of seated computer opponents. */
  agentMemberIds(): string[] {
    const rows = this.members().filter((m) => m.role === "player");
    if (rows.length === 0) return [];
    const userRows = this.handle.db.select({ id: users.id, isAgent: users.isAgent }).from(users).where(inArray(users.id, rows.map((m) => m.userId))).all();
    return userRows.filter((u) => u.isAgent).map((u) => u.id);
  }

  // ------------------------------------------------------------ sockets

  attach(ws: WebSocket, userId: string): Conn {
    const sentPrintings = new Set<string>();
    const conn: Conn = { ws, userId, sentPrintings, window: { start: Date.now(), count: 0 }, port: { userId, sentPrintings, send: (msg) => this.send(conn, msg) } };
    this.conns.add(conn);
    this.lastActivity = Date.now();
    this.join(userId);
    this.broadcastRoom();
    this.ensureLoaded();
    if (this.engineTable) this.engineTable.onAttach(conn.port);
    else if (this.state) this.sendState(conn);
    return conn;
  }

  detach(conn: Conn): void {
    this.conns.delete(conn);
    this.lastActivity = Date.now();
    this.broadcastRoom();
    this.engineTable?.onDetach(conn.userId);
  }

  /** True when the socket is within its message budget. */
  allow(conn: Conn): boolean {
    const t = Date.now();
    if (t - conn.window.start > 1000) conn.window = { start: t, count: 0 };
    conn.window.count++;
    return conn.window.count <= MSGS_PER_SECOND;
  }

  send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn({ err }, "ws send failed");
    }
  }

  broadcastRoom(): void {
    for (const conn of this.conns) this.send(conn, { t: "room", room: this.info(conn.userId) });
  }

  private sendState(conn: Conn): void {
    if (!this.state) return;
    const viewer = this.state.players[conn.userId] ? conn.userId : null;
    const { view, printings } = viewFor(this.state, viewer);
    const delta: Record<string, CardPrinting> = {};
    for (const [id, printing] of printings) {
      if (conn.sentPrintings.has(id)) continue;
      conn.sentPrintings.add(id);
      delta[id] = printing;
    }
    this.send(conn, { t: "state", view, printings: delta });
  }

  broadcastState(): void {
    if (this.engineTable) this.engineTable.broadcast();
    else for (const conn of this.conns) this.sendState(conn);
    if (this.status === "ended") this.broadcastRoom();
  }

  /** Test/diagnostic access to the current state. Never exposed over the network. */
  currentState(): GameState | null {
    this.ensureLoaded();
    return this.state;
  }
}

export class RoomManager {
  private live = new Map<string, LiveRoom>();
  /** Legacy casual tables may be created (tests of the classic table only); see BuildOptions.casualRooms. */
  casualRooms = false;
  /** Deck-statistics recorder (set by the app once the analyzer exists). */
  results: GameResults | null = null;
  /** Discord voice: one temporary channel per table (null = no service wired, e.g. some tests). */
  voice: DiscordVoice | null = null;

  setVoice(v: DiscordVoice): void {
    this.voice = v;
    v.onChange = (roomId) => this.live.get(roomId)?.broadcastRoom();
    for (const room of this.live.values()) room.voice = v;
  }
  /** Tables with no activity for this long are closed automatically (no result recorded). */
  idleCloseMs = Number(process.env.TABLE_IDLE_CLOSE_HOURS ?? 48) * 3600_000;
  private idleTimer: NodeJS.Timeout | null = null;

  setResults(r: GameResults): void {
    this.results = r;
    if (this.engine) this.engine.results = r;
  }

  /** AI Coach M1: decision snapshots of human seats on engine tables. */
  decisions: DecisionRecorder | null = null;
  setDecisions(d: DecisionRecorder): void {
    this.decisions = d;
    if (this.engine) this.engine.decisions = d;
  }

  /** Close one table by code (host / owner checks are the caller's). False when unknown or already ended. */
  closeTable(code: string, reason: string): boolean {
    const room = this.get(code);
    return room ? room.closeTable(reason) : false;
  }

  /** Tables still open (lobby or playing), oldest activity first, for the owner's Admin page. */
  openTables(): AdminOpenTable[] {
    const rows = this.handle.db
      .select({ room: rooms, host: users })
      .from(rooms)
      .innerJoin(users, eq(users.id, rooms.hostUserId))
      .where(inArray(rooms.status, ["lobby", "playing"]))
      .all()
      .sort((a, b) => a.room.updatedAt.localeCompare(b.room.updatedAt));
    return rows.map((r) => ({
      code: r.room.code,
      status: r.room.status as AdminOpenTable["status"],
      engine: Boolean(r.room.engine),
      hostName: r.host.displayName,
      players: this.handle.db.select().from(roomMembers).where(and(eq(roomMembers.roomId, r.room.id), eq(roomMembers.role, "player"))).all().length,
      updatedAt: r.room.updatedAt,
      createdAt: r.room.createdAt,
    }));
  }

  /** Close every open table with no activity for `idleMs` (no result recorded). Returns the codes closed. */
  closeIdle(idleMs: number, reason: string): string[] {
    const cutoff = new Date(Date.now() - idleMs).toISOString();
    const closed: string[] = [];
    for (const t of this.openTables()) {
      if (t.updatedAt >= cutoff) continue;
      const live = [...this.live.values()].find((r) => r.code === t.code);
      if (live && live.connectionCount > 0 && Date.now() - live.lastActivity < idleMs) continue;
      try {
        if (this.closeTable(t.code, reason)) closed.push(t.code);
      } catch (err) {
        this.log.warn({ err, code: t.code }, "closing an idle table failed");
      }
    }
    if (closed.length) this.log.info({ closed }, "closed idle tables");
    return closed;
  }

  /** Hourly: close tables idle for idleCloseMs (48 h by default). */
  startIdleSweep(): void {
    if (this.idleTimer || this.idleCloseMs <= 0) return;
    const run = () => {
      if (this.closed) return;
      this.closeIdle(this.idleCloseMs, `Closed automatically after ${Math.round(this.idleCloseMs / 3600_000)} hours without activity.`);
    };
    this.idleTimer = setInterval(run, 60 * 60 * 1000);
    this.idleTimer.unref();
    setTimeout(run, 60_000).unref();
  }
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
    private readonly engine: EngineDeps | null = null,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweeper.unref();
    if (engine) {
      // Every engine frame names its game; the game id is the room id.
      engine.client.on("frame", (frame: EngineFrame) => {
        if (this.closed || typeof frame.gameId !== "string") return;
        const room = this.getById(frame.gameId);
        room?.onEngineFrame(frame);
      });
      engine.client.on("open", () => {
        if (this.closed) return;
        for (const room of this.live.values()) room.engineTable?.onEngineReconnected();
      });
      engine.client.on("close", () => {
        if (this.closed) return;
        for (const room of this.live.values()) room.engineTable?.onEngineDown();
      });
    }
  }

  /** Engine tables can be opened: an engine is configured and currently connected. */
  engineAvailable(): boolean {
    return Boolean(this.engine && this.engine.client.enabled && this.engine.client.connected);
  }

  engineConfigured(): boolean {
    return Boolean(this.engine && this.engine.client.enabled);
  }

  getById(id: string): LiveRoom | null {
    let room = this.live.get(id);
    if (room) return room;
    const row = this.handle.db.select().from(rooms).where(eq(rooms.id, id)).get();
    if (!row) return null;
    room = new LiveRoom(this.handle, this.log, row, this.engine);
    room.voice = this.voice;
    this.live.set(row.id, room);
    return room;
  }

  private closed = false;

  close(): void {
    this.closed = true;
    clearInterval(this.sweeper);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.live.clear();
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [id, room] of this.live) {
      if (room.connectionCount === 0 && room.lastActivity < cutoff) {
        room.engineTable?.dispose(); // its absent-seat timers must not fire for a room that is gone
        this.live.delete(id);
      }
    }
  }

  create(hostUserId: string, opts: { engine?: boolean } = {}): LiveRoom {
    const id = randomUUID();
    const seed = randomBytes(16).toString("hex");
    const ts = now();
    let code = newRoomCode();
    for (let tries = 0; tries < 10; tries++) {
      if (!this.handle.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.code, code)).get()) break;
      code = newRoomCode();
    }
    const engine = Boolean(opts.engine);
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(rooms).values({ id, code, hostUserId, status: "lobby", format: "commander", seed, lastSeq: 0, engine, createdAt: ts, updatedAt: ts }).run();
      this.handle.db.insert(roomMembers).values({ roomId: id, userId: hostUserId, role: "player", seat: 0, deckId: null, joinedAt: ts }).run();
    })();
    // Discord voice: the bot's channel (async; the table never waits), else the host's saved invite
    const fallback = loadSettings(this.handle, hostUserId).discordInvite;
    if (fallback) this.handle.db.update(rooms).set({ voiceManualUrl: fallback }).where(eq(rooms.id, id)).run();
    this.voice?.onRoomCreated(id, code);
    return this.get(code)!;
  }

  /**
   * Rematch: a brand-new room with a fresh seed, the same seats and decks, started
   * at once. The old room remembers the new code so every client can follow.
   * Idempotent: a second press returns the room already created.
   */
  rematch(old: LiveRoom, userId: string): LiveRoom {
    const row = old.refreshRow();
    if (row.hostUserId !== userId) throw new RoomError("only the host can start a rematch");
    if (row.status !== "ended") throw new RoomError("the game is still going");
    if (!row.engine && !this.casualRooms) throw new RoomError("casual tables are retired: start a new rules-engine table from the Play page");
    if (row.nextRoomId) {
      const existing = this.handle.db.select({ code: rooms.code }).from(rooms).where(eq(rooms.id, row.nextRoomId)).get();
      const room = existing ? this.get(existing.code) : null;
      if (room) return room;
    }
    const id = randomUUID();
    const seed = randomBytes(16).toString("hex");
    const ts = now();
    let code = newRoomCode();
    for (let tries = 0; tries < 10; tries++) {
      if (!this.handle.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.code, code)).get()) break;
      code = newRoomCode();
    }
    const members = old.members();
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(rooms).values({ id, code, hostUserId: userId, status: "lobby", format: "commander", seed, lastSeq: 0, engine: Boolean(row.engine), createdAt: ts, updatedAt: ts }).run();
      for (const m of members) {
        this.handle.db.insert(roomMembers).values({ roomId: id, userId: m.userId, role: m.role, seat: m.seat, deckId: m.deckId, joinedAt: ts }).run();
      }
      this.handle.db.update(rooms).set({ nextRoomId: id, updatedAt: ts }).where(eq(rooms.id, old.id)).run();
    })();
    const next = this.get(code)!;
    if (!next.isEngine) {
      try {
        next.start(userId);
      } catch (err) {
        // A deck was deleted meanwhile: the new table opens as a lobby instead of failing the rematch.
        this.log.info({ err }, "rematch opened as a lobby");
      }
    }
    // Engine rematches open as a lobby: the host presses Start (the engine call is asynchronous).
    // Discord voice: the rematch keeps the same channel (renamed to the new code)
    this.voice?.onRematch(old.id, id, code);
    next.refreshRow();
    old.broadcastRoom();
    return next;
  }

  /** A user's shared settings changed: re-send room info wherever they are connected. */
  userChanged(userId: string): void {
    for (const room of this.live.values()) {
      if (room.connectionCount > 0 && room.member(userId)) room.broadcastRoom();
    }
  }

  /** Phase 8: which live table (if any) each of these users is connected to right now. */
  tablesOf(userIds: Iterable<string>): Map<string, { code: string; status: RoomStatus }> {
    const want = new Set(userIds);
    const out = new Map<string, { code: string; status: RoomStatus }>();
    if (want.size === 0) return out;
    for (const room of this.live.values()) {
      if (room.connectionCount === 0 || room.status === "ended") continue;
      for (const id of room.connectedUserIds()) if (want.has(id) && !out.has(id)) out.set(id, { code: room.code, status: room.status });
    }
    return out;
  }

  get(code: string): LiveRoom | null {
    const row = this.handle.db.select().from(rooms).where(eq(rooms.code, code)).get();
    if (!row) return null;
    let room = this.live.get(row.id);
    if (!room) {
      room = new LiveRoom(this.handle, this.log, row, this.engine);
      room.voice = this.voice;
      this.live.set(row.id, room);
    }
    return room;
  }

  /** Rooms the user belongs to, newest first. */
  listForUser(userId: string, limit = 20) {
    const rows = this.handle.db
      .select({ room: rooms, host: users })
      .from(roomMembers)
      .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
      .innerJoin(users, eq(users.id, rooms.hostUserId))
      .where(eq(roomMembers.userId, userId))
      .orderBy(desc(rooms.updatedAt))
      .limit(limit)
      .all();
    return rows.map((r) => {
      const players = this.handle.db.select({ userId: roomMembers.userId }).from(roomMembers).where(and(eq(roomMembers.roomId, r.room.id), eq(roomMembers.role, "player"))).all().length;
      return { code: r.room.code, status: r.room.status as RoomStatus, players, updatedAt: r.room.updatedAt, hostName: r.host.displayName, engine: Boolean(r.room.engine), isHost: r.room.hostUserId === userId, testGame: Boolean(r.room.testGame) };
    });
  }

  /** Decks owned by a user, for the seat picker (id + name + commanders). */
  decksFor(userId: string) {
    const rows = this.handle.db.select().from(decks).where(eq(decks.userId, userId)).all();
    return rows.map((d) => describeDeck(this.handle, userId, d.id)).filter((d): d is NonNullable<typeof d> => d !== null);
  }
}
