import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { gzipSync } from "node:zlib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-snapshots-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { decisionSnapshots } = await import("../db/schema.js");
const { buildSnapshot } = await import("./snapshots.js");

const card = (id: number, name: string | undefined, extra: Record<string, unknown> = {}) => ({ id, zone: "x", controller: 1, owner: 1, tapped: false, faceDown: false, token: false, ...(name ? { name } : {}), ...extra });

describe("decision snapshots", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp({ logger: false, idleSweep: false });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it("keeps only the seat's own hand; other hands, libraries and face-down cards stay hidden", () => {
    const raw = {
      prompt: "choose",
      title: "Choose a card",
      options: [{ index: 0, name: "Opt A" }, { index: 1, name: "Opt B" }],
      view: {
        turn: 2, round: 1, phase: "MAIN1", activePlayer: 1, viewer: 1, players: [
          { id: 1, seat: 0, name: "Me", isYou: true, life: 40, poison: 0, lost: false, handCount: 1, libraryCount: 98, landsPlayedThisTurn: 1, commanderDamage: {}, hand: [card(1, "My Card")], battlefield: [card(2, "Sol Ring", { tapped: true })], graveyard: [], exile: [], command: [] },
          { id: 2, seat: 1, name: "Them", isYou: false, life: 40, poison: 0, lost: false, handCount: 3, libraryCount: 97, landsPlayedThisTurn: 0, commanderDamage: {}, hand: [card(3, "Their Secret")], library: [card(4, "Library Secret")], battlefield: [], graveyard: [card(5, "Public Grave")], exile: [card(6, "Morph Secret", { faceDown: true })], command: [] },
        ], stack: [], combat: null,
      },
    };
    const s = buildSnapshot(raw, { option: 1 })!;
    expect(s.me.hand).toEqual(["My Card"]);
    expect(s.answer.chosen).toEqual(["Opt B"]);
    expect(s.players[0]!.battlefield).toEqual([{ n: "Sol Ring", t: 1 }]);
    expect(s.players[1]).toMatchObject({ handCount: 3, libraryCount: 97, graveyard: ["Public Grave"], exile: ["face-down card"] });
    expect(JSON.stringify(s)).not.toMatch(/Their Secret|Library Secret|Morph Secret/);
  });

  it("deletes snapshots older than 90 days", () => {
    const now = Date.now();
    const old = new Date(now - 91 * 86_400_000).toISOString();
    const fresh = new Date(now - 10 * 86_400_000).toISOString();
    const data = gzipSync("{}");
    for (const createdAt of [old, old, fresh]) ctx.handle.db.insert(decisionSnapshots).values({ roomId: "r", seat: 0, userId: "u", seq: 1, turn: 1, promptKind: "priority", createdAt, data }).run();
    expect(ctx.roomsManager.decisions!.cleanup(now)).toBe(2);
    expect(ctx.handle.db.select().from(decisionSnapshots).all()).toHaveLength(1);
  });
});
