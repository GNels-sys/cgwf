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

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
    private row: RoomRow,
  ) {
    this.id = row.id;
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
    this.row = this.handle.db.select().from(rooms).where(eq(rooms.id, this.id)).get() ?? this.row;
    return this.row;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const rows = this.handle.db.select().from(roomEvents).where(eq(roomEvents.roomId, this.id)).orderBy(roomEvents.seq).all();
    this.events = rows.map((r) => ({ seq: r.seq, actor: r.actor, type: r.type, payload: JSON.parse(r.payload), ts: r.ts }) as GameEvent);
    this.state = this.events.length ? replay(this.events, this.row.seed) : null;
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

  info(forUserId: string | null): RoomInfo {
    const row = this.refreshRow();
    const rows = this.members();
    const userRows = rows.length ? this.handle.db.select().from(users).where(inArray(users.id, rows.map((m) => m.userId))).all() : [];
    const byId = new Map(userRows.map((u) => [u.id, u]));
    const online = this.onlineIds();
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
    };
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
      this.ensureLoaded();
      const p = this.state?.players[userId];
      if (p && !p.conceded) this.append(userId, { type: "PlayerConceded", payload: { player: userId } });
    }
    this.handle.db.delete(roomMembers).where(and(eq(roomMembers.roomId, this.id), eq(roomMembers.userId, userId))).run();
    if (this.row.hostUserId === userId) {
      const next = this.members().find((o) => o.role === "player") ?? this.members()[0];
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

  /** Validate, persist and apply one event from a client. */
  submit(userId: string, raw: unknown): void {
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
    this.ensureLoaded();
    if (this.status !== "playing") throw new RoomError("no game in progress");
    const last = this.events.at(-1);
    if (!last || last.type === "GameStarted") throw new RoomError("nothing to undo");
    if (last.type === "Revert") throw new RoomError("the last action was already a revert");
    if (last.actor !== userId) throw new RoomError("someone else acted since; use Revert from the log");
    this.append(userId, { type: "Revert", payload: { toSeq: last.seq - 1, reason: "undo" } });
  }

  revert(userId: string, toSeq: number): void {
    this.ensureLoaded();
    if (this.status !== "playing") throw new RoomError("no game in progress");
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
    const conn: Conn = { ws, userId, sentPrintings: new Set(), window: { start: Date.now(), count: 0 } };
    this.conns.add(conn);
    this.lastActivity = Date.now();
    this.join(userId);
    this.broadcastRoom();
    this.ensureLoaded();
    if (this.state) this.sendState(conn);
    return conn;
  }

  detach(conn: Conn): void {
    this.conns.delete(conn);
    this.lastActivity = Date.now();
    this.broadcastRoom();
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
    for (const conn of this.conns) this.sendState(conn);
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
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
    this.live.clear();
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [id, room] of this.live) {
      if (room.connectionCount === 0 && room.lastActivity < cutoff) this.live.delete(id);
    }
  }

  create(hostUserId: string): LiveRoom {
    const id = randomUUID();
    const seed = randomBytes(16).toString("hex");
    const ts = now();
    let code = newRoomCode();
    for (let tries = 0; tries < 10; tries++) {
      if (!this.handle.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.code, code)).get()) break;
      code = newRoomCode();
    }
    this.handle.sqlite.transaction(() => {
      this.handle.db.insert(rooms).values({ id, code, hostUserId, status: "lobby", format: "commander", seed, lastSeq: 0, createdAt: ts, updatedAt: ts }).run();
      this.handle.db.insert(roomMembers).values({ roomId: id, userId: hostUserId, role: "player", seat: 0, deckId: null, joinedAt: ts }).run();
    })();
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
      this.handle.db.insert(rooms).values({ id, code, hostUserId: userId, status: "lobby", format: "commander", seed, lastSeq: 0, createdAt: ts, updatedAt: ts }).run();
      for (const m of members) {
        this.handle.db.insert(roomMembers).values({ roomId: id, userId: m.userId, role: m.role, seat: m.seat, deckId: m.deckId, joinedAt: ts }).run();
      }
      this.handle.db.update(rooms).set({ nextRoomId: id, updatedAt: ts }).where(eq(rooms.id, old.id)).run();
    })();
    const next = this.get(code)!;
    try {
      next.start(userId);
    } catch (err) {
      // A deck was deleted meanwhile: the new table opens as a lobby instead of failing the rematch.
      this.log.info({ err }, "rematch opened as a lobby");
    }
    old.broadcastRoom();
    return next;
  }

  /** A user's shared settings changed: re-send room info wherever they are connected. */
  userChanged(userId: string): void {
    for (const room of this.live.values()) {
      if (room.connectionCount > 0 && room.member(userId)) room.broadcastRoom();
    }
  }

  get(code: string): LiveRoom | null {
    const row = this.handle.db.select().from(rooms).where(eq(rooms.code, code)).get();
    if (!row) return null;
    let room = this.live.get(row.id);
    if (!room) {
      room = new LiveRoom(this.handle, this.log, row);
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
      return { code: r.room.code, status: r.room.status as RoomStatus, players, updatedAt: r.room.updatedAt, hostName: r.host.displayName };
    });
  }

  /** Decks owned by a user, for the seat picker (id + name + commanders). */
  decksFor(userId: string) {
    const rows = this.handle.db.select().from(decks).where(eq(decks.userId, userId)).all();
    return rows.map((d) => describeDeck(this.handle, userId, d.id)).filter((d): d is NonNullable<typeof d> => d !== null);
  }
}
