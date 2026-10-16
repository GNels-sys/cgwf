import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_SETTINGS,
  UPLOAD_KINDS,
  UPLOAD_MAX_BYTES,
  UPLOAD_MIME_TYPES,
  isUploadId,
  sanitizeSettings,
  type UploadInfo,
  type UploadKind,
  type UserSettings,
} from "@cgwf/shared";
import { rateLimitKey, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { uploads, userSettings, type UploadRow } from "../db/schema.js";
import { canSeeUploadsOf, loadSettings } from "../settings.js";
import { checkUpload, extFor, newUploadId, removeUpload, uploadFile, writeUpload } from "../uploads.js";

interface Deps {
  handle: DbHandle;
  /** Called after a user's settings change so live rooms can re-send their look. */
  onSettingsChanged?: (userId: string) => void;
}

const MAX_UPLOADS_PER_USER = 12;

function toInfo(row: UploadRow): UploadInfo {
  return { id: row.id, kind: row.kind as UploadKind, mime: row.mime, bytes: row.bytes, createdAt: row.createdAt };
}

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);

  // Raw image bodies for uploads. Fastify answers 413 itself when the body is over the limit.
  app.addContentTypeParser([...UPLOAD_MIME_TYPES, "application/octet-stream"], { parseAs: "buffer", bodyLimit: UPLOAD_MAX_BYTES }, (_req, body, done) => done(null, body));

  app.get("/api/me/settings", { preHandler: auth }, async (req): Promise<{ settings: UserSettings }> => ({ settings: loadSettings(handle, req.user!.id) }));

  app.put<{ Body: unknown }>("/api/me/settings", { preHandler: auth }, async (req): Promise<{ settings: UserSettings }> => {
    const userId = req.user!.id;
    const current = loadSettings(handle, userId);
    const next = sanitizeSettings(req.body, current);
    for (const key of ["playmat", "sleeve"] as const) {
      const t = next[key];
      if (t.kind === "upload" && !handle.db.select({ id: uploads.id }).from(uploads).where(and(eq(uploads.id, t.id), eq(uploads.userId, userId))).get()) {
        next[key] = current[key].kind === "upload" && current[key].id === t.id ? DEFAULT_SETTINGS[key] : current[key];
      }
    }
    const now = new Date().toISOString();
    handle.db
      .insert(userSettings)
      .values({ userId, settings: next, updatedAt: now })
      .onConflictDoUpdate({ target: userSettings.userId, set: { settings: next, updatedAt: now } })
      .run();
    deps.onSettingsChanged?.(userId);
    return { settings: next };
  });

  app.get("/api/uploads", { preHandler: auth }, async (req): Promise<{ uploads: UploadInfo[] }> => {
    const rows = handle.db.select().from(uploads).where(eq(uploads.userId, req.user!.id)).all();
    return { uploads: rows.map(toInfo) };
  });

  app.post<{ Querystring: { kind?: string }; Body: unknown }>(
    "/api/uploads",
    { preHandler: auth, bodyLimit: UPLOAD_MAX_BYTES, config: { rateLimit: { max: 30, timeWindow: "1 hour", keyGenerator } } },
    async (req, reply): Promise<{ upload: UploadInfo } | void> => {
      const kind = req.query.kind;
      if (!(UPLOAD_KINDS as readonly string[]).includes(kind ?? "")) return reply.code(400).send({ error: "kind must be playmat or sleeve" });
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "send the image file as the request body" });
      const check = checkUpload(body, req.headers["content-type"]);
      if (!check.ok) return reply.code(check.status).send({ error: check.error });
      const userId = req.user!.id;
      const count = handle.db.select({ id: uploads.id }).from(uploads).where(eq(uploads.userId, userId)).all().length;
      if (count >= MAX_UPLOADS_PER_USER) return reply.code(409).send({ error: `you can keep up to ${MAX_UPLOADS_PER_USER} uploaded images; delete one first` });
      const id = newUploadId();
      writeUpload(id, check.image, body);
      const row = { id, userId, kind: kind as UploadKind, mime: check.image.mime, bytes: body.length, createdAt: new Date().toISOString() };
      handle.db.insert(uploads).values(row).run();
      return reply.code(201).send({ upload: toInfo({ ...row }) });
    },
  );

  app.get<{ Params: { id: string } }>("/api/uploads/:id", { preHandler: auth }, async (req, reply) => {
    if (!isUploadId(req.params.id)) return reply.code(404).send({ error: "no such image" });
    const row = handle.db.select().from(uploads).where(eq(uploads.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: "no such image" });
    if (!canSeeUploadsOf(handle, req.user!.id, row.userId)) return reply.code(403).send({ error: "that image belongs to a player you are not at a table with" });
    const file = uploadFile(row.id, extFor(row.mime));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "image file missing" });
    // Ids are random and the bytes never change, so the browser may keep its copy for a year (privately).
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    reply.type(row.mime);
    return reply.send(fs.createReadStream(file));
  });

  app.delete<{ Params: { id: string } }>("/api/uploads/:id", { preHandler: auth }, async (req, reply) => {
    if (!isUploadId(req.params.id)) return reply.code(404).send({ error: "no such image" });
    const row = handle.db.select().from(uploads).where(and(eq(uploads.id, req.params.id), eq(uploads.userId, req.user!.id))).get();
    if (!row) return reply.code(404).send({ error: "no such image" });
    handle.db.delete(uploads).where(eq(uploads.id, row.id)).run();
    removeUpload(row.id, row.mime);
    deps.onSettingsChanged?.(req.user!.id);
    return { ok: true };
  });
}
