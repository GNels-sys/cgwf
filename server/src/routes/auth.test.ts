import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { DeckDetail, RegisterResponse, SessionInfo, User } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-auth-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";
process.env.OWNER_CLAIM_CODE = "correct-horse-battery-staple";

const { buildApp } = await import("../app.js");
const { requireOwner } = await import("../auth.js");
const { hashPassword, verifyPassword, secretsEqual } = await import("../password.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/**
 * Build a database exactly as a pre-Phase-5 server left it (migrations 0000-0003
 * only) with one device user, so the real migrations can be exercised on it.
 */
function seedLegacyDb(file: string): { token: string; userId: string } {
  const legacy = path.join(tmp, "legacy-migrations");
  fs.mkdirSync(path.join(legacy, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const keep = journal.entries.filter((e) => e.idx <= 3);
  fs.writeFileSync(path.join(legacy, "meta/_journal.json"), JSON.stringify({ ...journal, entries: keep }));
  for (const e of keep) fs.copyFileSync(path.join(migrationsDir, `${e.tag}.sql`), path.join(legacy, `${e.tag}.sql`));

  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: legacy });
  const token = randomBytes(32).toString("base64url");
  const userId = "legacy-user-1";
  const now = "2026-10-01T00:00:00.000Z";
  sqlite
    .prepare("INSERT INTO users (id, display_name, avatar, color, device_token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(userId, "Old Timer", "owl", "jade", createHash("sha256").update(token).digest("hex"), now, now);
  sqlite.prepare("INSERT INTO decks (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("legacy-deck-1", userId, "Old deck", now, now);
  sqlite.close();
  return { token, userId };
}

describe("passwords (pure)", () => {
  it("hashes with scrypt and verifies in constant time", async () => {
    const record = await hashPassword("hunter2hunter2");
    expect(record.startsWith("scrypt$16384$8$1$")).toBe(true);
    expect(await verifyPassword("hunter2hunter2", record)).toBe(true);
    expect(await verifyPassword("hunter2hunter3", record)).toBe(false);
    expect(await verifyPassword("hunter2hunter2", "garbage")).toBe(false);
    expect(await verifyPassword("hunter2hunter2", null)).toBe(false);
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});

describe("migration of an existing device user", () => {
  const file = path.join(tmp, "legacy.db");
  let legacy: { token: string; userId: string };
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    legacy = seedLegacyDb(file);
    ctx = await buildApp({ logger: false, dbFile: file });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("keeps the old device token working through the new sessions table", async () => {
    const me = await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(legacy.token) });
    expect(me.statusCode).toBe(200);
    const user = (me.json() as { user: User }).user;
    expect(user.id).toBe(legacy.userId);
    expect(user.displayName).toBe("Old Timer");
    expect(user.email).toBeNull();
    expect(user.isOwner).toBe(false);

    const decks = await ctx.app.inject({ method: "GET", url: "/api/decks", headers: auth(legacy.token) });
    expect((decks.json() as { decks: Array<{ name: string }> }).decks.map((d) => d.name)).toEqual(["Old deck"]);

    const list = await ctx.app.inject({ method: "GET", url: "/api/me/sessions", headers: auth(legacy.token) });
    const sessions = (list.json() as { sessions: SessionInfo[] }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ device: "Earlier device", current: true });

    const cols = ctx.handle.sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).not.toContain("device_token_hash");
    expect(cols.map((c) => c.name)).toContain("is_owner");
  });
});

describe("accounts, sessions and the owner claim", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let phone = ""; // Alex's first device token (device-only profile at first)
  let laptop = ""; // Alex's second device after signing in
  let alexId = "";
  const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

  const register = async (name: string, ip: string, ua = UA_IPHONE) => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "fox", color: "jade" }, remoteAddress: ip, headers: { "user-agent": ua } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RegisterResponse;
    return body;
  };
  const me = async (token: string) => (await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(token) })).json() as { user: User };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    // A tiny owner-only route, exactly how a later phase would declare one.
    ctx.app.get("/api/test/owner-only", { preHandler: requireOwner(ctx.handle) }, async () => ({ secret: 42 }));
    await ctx.ingestor.run({ file: fixture });
    const reg = await register("Alex", "10.5.0.1");
    phone = reg.token;
    alexId = reg.user.id;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("starts as a device-only profile with a labelled session", async () => {
    const user = (await me(phone)).user;
    expect(user.email).toBeNull();
    expect(user.isOwner).toBe(false);
    const list = (await ctx.app.inject({ method: "GET", url: "/api/me/sessions", headers: auth(phone) })).json() as { sessions: SessionInfo[] };
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ device: "iPhone / Safari", current: true });
  });

  it("rejects bad sign-ups with specific messages and never touches the profile", async () => {
    const bad = async (payload: unknown, status: number) => {
      const res = await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(phone), payload, remoteAddress: "10.5.0.1" });
      expect(res.statusCode).toBe(status);
      return (res.json() as { error: string }).error;
    };
    expect(await bad({ email: "not-an-email", password: "longenough1" }, 400)).toMatch(/email/);
    expect(await bad({ email: "alex@example.com", password: "short" }, 400)).toMatch(/at least 8/);
    expect(await bad({ email: "alex@example.com", password: "x".repeat(129) }, 400)).toMatch(/at most 128/);
    const anon = await ctx.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: "a@b.co", password: "longenough1" } });
    expect(anon.statusCode).toBe(401);
    expect((await me(phone)).user.email).toBeNull();
  });

  it("adds an email + password to the device profile, keeping everything", async () => {
    // Give Alex a deck first so we can prove it survives.
    const deck = await ctx.app.inject({ method: "POST", url: "/api/decks", headers: auth(phone), payload: { name: "Phone deck", cards: [{ cardId: "a1b2c3d4-0000-4000-8000-000000000001", quantity: 1, board: "main" }] }, remoteAddress: "10.5.0.1" });
    expect(deck.statusCode).toBe(201);
    const deckId = (deck.json() as { deck: DeckDetail }).deck.id;

    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(phone), payload: { email: "  Alex@Example.COM ", password: "longenough1" }, remoteAddress: "10.5.0.1" });
    expect(res.statusCode).toBe(200);
    const user = (res.json() as { user: User }).user;
    expect(user.id).toBe(alexId);
    expect(user.email).toBe("alex@example.com");
    expect(user.displayName).toBe("Alex");

    // Same token still works; same decks.
    const decks = (await ctx.app.inject({ method: "GET", url: "/api/decks", headers: auth(phone) })).json() as { decks: Array<{ id: string }> };
    expect(decks.decks.map((d) => d.id)).toEqual([deckId]);

    // Cannot sign up twice, and nobody else can take that email.
    const again = await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(phone), payload: { email: "other@example.com", password: "longenough1" }, remoteAddress: "10.5.0.1" });
    expect(again.statusCode).toBe(409);
    const blair = await register("Blair", "10.5.0.2");
    const taken = await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(blair.token), payload: { email: "ALEX@example.com", password: "longenough1" }, remoteAddress: "10.5.0.2" });
    expect(taken.statusCode).toBe(409);
  });

  it("signs in from a second device with a new token; both devices see the same account", async () => {
    const wrong = await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "wrong-password" }, remoteAddress: "10.5.0.3" });
    expect(wrong.statusCode).toBe(401);
    const unknown = await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "nobody@example.com", password: "longenough1" }, remoteAddress: "10.5.0.3" });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { error: string }).error).toBe((wrong.json() as { error: string }).error);

    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "Alex@example.com", password: "longenough1" }, remoteAddress: "10.5.0.3", headers: { "user-agent": UA_WIN } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RegisterResponse;
    laptop = body.token;
    expect(laptop).not.toBe(phone);
    expect(body.user.id).toBe(alexId);

    expect((await me(laptop)).user.email).toBe("alex@example.com");
    const decks = (await ctx.app.inject({ method: "GET", url: "/api/decks", headers: auth(laptop) })).json() as { decks: Array<{ name: string }> };
    expect(decks.decks.map((d) => d.name)).toEqual(["Phone deck"]);

    const list = (await ctx.app.inject({ method: "GET", url: "/api/me/sessions", headers: auth(laptop) })).json() as { sessions: SessionInfo[] };
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.find((s) => s.current)?.device).toBe("Windows / Chrome");
    expect(list.sessions.find((s) => !s.current)?.device).toBe("iPhone / Safari");
  });

  it("signs out one device, then everywhere", async () => {
    const list = (await ctx.app.inject({ method: "GET", url: "/api/me/sessions", headers: auth(laptop) })).json() as { sessions: SessionInfo[] };
    const phoneSession = list.sessions.find((s) => !s.current)!;

    // Blair cannot delete Alex's session.
    const blair = await register("Blair2", "10.5.0.4");
    const forbidden = await ctx.app.inject({ method: "DELETE", url: `/api/me/sessions/${phoneSession.id}`, headers: auth(blair.token) });
    expect(forbidden.statusCode).toBe(404);

    const gone = await ctx.app.inject({ method: "DELETE", url: `/api/me/sessions/${phoneSession.id}`, headers: auth(laptop) });
    expect(gone.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(phone) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(laptop) })).statusCode).toBe(200);

    // Sign in again on the phone, then sign out everywhere from it.
    const back = (await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.5.0.1", headers: { "user-agent": UA_IPHONE } })).json() as RegisterResponse;
    phone = back.token;
    const all = await ctx.app.inject({ method: "DELETE", url: "/api/me/sessions", headers: auth(phone) });
    expect(all.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(phone) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(laptop) })).statusCode).toBe(401);

    laptop = (await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.5.0.3", headers: { "user-agent": UA_WIN } })).json<RegisterResponse>().token;
  });

  it("changes the password and drops every other session", async () => {
    phone = (await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.5.0.1" })).json<RegisterResponse>().token;
    const wrong = await ctx.app.inject({ method: "POST", url: "/api/auth/password", headers: auth(laptop), payload: { currentPassword: "nope-nope-nope", newPassword: "evenlonger22" }, remoteAddress: "10.5.0.3" });
    expect(wrong.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: "POST", url: "/api/auth/password", headers: auth(laptop), payload: { currentPassword: "longenough1", newPassword: "evenlonger22" }, remoteAddress: "10.5.0.3" });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(laptop) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/api/me", headers: auth(phone) })).statusCode).toBe(401);
    const old = await ctx.app.inject({ method: "POST", url: "/api/auth/signin", payload: { email: "alex@example.com", password: "longenough1" }, remoteAddress: "10.5.0.1" });
    expect(old.statusCode).toBe(401);
  });

  it("grants the owner flag only for the exact claim code, on an account, and guards owner routes", async () => {
    const guardBefore = await ctx.app.inject({ method: "GET", url: "/api/test/owner-only", headers: auth(laptop) });
    expect(guardBefore.statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "GET", url: "/api/test/owner-only" })).statusCode).toBe(401);

    // A device-only profile cannot claim, even with the right code.
    const casey = await register("Casey", "10.5.0.5");
    const noAccount = await ctx.app.inject({ method: "POST", url: "/api/me/owner-claim", headers: auth(casey.token), payload: { code: "correct-horse-battery-staple" }, remoteAddress: "10.5.0.5" });
    expect(noAccount.statusCode).toBe(409);
    expect((await me(casey.token)).user.isOwner).toBe(false);

    const wrong = await ctx.app.inject({ method: "POST", url: "/api/me/owner-claim", headers: auth(laptop), payload: { code: "correct-horse-battery-stapl" }, remoteAddress: "10.5.0.3" });
    expect(wrong.statusCode).toBe(403);
    const empty = await ctx.app.inject({ method: "POST", url: "/api/me/owner-claim", headers: auth(laptop), payload: {}, remoteAddress: "10.5.0.3" });
    expect(empty.statusCode).toBe(403);
    expect((await me(laptop)).user.isOwner).toBe(false);

    const right = await ctx.app.inject({ method: "POST", url: "/api/me/owner-claim", headers: auth(laptop), payload: { code: " correct-horse-battery-staple " }, remoteAddress: "10.5.0.3" });
    expect(right.statusCode).toBe(200);
    expect((right.json() as { user: User }).user.isOwner).toBe(true);
    expect((await me(laptop)).user.isOwner).toBe(true);

    const guardAfter = await ctx.app.inject({ method: "GET", url: "/api/test/owner-only", headers: auth(laptop) });
    expect(guardAfter.statusCode).toBe(200);
    expect(guardAfter.json()).toEqual({ secret: 42 });
  });

  it("rate-limits owner claims per client", async () => {
    const casey = await register("Dana", "10.5.0.6");
    await ctx.app.inject({ method: "POST", url: "/api/auth/signup", headers: auth(casey.token), payload: { email: "dana@example.com", password: "longenough1" }, remoteAddress: "10.5.0.6" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await ctx.app.inject({ method: "POST", url: "/api/me/owner-claim", headers: auth(casey.token), payload: { code: `guess-${i}` }, remoteAddress: "10.5.0.6" });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect((await me(casey.token)).user.isOwner).toBe(false);
    // The real owner is still the owner.
    expect((await me(laptop)).user.isOwner).toBe(true);
  });
});
