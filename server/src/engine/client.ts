import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";

/**
 * The one control socket to the rules engine (engine/ in this repo, Fly app cgwf-engine).
 * Browsers never talk to the engine; this client does, on behalf of every engine table.
 * Reconnects with backoff; `createGame` correlates its reply by `rid`; every other frame is
 * emitted as "frame" for the RoomManager to route by gameId.
 */

export interface EngineFrame {
  type: string;
  gameId?: string;
  seat?: number;
  rid?: string;
  message?: string;
  [key: string]: unknown;
}

export interface EngineSeatRequest {
  seat: number;
  kind: "human" | "ai";
  name: string;
  deck: unknown;
}

export interface GameCreatedFrame extends EngineFrame {
  type: "gameCreated";
  gameId: string;
  seed: number;
  players: Array<{ seat: number; playerId: number; name: string; human: boolean; deckName: string; resolved: number; exactPrinting: number; byName: number; missing: string[] }>;
}

export interface EngineClientOptions {
  url: string;
  token: string;
  log: FastifyBaseLogger;
  /** Test seam. */
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
}

const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

export class EngineClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly pending = new Map<string, { resolve: (f: EngineFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  /** The engine said hello and is ready (card database loaded). */
  ready = false;
  lastHello: EngineFrame | null = null;

  constructor(private readonly opts: EngineClientOptions) {
    super();
  }

  /** False when no engine URL is configured: engine tables are then unavailable. */
  get enabled(): boolean {
    return this.opts.url !== "";
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.enabled || this.closed) return;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("engine client closed"));
    }
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners("message");
      ws.close(1000, "shutdown");
    }
    this.removeAllListeners();
  }

  private connect(): void {
    if (this.closed) return;
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.url, { headers: this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {} });
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.opts.log.info({ url: this.opts.url }, "engine connected");
      this.emit("open");
    });
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      let frame: EngineFrame;
      try {
        frame = JSON.parse(data.toString()) as EngineFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;
      if (frame.type === "hello") {
        this.ready = Boolean(frame.ready);
        this.lastHello = frame;
        this.emit("hello", frame);
        return;
      }
      if (typeof frame.rid === "string" && this.pending.has(frame.rid)) {
        const p = this.pending.get(frame.rid)!;
        this.pending.delete(frame.rid);
        clearTimeout(p.timer);
        if (frame.type === "error") p.reject(new Error(String(frame.message ?? "engine error")));
        else p.resolve(frame);
        return;
      }
      this.emit("frame", frame);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.emit("close");
      if (this.closed) return;
      const delay = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)]!;
      this.attempt++;
      this.opts.log.warn({ code, reason: reason.toString(), delay }, "engine disconnected; retrying");
      this.timer = setTimeout(() => this.connect(), delay);
    });
    ws.on("error", (err) => {
      if (this.ws !== ws) return;
      this.opts.log.warn({ err: err.message }, "engine socket error");
      // close follows
    });
  }

  /** Fire-and-forget frame; throws when the engine is not connected. */
  send(frame: EngineFrame): void {
    if (!this.connected) throw new Error("the rules engine is not connected");
    this.ws!.send(JSON.stringify(frame));
  }

  trySend(frame: EngineFrame): boolean {
    if (!this.connected) return false;
    this.ws!.send(JSON.stringify(frame));
    return true;
  }

  /** Request/response by rid (createGame, health). */
  request(frame: EngineFrame): Promise<EngineFrame> {
    if (!this.connected) return Promise.reject(new Error("the rules engine is not connected"));
    const rid = randomUUID();
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<EngineFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("the rules engine did not answer in time"));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ ...frame, rid }));
    });
  }

  /** `deferStart`: the engine builds the game but waits for `beginGame {startingSeat}` (the table rolls for who goes first). */
  async createGame(gameId: string, seed: number, seats: EngineSeatRequest[], opts: { deferStart?: boolean; openingHand?: { mode: string; freeMulligans: number } } = {}): Promise<GameCreatedFrame> {
    const f = await this.request({ type: "createGame", gameId, seed, seats, ...(opts.deferStart ? { deferStart: true } : {}), ...(opts.openingHand ? { openingHand: opts.openingHand } : {}) });
    return f as GameCreatedFrame;
  }
}
