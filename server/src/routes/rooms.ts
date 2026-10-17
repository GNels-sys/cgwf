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
      if (wantEngine && !roomsManager.engineAvailable()) {
        return reply.code(503).send({ error: roomsManager.engineConfigured() ? "the rules engine is not reachable right now; try again in a moment" : "the rules engine is not enabled on this server" });
      }
      const room = roomsManager.create(req.user!.id, { engine: wantEngine });
      return reply.code(201).send({ room: room.info(req.user!.id) });
    },
  );

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
    agents?.ensureRunning(room);
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
