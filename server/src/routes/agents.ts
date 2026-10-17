import type { FastifyInstance } from "fastify";
import { isBracket, type AddAgentsRequest, type AddAgentsResponse, type AgentGamesResponse, type AgentsStatus, type DraftPrimerResponse, type RoomAgentsResponse } from "@cgwf/shared";
import type { AgentManager } from "../agents/manager.js";
import { requireOwner, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { isRoomCode, normalizeRoomCode } from "../rooms/codes.js";
import { RoomError, type RoomManager } from "../rooms/live.js";

interface Deps {
  handle: DbHandle;
  agents: AgentManager;
  roomsManager: RoomManager;
}

/**
 * Phase 7, owner only, and only when AGENTS_ENABLED=1:
 *   GET    /api/agents/status                 flags, model, caps, today's spend
 *   GET    /api/agents/games                  recent agent games with spend
 *   POST   /api/rooms/:code/agents            {count, bracket} -> replace the lobby's agents
 *   DELETE /api/rooms/:code/agents            remove them
 *   GET    /api/rooms/:code/agents            runs + decisions (the reasoning drawer)
 *   POST   /api/library/:id/draft-primer      {force?} -> model-drafted primer (cached per deck)
 */
export function registerAgentRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, agents, roomsManager } = deps;
  const owner = [requireUser(handle), requireOwner(handle)];

  const gate = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean => {
    if (agents.enabled) return true;
    reply.code(404).send({ error: "agents are switched off (AGENTS_ENABLED)" });
    return false;
  };
  const findRoom = (raw: string) => {
    const code = normalizeRoomCode(raw);
    return isRoomCode(code) ? roomsManager.get(code) : null;
  };

  app.get("/api/agents/status", { preHandler: owner }, async (_req, reply): Promise<AgentsStatus | void> => {
    if (!gate(reply)) return;
    return agents.status();
  });

  app.get("/api/agents/games", { preHandler: owner }, async (_req, reply): Promise<AgentGamesResponse | void> => {
    if (!gate(reply)) return;
    return { games: agents.recentGames(), status: agents.status() };
  });

  app.post<{ Params: { code: string }; Body: Partial<AddAgentsRequest> | null }>("/api/rooms/:code/agents", { preHandler: owner }, async (req, reply): Promise<AddAgentsResponse | void> => {
    const room = findRoom(req.params.code);
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    if (!room.isEngine && !gate(reply)) return; // engine tables use Forge's AI: no flag needed
    const bracket = Number(req.body?.bracket ?? 2);
    if (!isBracket(bracket)) return reply.code(400).send({ error: "bracket must be 1-5" });
    try {
      return await agents.addAgents(room, req.user!.id, { count: Number(req.body?.count ?? 1), bracket });
    } catch (err) {
      if (err instanceof RoomError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete<{ Params: { code: string } }>("/api/rooms/:code/agents", { preHandler: owner }, async (req, reply) => {
    const room = findRoom(req.params.code);
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    if (!room.isEngine && !gate(reply)) return;
    if (room.refreshRow().hostUserId !== req.user!.id) return reply.code(403).send({ error: "only the host can remove agents" });
    try {
      return { removed: agents.removeAgents(room) };
    } catch (err) {
      if (err instanceof RoomError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get<{ Params: { code: string } }>("/api/rooms/:code/agents", { preHandler: owner }, async (req, reply): Promise<RoomAgentsResponse | void> => {
    if (!gate(reply)) return;
    const room = findRoom(req.params.code);
    if (!room) return reply.code(404).send({ error: "no room with that code" });
    return agents.roomAgents(room);
  });

  app.post<{ Params: { id: string }; Body: { force?: boolean } | null }>("/api/library/:id/draft-primer", { preHandler: owner }, async (req, reply): Promise<DraftPrimerResponse | void> => {
    if (!gate(reply)) return;
    try {
      return await agents.draftPrimer(req.params.id, { force: Boolean(req.body?.force) });
    } catch (err) {
      if (err instanceof RoomError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
