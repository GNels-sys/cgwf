import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { IMAGE_SIZES, type ImageSize } from "@cgwf/shared";
import { config } from "./config.js";
import type { DbHandle } from "./db/index.js";
import { cards } from "./db/schema.js";
import { scryfallFetch } from "./scryfall/client.js";

/**
 * Image proxy + cache. The first request for a card image fetches it from
 * Scryfall (through the throttled client) and stores it on the data volume;
 * every later request is served from disk with a one-year cache header.
 * Images are stored and served byte-for-byte: never resized, cropped or marked.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const inFlight = new Map<string, Promise<string | null>>();

function cachePath(size: ImageSize, id: string, back: boolean): string {
  return path.join(config.imageDir, size, id.slice(0, 2), `${id}${back ? "-back" : ""}.jpg`);
}

async function fetchToCache(url: string, dest: string): Promise<string | null> {
  const key = dest;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const job = (async () => {
    try {
      const res = await scryfallFetch(url, { headers: { Accept: "image/*" } });
      if (!res.ok || !res.body) return null;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return dest;
    } catch {
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

export function registerImageRoutes(app: FastifyInstance, handle: DbHandle): void {
  const lookup = (size: string, id: string, back: boolean) => {
    if (!IMAGE_SIZES.includes(size as ImageSize) || !UUID.test(id)) return null;
    const row = handle.db
      .select({ front: cards.imageFront, back: cards.imageBack })
      .from(cards)
      .where(eq(cards.id, id))
      .get();
    if (!row) return null;
    const uris = back ? row.back : row.front;
    const url = uris?.[size];
    return url ? { url, file: cachePath(size as ImageSize, id, back) } : null;
  };

  const serve = async (reply: FastifyReply, size: string, id: string, back: boolean) => {
    const target = lookup(size, id, back);
    if (!target) return reply.code(404).send({ error: "image not found" });
    let file: string | null = fs.existsSync(target.file) ? target.file : null;
    if (!file) file = await fetchToCache(target.url, target.file);
    if (!file) return reply.code(502).send({ error: "image unavailable" });
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.type("image/jpeg");
    return reply.send(fs.createReadStream(file));
  };

  app.get<{ Params: { size: string; file: string } }>("/img/:size/:file", async (req, reply) => {
    const id = req.params.file.replace(/\.jpg$/i, "");
    return serve(reply, req.params.size, id, false);
  });

  app.get<{ Params: { size: string; id: string } }>("/img/:size/:id/back.jpg", async (req, reply) => {
    return serve(reply, req.params.size, req.params.id, true);
  });
}
