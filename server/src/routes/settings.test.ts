import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { RegisterResponse, TokenSearchResponse, UploadInfo, UserSettings } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-settings-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { checkUpload, sniffImage } = await import("../uploads.js");
const { parseTokenQuery } = await import("./cards.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

/** A real 1x1 PNG (67 bytes). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

describe("upload validation (pure)", () => {
  it("recognises real images by their bytes, not their declared type", () => {
    expect(sniffImage(PNG)?.mime).toBe("image/png");
    expect(sniffImage(JPEG_HEAD)?.mime).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a" + "x".repeat(20)))?.mime).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 " + "x".repeat(8)))?.mime).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(Buffer.from("hello world, not an image"))).toBeNull();
    expect(checkUpload(PNG, "text/plain")).toMatchObject({ ok: false, status: 415 });
    expect(checkUpload(Buffer.from("not an image at all!!"), "image/png")).toMatchObject({ ok: false, status: 415 });
    expect(checkUpload(Buffer.alloc(0), "image/png")).toMatchObject({ ok: false, status: 400 });
    expect(checkUpload(Buffer.alloc(2 * 1024 * 1024 + 1, 0xff), "image/jpeg")).toMatchObject({ ok: false, status: 413 });
    expect(checkUpload(PNG, "image/png")).toMatchObject({ ok: true, image: { mime: "image/png", ext: "png" } });
  });

  it("parses token queries with an optional P/T", () => {
    expect(parseTokenQuery("treasure")).toEqual({ name: "treasure", pt: null });
    expect(parseTokenQuery("2/2 zombie")).toEqual({ name: "zombie", pt: { power: "2", toughness: "2" } });
    expect(parseTokenQuery("Zombie 2 / 2")).toEqual({ name: "zombie", pt: { power: "2", toughness: "2" } });
    expect(parseTokenQuery("*/*")).toEqual({ name: "", pt: { power: "*", toughness: "*" } });
  });
});

describe("settings, uploads and the token finder over HTTP", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let alex = "";
  let blair = "";
  let casey = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const register = async (name: string, ip: string) => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip });
    return (res.json() as RegisterResponse).token;
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, casualRooms: true });
    await ctx.ingestor.run({ file: fixture });
    alex = await register("Alex", "10.1.0.1");
    blair = await register("Blair", "10.1.0.2");
    casey = await register("Casey", "10.1.0.3");
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns defaults, saves a partial update and drops garbage", async () => {
    const def = (await ctx.app.inject({ method: "GET", url: "/api/me/settings", headers: auth(alex) })).json() as { settings: UserSettings };
    expect(def.settings.playmat).toEqual({ kind: "preset", id: "felt-green" });
    expect(def.settings.layout.cardScale).toBe(1);

    const res = await ctx.app.inject({
      method: "PUT",
      url: "/api/me/settings",
      headers: auth(alex),
      payload: { playmat: { kind: "preset", id: "nebula" }, ui: "light", layout: { cardScale: 9, compact: true, hand: "sideways" }, accent: "neon", sleeve: { kind: "upload", id: "not-a-real-id" } },
    });
    expect(res.statusCode).toBe(200);
    const saved = (res.json() as { settings: UserSettings }).settings;
    expect(saved.playmat).toEqual({ kind: "preset", id: "nebula" });
    expect(saved.ui).toBe("light");
    expect(saved.layout.cardScale).toBe(1.5); // clamped
    expect(saved.layout.compact).toBe(true);
    expect(saved.layout.hand).toBe("bottom"); // unknown value ignored
    expect(saved.accent).toBe("brass"); // unknown accent ignored
    expect(saved.sleeve).toEqual({ kind: "preset", id: "classic" }); // unknown upload ignored
    const again = (await ctx.app.inject({ method: "GET", url: "/api/me/settings", headers: auth(alex) })).json() as { settings: UserSettings };
    expect(again.settings).toEqual(saved);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me/settings" })).statusCode).toBe(401);
  });

  let uploadId = "";
  it("accepts a real image under the limit and refuses everything else", async () => {
    const bad = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=playmat", headers: { ...auth(alex), "content-type": "image/png" }, payload: Buffer.from("definitely not an image file") });
    expect(bad.statusCode).toBe(415);
    const text = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=playmat", headers: { ...auth(alex), "content-type": "text/plain" }, payload: "hello" });
    expect([400, 415]).toContain(text.statusCode);
    const big = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=playmat", headers: { ...auth(alex), "content-type": "image/jpeg" }, payload: Buffer.concat([JPEG_HEAD, Buffer.alloc(2 * 1024 * 1024, 0)]) });
    expect(big.statusCode).toBe(413);
    const noKind = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=wallpaper", headers: { ...auth(alex), "content-type": "image/png" }, payload: PNG });
    expect(noKind.statusCode).toBe(400);
    const anon = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=playmat", headers: { "content-type": "image/png" }, payload: PNG });
    expect(anon.statusCode).toBe(401);

    const ok = await ctx.app.inject({ method: "POST", url: "/api/uploads?kind=playmat", headers: { ...auth(alex), "content-type": "image/png" }, payload: PNG });
    expect(ok.statusCode).toBe(201);
    const info = (ok.json() as { upload: UploadInfo }).upload;
    expect(info.mime).toBe("image/png");
    expect(info.bytes).toBe(PNG.length);
    expect(info.id).toMatch(/^[0-9a-f]{32}$/);
    uploadId = info.id;
    expect(fs.existsSync(path.join(tmp, "uploads", `${info.id}.png`))).toBe(true);

    // The settings may now point at it.
    const put = await ctx.app.inject({ method: "PUT", url: "/api/me/settings", headers: auth(alex), payload: { playmat: { kind: "upload", id: info.id } } });
    expect((put.json() as { settings: UserSettings }).settings.playmat).toEqual({ kind: "upload", id: info.id });
  });

  it("serves uploads to the owner and to table-mates only, with cache headers", async () => {
    const mine = await ctx.app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: auth(alex) });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["content-type"]).toBe("image/png");
    expect(mine.headers["cache-control"]).toContain("immutable");
    expect(mine.rawPayload.equals(PNG)).toBe(true);

    // Blair shares no room with Alex yet.
    expect((await ctx.app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: auth(blair) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: `/api/uploads/${uploadId}` })).statusCode).toBe(401);

    const room = (await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(alex) })).json() as { room: { code: string } };
    await ctx.app.inject({ method: "POST", url: `/api/rooms/${room.room.code}/join`, headers: auth(blair) });
    expect((await ctx.app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: auth(blair) })).statusCode).toBe(200);
    // Casey is still a stranger; room members' look is visible in room info.
    expect((await ctx.app.inject({ method: "GET", url: `/api/uploads/${uploadId}`, headers: auth(casey) })).statusCode).toBe(403);
    const info = (await ctx.app.inject({ method: "GET", url: `/api/rooms/${room.room.code}`, headers: auth(blair) })).json() as { room: { members: Array<{ name: string; look: { playmat: unknown } }> } };
    expect(info.room.members.find((m) => m.name === "Alex")?.look.playmat).toEqual({ kind: "upload", id: uploadId });

    // Deleting removes the file and the settings fall back to a preset.
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/uploads/${uploadId}`, headers: auth(blair) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/uploads/${uploadId}`, headers: auth(alex) })).statusCode).toBe(200);
    expect(fs.existsSync(path.join(tmp, "uploads", `${uploadId}.png`))).toBe(false);
    const after = (await ctx.app.inject({ method: "GET", url: "/api/me/settings", headers: auth(alex) })).json() as { settings: UserSettings };
    expect(after.settings.playmat).toEqual({ kind: "preset", id: "felt-green" });
  });

  it("finds tokens in the catalogue and offers the usual ones with no query", async () => {
    const treasure = (await ctx.app.inject({ method: "GET", url: "/api/tokens?q=treas" })).json() as TokenSearchResponse;
    expect(treasure.tokens[0]?.name).toBe("Treasure");
    expect(treasure.tokens[0]?.typeLine).toContain("Treasure");
    const popular = (await ctx.app.inject({ method: "GET", url: "/api/tokens" })).json() as TokenSearchResponse;
    expect(popular.tokens.map((t) => t.name)).toContain("Treasure");
    const none = (await ctx.app.inject({ method: "GET", url: "/api/tokens?q=sol%20ring" })).json() as TokenSearchResponse;
    expect(none.tokens).toHaveLength(0); // real cards never show up as tokens
    const pt = (await ctx.app.inject({ method: "GET", url: "/api/tokens?q=9/9" })).json() as TokenSearchResponse;
    expect(pt.tokens).toHaveLength(0);
  });
});
