import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineDeck, LibraryListResponse, RegisterResponse } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-coverage-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards, libraryDecks, users } = await import("../db/schema.js");
const { MTGJSON_DECK_LIST_URL } = await import("./precons.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

const ATRAXA = "Atraxa, Praetors' Voice";
const SPELLS = ["Sol Ring", "Arcane Signet", "Lightning Greaves", "Lotus Cobra", "Tireless Tracker", "Glorious Anthem", "Rancor"];

/** A fixture "engine": Forge cannot play Scute Swarm; an "offline" flag makes every check fail to run. */
const engine = { offline: false, unknown: new Set(["Scute Swarm"]), games: 0 };
const fakeChecker = {
  async check(decks: Array<{ key: string; deck: EngineDeck }>) {
    engine.games += Math.ceil(decks.length / 4);
    return new Map(
      decks.map((d) => {
        if (engine.offline) return [d.key, { missing: null, error: "the rules engine is not connected" }];
        const names = [...d.deck.commanders, ...d.deck.main].map((c) => c.name);
        return [d.key, { missing: names.filter((n) => engine.unknown.has(n)) }];
      }),
    );
  },
};

/** MTGJSON precon files: a legal 100-card Atraxa deck, the same with Scute Swarm, and a red card in Atraxa. */
const mtgCard = (name: string, count = 1) => ({ name, count });
const precon = (name: string, extra: string | null) => ({
  data: {
    code: "TST",
    name,
    commander: [mtgCard(ATRAXA)],
    mainBoard: [...SPELLS.map((n) => mtgCard(n)), ...(extra ? [mtgCard(extra)] : [mtgCard("Forest")]), mtgCard("Forest", 91)],
    sideBoard: [],
  },
});
const LIST = {
  data: [
    { code: "TST", fileName: "Clean_TST", name: "Clean Precon", releaseDate: "2024-01-01", type: "Commander Deck" },
    { code: "TST", fileName: "Scute_TST", name: "Scute Precon", releaseDate: "2024-02-01", type: "Commander Deck" },
    { code: "TST", fileName: "Red_TST", name: "Red Card Precon", releaseDate: "2024-03-01", type: "Commander Deck" },
  ],
};
const FILES: Record<string, unknown> = {
  Clean_TST: precon("Clean Precon", null),
  Scute_TST: precon("Scute Precon", "Scute Swarm"),
  Red_TST: precon("Red Card Precon", "Lightning Bolt"),
};
const mtgjson = async (url: string): Promise<Response> => {
  if (url === MTGJSON_DECK_LIST_URL) return new Response(JSON.stringify(LIST), { status: 200 });
  const m = url.match(/\/decks\/([^/]+)\.json$/);
  const file = m ? FILES[decodeURIComponent(m[1]!)] : undefined;
  return file ? new Response(JSON.stringify(file), { status: 200 }) : new Response("missing", { status: 404 });
};

describe("library-wide rules-engine check", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let ownerToken = "";
  let otherToken = "";
  const owner = () => ({ authorization: `Bearer ${ownerToken}` });

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, mtgjsonFetch: mtgjson, spellbookFetch: mtgjson, edhrecCoverage: fakeChecker });
    await ctx.ingestor.run({ file: fixture });
    const reg = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Owner", avatar: "dragon", color: "gold" } });
    const me = reg.json() as RegisterResponse;
    ownerToken = me.token;
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, me.user.id)).run();
    const reg2 = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: "Guest", avatar: "owl", color: "jade" }, remoteAddress: "10.5.5.5" });
    otherToken = (reg2.json() as RegisterResponse).token;
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const byName = (name: string) => ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.name, name)).get()!;

  it("a precon import checks the decks it adds and switches on only the ones Forge can play that are legal", async () => {
    await ctx.precons.run({ combos: false });
    expect(ctx.precons.state.imported).toBe(3);
    expect(byName("Clean Precon").agentEligible).toBe(true);
    expect(byName("Clean Precon").importMeta).toMatchObject({ eligibleBy: "coverage", coverage: { missing: [] }, problems: [] });
    expect(byName("Scute Precon").agentEligible).toBe(false);
    expect(byName("Scute Precon").importMeta).toMatchObject({ coverage: { missing: ["Scute Swarm"] } });
    expect(byName("Red Card Precon").agentEligible).toBe(false);
    expect((byName("Red Card Precon").importMeta as { problems: string[] }).problems.join(" ")).toMatch(/colour|color/i);
    expect(ctx.precons.state.errors.join("\n")).toMatch(/Scute Precon: not for bots \(Forge cannot play Scute Swarm\)/);
  });

  it("never overrides the owner: hand-enabled failing decks stay on, hand-disabled clean decks stay off", async () => {
    // The owner switches Scute Precon on and Clean Precon off from the Library page.
    for (const [name, on] of [["Scute Precon", true], ["Clean Precon", false]] as const) {
      const r = await ctx.app.inject({ method: "PATCH", url: `/api/library/${byName(name).id}`, headers: owner(), payload: { agentEligible: on } });
      expect(r.statusCode).toBe(200);
    }
    const report = await ctx.libraryCoverage.check({ source: "precon", enable: true });
    expect(report).not.toBeNull();
    expect(byName("Scute Precon").agentEligible).toBe(true);
    expect(byName("Clean Precon").agentEligible).toBe(false);
    const outcome = (n: string) => report!.lines.find((l) => l.name === n)!.outcome;
    expect(outcome("Scute Precon")).toBe("kept-by-owner");
    expect(outcome("Clean Precon")).toBe("unchanged");
    expect(ctx.libraryCoverage.state).toMatchObject({ checked: 3, keptByOwner: 1, excluded: 2, running: false, phase: "done" });
    const text = fs.readFileSync(ctx.libraryCoverage.state.reportPath!, "utf8");
    expect(text).toMatch(/Scute Precon \(B2, precon\): Forge cannot play Scute Swarm \(left on: the owner switched it on by hand\)/);
    expect(text).toMatch(/\| 2 \| \d+ \| \d+ \| 3 \|/);
  });

  it("switches off a deck the check itself switched on when Forge later cannot play it; an offline engine changes nothing", async () => {
    const extra = await ctx.library.create({ name: "Extra Precon", source: "precon", sourceKey: "mtgjson:Extra", setCode: "TST", setName: null, releaseDate: null, bracket: 2, entries: ctx.library.entries(byName("Clean Precon").id).map(({ cardId, quantity, board }) => ({ cardId, quantity, board })) }, { combos: "skip" });
    await ctx.libraryCoverage.check({ ids: [extra.id], enable: true });
    expect(byName("Extra Precon").agentEligible).toBe(true);
    engine.offline = true;
    await ctx.libraryCoverage.check({ ids: [extra.id], enable: true });
    expect(byName("Extra Precon").agentEligible).toBe(true);
    expect(ctx.libraryCoverage.state.unchecked).toBe(1);
    engine.offline = false;
    engine.unknown.add("Rancor");
    await ctx.libraryCoverage.check({ ids: [extra.id], enable: true });
    expect(byName("Extra Precon").agentEligible).toBe(false);
    engine.unknown.delete("Rancor");
  });

  it("report-only runs record the result but switch nothing on", async () => {
    const before = ctx.library.bracketCounts();
    const extra = byName("Extra Precon");
    await ctx.libraryCoverage.check({ ids: [extra.id], enable: false });
    expect(byName("Extra Precon").agentEligible).toBe(false);
    expect(ctx.library.bracketCounts()).toEqual(before);
  });

  it("routes: the machine and the owner may start it, nobody else; the library list carries per-bracket counts", async () => {
    expect((await ctx.app.inject({ method: "POST", url: "/api/admin/library-coverage", payload: {}, remoteAddress: "10.9.9.9" })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: "/api/library/coverage", headers: { authorization: `Bearer ${otherToken}` }, payload: {} })).statusCode).toBe(403);
    const started = await ctx.app.inject({ method: "POST", url: "/api/admin/library-coverage", payload: { source: "precon" } });
    expect(started.statusCode).toBe(202);
    for (let i = 0; i < 50 && ctx.libraryCoverage.state.running; i++) await new Promise((r) => setTimeout(r, 20));
    const state = await ctx.app.inject({ method: "GET", url: "/api/library/coverage", headers: owner() });
    expect(state.json()).toMatchObject({ state: { running: false, phase: "done", checked: 4 } });
    const list = (await ctx.app.inject({ method: "GET", url: "/api/library", headers: owner() })).json() as LibraryListResponse;
    const eligibleB2 = ctx.handle.db.select().from(libraryDecks).all().filter((d) => d.bracket === 2 && d.agentEligible).length;
    expect(list.bracketCounts[2]).toEqual({ eligible: eligibleB2, total: 4 });
    expect(list.decks.find((d) => d.name === "Scute Precon")!.engineCheck).toMatchObject({ missing: ["Scute Swarm"], eligibleBy: "owner" });
    expect(list.decks.find((d) => d.name === "Scute Precon")!.importInfo).toBeNull();
    // Unused import guard: the fixture really has the printing rows these decks reference.
    expect(ctx.handle.db.select().from(cards).where(eq(cards.name, "Scute Swarm")).get()).toBeTruthy();
  });
});
