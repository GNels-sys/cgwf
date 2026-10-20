import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { ClientMessage, CreateRoomRequest, CreateRoomResponse, FeaturesResponse, MyRoomsResponse, RoomResponse } from "@cgwf/shared";
import { isEngineAnswer } from "../engine/view.js";
import { rateLimitKey, requireUser, userFromToken } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { isRoomCode, normalizeRoomCode } from "../rooms/codes.js";
import { RoomError, type LiveRoom, type RoomManager } from "../rooms/live.js";
import type { AgentManager } from "../agents/manager.js";

interface Deps {
  handle: DbHandle;
  roomsManager: RoomManager;
  /** Phase 7: starts computer opponents when a game begins and resumes them after a restart. */
  agents?: AgentManager | undefined;
}

const MAX_WS_MESSAGE = 64 * 1024;

/**
 * Rooms: a little REST for the lobby page, then one WebSocket per client at
 * /api/rooms/:code/ws?token=... for everything live.
 */
export function registerRoomRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, roomsManager, agents } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);

  const findRoom = (rawCode: string): LiveRoom | null => {
    const code = normalizeRoomCode(rawCode);
    if (!isRoomCode(code)) return null;
    return roomsManager.get(code);
  };

  /** What this deployment has switched on (the Play page shows the engine option only when true). */
  app.get("/api/features", async (): Promise<FeaturesResponse> => ({ engine: roomsManager.engineAvailable() }));

  app.post<{ Body: CreateRoomRequest | null }>(
    "/api/rooms",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<CreateRoomResponse | void> => {
      const wantEngine = Boolean(req.body && typeof req.body === "object" && req.body.engine);
      // Casual (no rules) tables are retired: every new table is a rules-engine table. Existing casual
      // tables still load; an old client asking for a casual one is refused.
      if (!wantEngine && !roomsManager.casualRooms) {
        return reply.code(400).send({ error: "Casual tables are retired: every new table uses the rules engine. Update the app and try again." });
      }
      if (wantEngine && !roomsManager.engineAvailable()) {
        return reply.code(503).send({ error: roomsManager.engineConfigured() ? "the rules engine is not reachable right now; try again in a moment" : "the rules engine is not enabled on this server" });
      }
      const room = roomsManager.create(req.user!.id, { engine: wantEngine });
      return reply.code(201).send({ room: room.info(req.user!.id) });
    },
  );

  /** Host (or the owner): close a table without a result, e.g. from Recent tables. */
  app.post<{ Params: { code: string } }>("/api/rooms/:code/end", { preHandler: auth }, async (req, reply) => {
    const room = findRoom(req.params.code);
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    const row = room.refreshRow();
    if (row.hostUserId !== req.user!.id && !req.user!.isOwner) return reply.code(403).send({ error: "only the host can end the table" });
    const closed = room.closeTable(`${req.user!.displayName} closed the table (no result recorded).`);
    return { closed };
  });

  /** AI Coach M1: the caller's OWN decision snapshots for one game (never another seat's). */
  app.get<{ Params: { code: string } }>("/api/rooms/:code/decisions", { preHandler: auth }, async (req, reply) => {
    const room = findRoom(req.params.code);
    if (!room || !roomsManager.decisions) return reply.code(404).send({ error: "no room with that code" });
    return { decisions: roomsManager.decisions.forUser(room.id, req.user!.id) };
  });

  app.get("/api/rooms/mine", { preHandler: auth }, async (req): Promise<MyRoomsResponse> => {
    return { rooms: roomsManager.listForUser(req.user!.id) };
  });

  app.get("/api/rooms/decks", { preHandler: auth }, async (req) => {
    return { decks: roomsManager.decksFor(req.user!.id) };
  });

  app.get<{ Params: { code: string } }>("/api/rooms/:code", { preHandler: auth }, async (req, reply): Promise<RoomResponse | void> => {
    const room = findRoom(req.params.code);
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    return { room: room.info(req.user!.id) };
  });

  app.post<{ Params: { code: string } }>(
    "/api/rooms/:code/join",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator } } },
    async (req, reply): Promise<RoomResponse | void> => {
      const room = findRoom(req.params.code);
      if (!room) return reply.code(404).send({ error: "no room with that code" });
      room.join(req.user!.id);
      room.broadcastRoom();
      return { room: room.info(req.user!.id) };
    },
  );

  app.get<{ Params: { code: string }; Querystring: { token?: string } }>("/api/rooms/:code/ws", { websocket: true }, (socket: WebSocket, req) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const user = userFromToken(handle, token);
    const room = findRoom(req.params.code);
    if (!user || !room) {
      socket.send(JSON.stringify({ t: "error", message: user ? "no room with that code" : "sign in required" }));
      socket.close(4001, user ? "no room" : "unauthorized");
      return;
    }

    const conn = room.attach(socket, user.id);
    if (!room.isEngine) agents?.ensureRunning(room); // engine tables: Forge plays bot seats, no Sonnet runner
    const fail = (message: string, cid?: string) => room.send(conn, cid ? { t: "error", message, cid } : { t: "error", message });

    socket.on("message", (data) => {
      void onMessage(data);
    });
    const onMessage = async (data: Buffer | ArrayBuffer | Buffer[]): Promise<void> => {
      if (!room.allow(conn)) return fail("slow down");
      let msg: ClientMessage;
      try {
        const text = data.toString();
        if (text.length > MAX_WS_MESSAGE) return fail("message too large");
        msg = JSON.parse(text) as ClientMessage;
      } catch {
        return fail("bad message");
      }
      if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return fail("bad message");
      try {
        switch (msg.t) {
          case "ping":
            room.send(conn, { t: "pong" });
            break;
          case "seat":
            room.takeSeat(user.id, Number(msg.seat), typeof msg.deckId === "string" ? msg.deckId : null);
            room.broadcastRoom();
            break;
          case "unseat":
            room.leaveSeat(user.id);
            room.broadcastRoom();
            break;
          case "start":
            await room.startAny(user.id);
            room.broadcastRoom();
            if (!room.isEngine) agents?.onGameStarted(room);
            break;
          case "event":
            room.submit(user.id, msg.event);
            break;
          case "undo":
            room.undo(user.id);
            break;
          case "revert":
            room.revert(user.id, Number(msg.toSeq));
            break;
          case "tableSettings":
            room.setTableSettings(user.id, { testGame: msg.testGame, tableBracket: msg.tableBracket, firstPlayer: msg.firstPlayer, openingHand: msg.openingHand });
            room.broadcastRoom();
            break;
          case "voiceLink":
            room.setVoiceLink(user.id, msg.url);
            room.broadcastRoom();
            break;
          case "endTable": {
            const row = room.refreshRow();
            if (row.hostUserId !== user.id && !user.isOwner) throw new RoomError("only the host can end the table");
            room.closeTable(`${user.displayName} closed the table (no result recorded).`);
            break;
          }
          case "rematch": {
            const next = roomsManager.rematch(room, user.id);
            next.broadcastRoom();
            agents?.onGameStarted(next);
            break;
          }
          case "engine":
            if (!isEngineAnswer(msg.answer)) return fail("bad engine answer", msg.cid);
            room.engineAnswer(user.id, msg.answer);
            break;
          case "stops":
            if (!msg.stops || typeof msg.stops !== "object") return fail("bad stops");
            room.engineStops(user.id, msg.stops);
            break;
          case "roll":
            room.engineRoll(user.id);
            break;
          case "hold":
            if (msg.turn !== null && typeof msg.turn !== "number") return fail("bad hold");
            room.engineHold(user.id, msg.turn);
            break;
          case "concede":
            room.concede(user.id);
            break;
          case "leave":
            room.leave(user.id);
            room.broadcastRoom();
            socket.close(1000, "left");
            break;
          default:
            fail("unknown message");
        }
      } catch (err) {
        if (err instanceof RoomError) fail(err.message, (msg as { cid?: string }).cid);
        else {
          app.log.error({ err }, "room message failed");
          fail("something went wrong", (msg as { cid?: string }).cid);
        }
      }
    };

    socket.on("close", () => room.detach(conn));
    socket.on("error", () => room.detach(conn));
  });
}
