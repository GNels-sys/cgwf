import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { openDb, type DbHandle } from "./db/index.js";
import { registerImageRoutes } from "./images.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerDeckRoutes } from "./routes/decks.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { RoomManager } from "./rooms/live.js";
import { Ingestor } from "./scryfall/ingest.js";
import { NameIndex } from "./search/index.js";

export interface AppContext {
  app: FastifyInstance;
  handle: DbHandle;
  index: NameIndex;
  ingestor: Ingestor;
  roomsManager: RoomManager;
}

/** Build the Fastify app with every route wired. Listening is the caller's job. */
export async function buildApp(opts: { dbFile?: string; logger?: boolean | "plain" } = {}): Promise<AppContext> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : opts.logger === "plain" || config.isProduction
          ? true
          : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } },
    trustProxy: true,
    bodyLimit: 1_048_576,
    // One line per request is too chatty for Fly logs; errors are still logged.
    disableRequestLogging: true,
  });

  const handle = openDb(opts.dbFile);
  const index = new NameIndex(handle);
  index.build();
  const ingestor = new Ingestor(handle, app.log);
  ingestor.onComplete(() => index.build());

  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  // One WebSocket per connected client; the largest frame is a token with a full printing.
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const roomsManager = new RoomManager(handle, app.log);

  registerCardRoutes(app, { handle, index, ingestor });
  registerImageRoutes(app, handle);
  registerMeRoutes(app, handle);
  registerAuthRoutes(app, handle);
  registerDeckRoutes(app, { handle, index });
  registerRoomRoutes(app, { handle, roomsManager });
  registerSettingsRoutes(app, { handle, onSettingsChanged: (userId) => roomsManager.userChanged(userId) });

  // In production the server also hosts the built client (a static SPA).
  const indexHtml = path.join(config.clientDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: "/",
      wildcard: false,
      setHeaders(reply, filePath) {
        // Vite fingerprints everything under /assets, so those can be cached forever.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          reply.header("Cache-Control", "no-cache");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/img/")) {
        return reply.type("text/html").header("Cache-Control", "no-cache").send(fs.readFileSync(indexHtml));
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  app.addHook("onClose", async () => {
    roomsManager.close();
    handle.close();
  });

  return { app, handle, index, ingestor, roomsManager };
}
