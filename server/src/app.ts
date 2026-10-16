import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { openDb, type DbHandle } from "./db/index.js";
import { registerImageRoutes } from "./images.js";
import { registerCardRoutes } from "./routes/cards.js";
import { Ingestor } from "./scryfall/ingest.js";
import { NameIndex } from "./search/index.js";

export interface AppContext {
  app: FastifyInstance;
  handle: DbHandle;
  index: NameIndex;
  ingestor: Ingestor;
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

  registerCardRoutes(app, { handle, index, ingestor });
  registerImageRoutes(app, handle);

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

  app.addHook("onClose", async () => handle.close());

  return { app, handle, index, ingestor };
}
