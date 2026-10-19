import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-backfill-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

/** A database as the server left it before deck statistics (migrations up to 0010) with three rooms. */
function seedBeforeStats(file: string): void {
  const dir = path.join(tmp, "before-stats");
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const keep = journal.entries.filter((e) => e.idx <= 10);
  fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: keep }));
  for (const e of keep) fs.copyFileSync(path.join(migrationsDir, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  const sqlite = new Database(file);
  migrate(drizzle(sqlite), { migrationsFolder: dir });
  const now = "2026-10-10T00:00:00.000Z";
  sqlite.prepare("INSERT INTO users (id, display_name, avatar, color, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run("u1", "Old Timer", "owl", "jade", now, now);
  sqlite.prepare("INSERT INTO users (id, display_name, avatar, color, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)").run("u2", "Old Friend", "fox", "ruby", now, now);
  const room = sqlite.prepare("INSERT INTO rooms (id, code, host_user_id, status, seed, engine, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  room.run("r-ended", "AAAAAA", "u1", "ended", "s1", 1, now, now);
  room.run("r-playing", "BBBBBB", "u1", "playing", "s2", 1, now, now);
  room.run("r-lobby", "CCCCCC", "u1", "lobby", "s3", 1, now, now);
  const member = sqlite.prepare("INSERT INTO room_members (room_id, user_id, role, seat, joined_at) VALUES (?, ?, ?, ?, ?)");
  for (const r of ["r-ended", "r-playing"]) {
    member.run(r, "u1", "player", 0, now);
    member.run(r, "u2", "player", 1, now);
  }
  sqlite.close();
}

describe("migration 0011: every game played before deck statistics is a test game", () => {
  const file = path.join(tmp, "before.db");
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    seedBeforeStats(file);
    ctx = await buildApp({ logger: false, dbFile: file, idleSweep: false });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("marks every existing room as a test game and records started games as never counted", () => {
    const rooms = ctx.handle.sqlite.prepare("SELECT code, test_game FROM rooms ORDER BY code").all() as Array<{ code: string; test_game: number }>;
    expect(rooms.map((r) => [r.code, r.test_game])).toEqual([["AAAAAA", 1], ["BBBBBB", 1], ["CCCCCC", 1]]);
    const games = ctx.handle.sqlite.prepare("SELECT room_code, test, counted, player_count, end_reason, ended_at FROM game_results ORDER BY room_code").all() as Array<Record<string, unknown>>;
    expect(games.map((g) => [g.room_code, g.test, g.counted, g.player_count])).toEqual([["AAAAAA", 1, 0, 2], ["BBBBBB", 1, 0, 2]]);
    expect(games[0]!.ended_at).not.toBeNull();
    expect(games[1]!.ended_at).toBeNull();
    // a backfilled game that later finishes stays a test game: still not counted
    ctx.roomsManager.results!.recordFinish("r-playing", { winnerSeat: 0, endReason: "AllOpponentsLost", turns: 3, results: [] }, null);
    // (no seats were frozen for it, and it was already marked test)
    const after = ctx.handle.sqlite.prepare("SELECT counted, test FROM game_results WHERE id = 'r-playing'").get() as { counted: number; test: number };
    expect(after).toEqual({ counted: 0, test: 1 });
  });
});
