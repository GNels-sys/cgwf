import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { RegisterResponse, RoomResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-discord-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { rooms } = await import("../db/schema.js");
const { DiscordClient, DiscordError } = await import("./client.js");
const { DiscordVoice, VOICE_USER_LIMIT, effectivePermissions } = await import("./voice.js");
const { normaliseInvite } = await import("@cgwf/shared");

const GUILD = "100";
const CATEGORY = "200";
const BOT = "300";
const ROLE = "400";

/** An in-memory Discord: just the routes the bot uses. */
class FakeDiscord {
  channels: Array<{ id: string; name: string; type: number; parent_id: string | null; user_limit?: number; permission_overwrites?: unknown[] }> = [
    { id: CATEGORY, name: "CGwF Tables", type: 4, parent_id: null, permission_overwrites: [] },
    { id: "201", name: "General", type: 2, parent_id: CATEGORY },
  ];
  invites = new Map<string, string>();
  calls: string[] = [];
  next = 500;
  rolePerms = String((1n << 4n) | (1n << 10n) | (1n << 0n) | (1n << 20n));
  token = "good-token";
  failCreate = false;
  /** Answer the next request on this route with a 429 first. */
  rateLimitOnce: string | null = null;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const p = url.replace("https://discord.com/api/v10", "");
    this.calls.push(`${method} ${p}`);
    const auth = (init?.headers as Record<string, string>)["Authorization"];
    const ua = (init?.headers as Record<string, string>)["User-Agent"];
    if (!ua?.startsWith("DiscordBot (")) return this.json(400, { message: "bad user agent" });
    if (auth !== `Bot ${this.token}`) return this.json(401, { message: "401: Unauthorized", code: 0 });
    if (this.rateLimitOnce === `${method} ${p}`) {
      this.rateLimitOnce = null;
      return this.json(429, { message: "You are being rate limited.", retry_after: 0.01, global: false });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method === "GET" && p === "/users/@me") return this.json(200, { id: BOT, username: "cgwf-bot", global_name: "CGwF Bot" });
    if (method === "GET" && p === `/guilds/${GUILD}`) return this.json(200, { id: GUILD, name: "Owner Server", owner_id: "999", roles: [{ id: GUILD, permissions: "0" }, { id: ROLE, permissions: this.rolePerms }] });
    if (method === "GET" && p.startsWith("/guilds/") && p.endsWith("/channels") && p !== `/guilds/${GUILD}/channels`) return this.json(404, { message: "Unknown Guild", code: 10004 });
    if (method === "GET" && p.startsWith("/guilds/") && !p.includes(GUILD)) return this.json(404, { message: "Unknown Guild", code: 10004 });
    if (method === "GET" && p === `/guilds/${GUILD}/channels`) return this.json(200, this.channels);
    if (method === "GET" && p === `/guilds/${GUILD}/members/${BOT}`) return this.json(200, { roles: [ROLE] });
    if (method === "POST" && p === `/guilds/${GUILD}/channels`) {
      if (this.failCreate) return this.json(403, { message: "Missing Permissions", code: 50013 });
      const ch = { id: String(this.next++), name: body.name, type: body.type, parent_id: body.parent_id, user_limit: body.user_limit };
      this.channels.push(ch);
      return this.json(201, ch);
    }
    let m = /^\/channels\/(\d+)\/invites$/.exec(p);
    if (method === "POST" && m) {
      const code = `inv${m[1]}`;
      this.invites.set(code, m[1]!);
      return this.json(200, { code, max_age: body.max_age, max_uses: body.max_uses });
    }
    m = /^\/channels\/(\d+)$/.exec(p);
    if (m) {
      const ch = this.channels.find((c) => c.id === m![1]);
      if (!ch) return this.json(404, { message: "Unknown Channel", code: 10003 });
      if (method === "PATCH") {
        ch.name = body.name;
        return this.json(200, ch);
      }
      if (method === "DELETE") {
        this.channels = this.channels.filter((c) => c.id !== ch.id);
        return this.json(200, ch);
      }
    }
    return this.json(404, { message: `no fake route ${method} ${p}` });
  };

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  voiceChannels(): string[] {
    return this.channels.filter((c) => c.type === 2 && c.name.startsWith("CGwF · ")).map((c) => c.name);
  }
}

describe("Discord voice: one temporary channel per table", () => {
  const fake = new FakeDiscord();
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let host: RegisterResponse;
  let other: RegisterResponse;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const voice = () => ctx.roomsManager.voice!;
  const newRoom = async (token: string) => ((await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: auth(token), payload: {} })).json() as { room: { code: string; id: string } }).room;
  const row = (code: string) => ctx.handle.db.select().from(rooms).where(eq(rooms.code, code)).get()!;

  beforeAll(async () => {
    ctx = await buildApp({
      logger: false,
      casualRooms: true,
      idleSweep: false,
      discord: { token: "good-token", guildId: GUILD, categoryId: CATEGORY },
      discordFetch: fake.fetch,
      discordClientOpts: { sleep: async () => undefined },
      discordBoot: false,
    });
    const reg = async (name: string, ip: string) => (await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip })).json() as RegisterResponse;
    host = await reg("Host", "10.3.0.1");
    other = await reg("Other", "10.3.0.2");
    expect((await voice().verify()).state).toBe("ok");
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("reports the configuration: connected as the bot, and the category", () => {
    expect(voice().status).toMatchObject({ state: "ok", botName: "CGwF Bot", categoryName: "CGwF Tables" });
  });

  it("creates a voice channel with an invite when a table is created", async () => {
    const room = await newRoom(host.token);
    await voice().idle();
    const ch = fake.channels.find((c) => c.name === `CGwF · ${room.code}`)!;
    expect(ch).toMatchObject({ type: 2, parent_id: CATEGORY, user_limit: VOICE_USER_LIMIT });
    expect(row(room.code)).toMatchObject({ voiceChannelId: ch.id, voiceInviteUrl: `https://discord.gg/inv${ch.id}` });
  });

  it("gives the invite only to members of that table", async () => {
    const room = await newRoom(host.token);
    await voice().idle();
    const as = async (t: string) => ((await ctx.app.inject({ method: "GET", url: `/api/rooms/${room.code}`, headers: auth(t) })).json() as RoomResponse).room;
    expect((await as(host.token)).voice).toMatchObject({ source: "discord", botEnabled: true });
    expect((await as(host.token)).voice!.url).toMatch(/^https:\/\/discord\.gg\/inv\d+$/);
    expect((await as(other.token)).voice).toBeNull(); // not at this table
    const mine = (await ctx.app.inject({ method: "GET", url: "/api/rooms/mine", headers: auth(host.token) })).body;
    expect(mine).not.toMatch(/discord\.gg/); // lists never carry it
    await ctx.app.inject({ method: "POST", url: `/api/rooms/${room.code}/join`, headers: auth(other.token) });
    expect((await as(other.token)).voice!.url).toMatch(/discord\.gg/); // a spectator is a member
  });

  it("deletes the channel when the host ends the table, and when an idle table is closed", async () => {
    const a = await newRoom(host.token);
    const b = await newRoom(host.token);
    await voice().idle();
    const chA = row(a.code).voiceChannelId!;
    await ctx.app.inject({ method: "POST", url: `/api/rooms/${a.code}/end`, headers: auth(host.token) });
    await voice().idle();
    expect(fake.channels.some((c) => c.id === chA)).toBe(false);
    expect(row(a.code).voiceChannelId).toBeNull();
    const chB = row(b.code).voiceChannelId!;
    ctx.handle.db.update(rooms).set({ updatedAt: new Date(Date.now() - 49 * 3600_000).toISOString() }).where(eq(rooms.code, b.code)).run();
    expect(ctx.roomsManager.closeIdle(48 * 3600_000, "idle")).toContain(b.code);
    await voice().idle();
    expect(fake.channels.some((c) => c.id === chB)).toBe(false);
  });

  it("deletes the channel after the rematch grace when a game ends on its own", async () => {
    const r = await newRoom(host.token);
    await voice().idle();
    const ch = row(r.code).voiceChannelId!;
    voice().scheduleRelease(r.id, 20);
    await new Promise((res) => setTimeout(res, 60));
    await voice().idle();
    expect(fake.channels.some((c) => c.id === ch)).toBe(false);
  });

  it("reuses the same channel for a rematch, renamed to the new code", async () => {
    const r = await newRoom(host.token);
    await voice().idle();
    const ch = row(r.code).voiceChannelId!;
    const url = row(r.code).voiceInviteUrl;
    ctx.handle.db.update(rooms).set({ status: "ended" }).where(eq(rooms.code, r.code)).run();
    const live = ctx.roomsManager.get(r.code)!;
    live.refreshRow(); // the ending schedules a release ...
    const next = ctx.roomsManager.rematch(live, host.user.id); // ... which the rematch cancels
    await voice().idle();
    expect(row(next.code)).toMatchObject({ voiceChannelId: ch, voiceInviteUrl: url });
    expect(row(r.code).voiceChannelId).toBeNull();
    expect(fake.channels.find((c) => c.id === ch)?.name).toBe(`CGwF · ${next.code}`);
    expect(fake.calls.filter((c) => c === `POST /guilds/${GUILD}/channels`).length).toBeGreaterThan(0);
  });

  it("sweeps orphan CGwF channels, and only those", async () => {
    const open = await newRoom(host.token);
    await voice().idle();
    fake.channels.push({ id: "777", name: "CGwF · ZZZZZZ", type: 2, parent_id: CATEGORY });
    fake.channels.push({ id: "778", name: "CGwF · YYYYYY", type: 2, parent_id: "other-category" });
    const deleted = await voice().sweepOrphans();
    expect(deleted).toBe(1);
    expect(fake.channels.some((c) => c.id === "777")).toBe(false);
    expect(fake.channels.some((c) => c.id === "778")).toBe(true); // not under our category
    expect(fake.channels.some((c) => c.id === "201")).toBe(true); // not ours
    expect(fake.channels.some((c) => c.id === row(open.code).voiceChannelId)).toBe(true); // an open table keeps its channel
  });

  it("shows voice unavailable and the host's manual link when Discord fails; validates manual links", async () => {
    fake.failCreate = true;
    const r = await newRoom(host.token);
    await voice().idle();
    fake.failCreate = false;
    const live = ctx.roomsManager.get(r.code)!;
    expect(live.info(host.user.id).voice).toMatchObject({ url: null, unavailable: true });
    expect(() => live.setVoiceLink(host.user.id, "https://example.com/not-discord")).toThrow(/not a Discord invite/);
    expect(() => live.setVoiceLink(other.user.id, "https://discord.gg/abc123")).toThrow(/only the host/);
    live.setVoiceLink(host.user.id, "discord.com/invite/AbC-123");
    expect(live.info(host.user.id).voice).toMatchObject({ url: "https://discord.gg/AbC-123", source: "manual" });
    // a saved default link fills new tables the bot could not serve
    await ctx.app.inject({ method: "PUT", url: "/api/me/settings", headers: auth(host.token), payload: { discordInvite: "https://discord.gg/default1" } });
    fake.failCreate = true;
    const r2 = await newRoom(host.token);
    await voice().idle();
    fake.failCreate = false;
    expect(ctx.roomsManager.get(r2.code)!.info(host.user.id).voice).toMatchObject({ url: "https://discord.gg/default1", source: "manual" });
  });

  it("never blocks a table: creating a room does not wait for Discord", async () => {
    const started = Date.now();
    const slow = new DiscordVoice(ctx.handle, ctx.app.log, { token: "good-token", guildId: GUILD, categoryId: CATEGORY }, () => new Promise(() => undefined), { sleep: async () => undefined });
    slow.status = { state: "ok", botName: "x", categoryName: "y", problem: null };
    slow.onRoomCreated("no-such-room", "AAAAAA"); // returns at once
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe("Discord REST client", () => {
  it("retries after a 429 with retry_after, and gives up on long waits", async () => {
    const fake = new FakeDiscord();
    const sleeps: number[] = [];
    const c = new DiscordClient({ token: "good-token", fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms) });
    fake.rateLimitOnce = "GET /users/@me";
    expect(await c.request<{ username: string }>("GET", "/users/@me")).toMatchObject({ username: "cgwf-bot" });
    expect(sleeps.length).toBe(1);
    expect(fake.calls.filter((x) => x === "GET /users/@me").length).toBe(2);
    const long = new DiscordClient({
      token: "good-token",
      fetch: async () => new Response(JSON.stringify({ retry_after: 120 }), { status: 429 }),
      sleep: async () => undefined,
    });
    await expect(long.request("GET", "/users/@me")).rejects.toThrow(DiscordError);
  });

  it("times out instead of hanging", async () => {
    const c = new DiscordClient({ token: "t", fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))), timeoutMs: 20 });
    await expect(c.request("GET", "/users/@me")).rejects.toThrow(/timed out/);
  });
});

describe("Discord configuration check names the exact problem", () => {
  const check = async (fake: FakeDiscord, cfg: { token: string; guildId: string; categoryId: string }) => {
    const v = new DiscordVoice({} as never, { info() {}, warn() {} } as never, cfg, fake.fetch, { sleep: async () => undefined });
    return v.verify();
  };
  const cfg = { token: "good-token", guildId: GUILD, categoryId: CATEGORY };

  it("bad token, wrong guild, missing or wrong category, missing permission", async () => {
    expect((await check(new FakeDiscord(), { ...cfg, token: "nope" })).problem).toMatch(/DISCORD_BOT_TOKEN/);
    expect((await check(new FakeDiscord(), { ...cfg, guildId: "555" })).problem).toMatch(/DISCORD_GUILD_ID 555/);
    expect((await check(new FakeDiscord(), { ...cfg, categoryId: "666" })).problem).toMatch(/DISCORD_CATEGORY_ID 666: no channel/);
    expect((await check(new FakeDiscord(), { ...cfg, categoryId: "201" })).problem).toMatch(/is not a category/);
    const noManage = new FakeDiscord();
    noManage.rolePerms = String((1n << 10n) | (1n << 0n) | (1n << 20n));
    expect((await check(noManage, cfg)).problem).toMatch(/lacks Manage Channels/);
    expect((await check(new FakeDiscord(), cfg)).state).toBe("ok");
  });

  it("applies category overwrites like Discord does", () => {
    const base = { guildId: "g", ownerId: "o", memberId: "b", memberRoles: ["r"], roles: [{ id: "g", permissions: "0" }, { id: "r", permissions: String(1n << 4n) }] };
    expect(effectivePermissions({ ...base, overwrites: [] }) & (1n << 4n)).toBe(1n << 4n);
    expect(effectivePermissions({ ...base, overwrites: [{ id: "r", type: 0, allow: "0", deny: String(1n << 4n) }] }) & (1n << 4n)).toBe(0n);
    expect(effectivePermissions({ ...base, overwrites: [{ id: "r", type: 0, allow: "0", deny: String(1n << 4n) }, { id: "b", type: 1, allow: String(1n << 4n), deny: "0" }] }) & (1n << 4n)).toBe(1n << 4n);
  });
});

describe("manual invite links", () => {
  it("accepts discord.gg and discord.com/invite only", () => {
    expect(normaliseInvite("https://discord.gg/abc123")).toBe("https://discord.gg/abc123");
    expect(normaliseInvite("discord.com/invite/AbC-1")).toBe("https://discord.gg/AbC-1");
    expect(normaliseInvite("https://www.discord.com/invite/xyz99/")).toBe("https://discord.gg/xyz99");
    expect(normaliseInvite("https://discord.gg.evil.com/abc")).toBeNull();
    expect(normaliseInvite("https://example.com/invite/abc")).toBeNull();
    expect(normaliseInvite("javascript:alert(1)")).toBeNull();
  });
});
