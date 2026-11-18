import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-edhrec-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../../app.js");
const { EdhrecClient, EDHREC_USER_AGENT } = await import("./client.js");
const { libraryDecks, libraryDeckCards } = await import("../../db/schema.js");
const { averageDeck, atraxaGroups, commanderPage, fixtureFetch, listPage } = await import("./fixtures.js");
const { IDENTITIES } = await import("./identity.js");
const { DEFAULT_TARGETS, rulesFor, sanitizeTargets } = await import("./importer.js");
const fixture = fileURLToPath(new URL("../../scryfall/fixtures/cards.sample.json", import.meta.url));

describe("EDHREC client", () => {
  it("throttles, sends a named User-Agent, caches answers on disk (403 too) and backs off on 429", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-edhrec-cache-"));
    let n429 = 1;
    const agents: string[] = [];
    const fn = async (url: string, init: RequestInit): Promise<Response> => {
      agents.push(new Headers(init.headers).get("user-agent") ?? "");
      if (url.endsWith("commanders/week.json")) {
        if (n429-- > 0) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        return new Response(JSON.stringify(listPage([{ name: "A", slug: "a", numDecks: 5 }])), { status: 200 });
      }
      return new Response("<Error/>", { status: 403 });
    };
    const client = new EdhrecClient({ cacheDir, fetchImpl: fn, gapMs: 0, backoffMs: [0, 0] });
    expect(await client.get("commanders/week")).toMatchObject({ header: "Commanders" });
    expect(await client.get("commanders/week")).toMatchObject({ header: "Commanders" });
    expect(await client.get("commanders/nope")).toBeNull();
    expect(await client.get("commanders/nope")).toBeNull();
    expect(client.requests).toBe(3); // 429 + 200 + 403; the repeats came from the cache
    expect(client.cacheHits).toBe(2);
    expect(agents.every((a) => a === EDHREC_USER_AGENT && /CGwF/.test(a) && /@/.test(a))).toBe(true);
    expect(await client.get("commanders/week", { refresh: true })).not.toBeNull();
    expect(client.requests).toBe(4);
  });

  it("spaces requests by the configured gap", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-edhrec-cache-"));
    const at: number[] = [];
    const client = new EdhrecClient({ cacheDir, gapMs: 150, fetchImpl: async () => (at.push(Date.now()), new Response("{}", { status: 200 })) });
    await Promise.all([client.get("a"), client.get("b"), client.get("c")]);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(140);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(140);
  });
});

describe("EDHREC import into the deck library", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  const coverageCalls: string[][] = [];

  // Pool: three commanders in the week list. "Atraxa A" and "Atraxa B" are legal Atraxa lists
  // (different slugs), "Partners" names two commanders that are not partners (illegal), "Gone" has no page.
  const table: Record<string, unknown> = {
    "commanders/week": listPage([
      { name: "Atraxa A", slug: "atraxa-a", numDecks: 900 },
      { name: "Atraxa B", slug: "atraxa-b", numDecks: 800 },
      { name: "Atraxa, Praetors' Voice // Sol Ring", slug: "partners", numDecks: 700 },
      { name: "Gone", slug: "gone", numDecks: 600 },
    ]),
    "commanders/month": listPage([]),
    "commanders/year": listPage([]),
    "commanders/atraxa-a": commanderPage("Atraxa, Praetors' Voice", ["W", "U", "B", "G"], [1, 5, 500, 400, 0]),
    "commanders/atraxa-b": commanderPage("Atraxa, Praetors' Voice", ["W", "U", "B", "G"], [1, 5, 300, 450, 0]),
    "commanders/partners": commanderPage("Atraxa, Praetors' Voice // Sol Ring", ["W", "U", "B", "G"], [0, 0, 900, 0, 0]),
    "average-decks/atraxa-a/upgraded": averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups()),
    "average-decks/atraxa-a/optimized": averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups()),
    "average-decks/atraxa-b/upgraded": averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups()),
    "average-decks/atraxa-b/optimized": averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups()),
    "average-decks/partners/upgraded": averageDeck(["Atraxa, Praetors' Voice", "Sol Ring"], { Creature: [["Lotus Cobra", 1]], Land: [["Forest", 97]] }),
    // EDHREC averages sometimes leave slots empty: 97 cards (padded) and 94 (too short).
    "average-decks/short/upgraded": averageDeck(["Atraxa, Praetors' Voice"], { ...atraxaGroups(), Land: [["Forest", 88]] }),
    "average-decks/tooshort/upgraded": averageDeck(["Atraxa, Praetors' Voice"], { ...atraxaGroups(), Land: [["Forest", 85]] }),
  };
  for (const id of IDENTITIES) table[`commanders/${id.slug}`] = listPage([]);
  const fetcher = fixtureFetch(table);

  beforeAll(async () => {
    ctx = await buildApp({
      logger: false,
      edhrecFetch: fetcher.fn,
      edhrecCacheDir: path.join(tmp, "edhrec-cache"),
      edhrecGapMs: 0,
      edhrecCoverage: {
        async check(decks) {
          coverageCalls.push(decks.map((d) => d.deck.name));
          // Forge "cannot play" Scute Swarm in the Bracket 4 copies.
          return new Map(decks.map((d) => [d.key, { missing: /Optimized/.test(d.deck.name) ? ["Scute Swarm"] : [] }]));
        },
      },
      spellbookFetch: async () => new Response(JSON.stringify({ results: { included: [] } }), { status: 200 }),
    });
    await ctx.ingestor.run({ file: fixture });
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("maps a partner pair to two commander rows and refuses it as an illegal pair", async () => {
    const { parseAverageDeck } = await import("./parse.js");
    const deck = parseAverageDeck("partners", table["average-decks/partners/upgraded"])!;
    const r = ctx.edhrec.resolve(deck);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries.filter((e) => e.board === "commander")).toHaveLength(2);
    const ev = await ctx.edhrec.evaluate({ slug: "partners", name: "pair", identity: "WUBG", bracketCounts: { 1: 0, 2: 0, 3: 900, 4: 0, 5: 0 } }, 3);
    expect(ev.ok).toBe(false);
    if (!ev.ok) expect(ev.reason).toMatch(/not a legal Commander deck as averaged/);
  });

  it("fills up to four empty slots of a short average with the commander's basics, and refuses a shorter one", async () => {
    const cand = (slug: string) => ({ slug, name: slug, identity: "WUBG", bracketCounts: { 1: 0, 2: 0, 3: 100, 4: 0, 5: 0 } as const });
    const ok = await ctx.edhrec.evaluate(cand("short"), 3);
    expect(ok.ok).toBe(true);
    const bad = await ctx.edhrec.evaluate(cand("tooshort"), 3);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("the average deck has 94 cards, not 100");
  });

  it("imports the picks with name, source, URL, bracket, tags, primer; coverage decides agent eligibility", async () => {
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 1, 5: 0 } });
    expect(ctx.edhrec.state.error).toBeNull();
    const rows = ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.source, "edhrec")).all();
    expect(rows.map((r) => r.name).sort()).toEqual(["Atraxa, Praetors' Voice — Optimized (EDHREC average)", "Atraxa, Praetors' Voice — Upgraded (EDHREC average)"]);
    // Bracket 3 takes the most "upgraded" decks (atraxa-a, 500). Bracket 4's overlap cap is floor(1/3) = 0,
    // so it may not reuse atraxa-a and takes atraxa-b.
    const b3 = rows.find((r) => r.bracket === 3)!;
    expect(b3.sourceKey).toBe("edhrec:atraxa-a:upgraded");
    expect(b3.sourceUrl).toBe("https://edhrec.com/average-decks/atraxa-a/upgraded");
    expect(b3.agentEligible).toBe(true);
    const b4 = rows.find((r) => r.bracket === 4)!;
    expect(b4.sourceKey).toBe("edhrec:atraxa-b:optimized");
    expect(b4.agentEligible).toBe(false);
    expect((b4.importMeta as { coverage: { missing: string[] } }).coverage.missing).toEqual(["Scute Swarm"]);
    expect(b4.primer).toContain("## Win conditions");
    const count = ctx.handle.db.select().from(libraryDeckCards).where(eq(libraryDeckCards.libraryDeckId, b4.id)).all().reduce((n, c) => n + c.quantity, 0);
    expect(count).toBe(100);
    const summary = ctx.library.list({ source: "edhrec" });
    expect(summary).toHaveLength(2);
    expect(summary[0]!.importInfo).toMatchObject({ provider: "edhrec", coverageError: null });
    expect(ctx.edhrec.state).toMatchObject({ imported: 2, updated: 0, agentEligible: 1, selected: { 3: 1, 4: 1, 5: 0 } });
    const report = fs.readFileSync(ctx.edhrec.state.reportPath!, "utf8");
    expect(report).toContain("Average deck data from EDHREC");
    expect(report).toContain("Forge cannot play Scute Swarm");
    expect(report).toContain("Gone (gone): EDHREC has no commander page");
    expect(report).toMatch(/Atraxa, Praetors' Voice \/\/ Sol Ring: not a legal Commander deck/);
  });

  it("is idempotent: a rerun updates the same rows from the cache, keeps an owner-edited primer and makes no requests", async () => {
    const before = ctx.handle.db.select().from(libraryDecks).all().length;
    const edited = ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-a:upgraded")).get()!;
    ctx.library.patch(edited.id, { primer: "My own notes" });
    const callsBefore = fetcher.calls.length;
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 1, 5: 0 } });
    expect(ctx.edhrec.state).toMatchObject({ imported: 0, updated: 2, error: null });
    expect(ctx.handle.db.select().from(libraryDecks).all()).toHaveLength(before);
    expect(fetcher.calls.length).toBe(callsBefore);
    expect(ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.id, edited.id)).get()!.primer).toBe("My own notes");
    const other = ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-b:optimized")).get()!;
    expect(other.primer).toContain("## Archetype");
  });

  it("Bracket 2: imports EDHREC's \"core\" average, leaning away from commanders already taken at Brackets 3 and 4", async () => {
    // Both Atraxa slugs have a core average; atraxa-a has more core decks, but Bracket 3 took it and the
    // overlap cap for one Bracket 2 deck is floor(1/3) = 0, so Bracket 2 takes atraxa-c.
    table["commanders/week"] = listPage([
      { name: "Atraxa A", slug: "atraxa-a", numDecks: 900 },
      { name: "Atraxa B", slug: "atraxa-b", numDecks: 800 },
      { name: "Atraxa C", slug: "atraxa-c", numDecks: 100 },
    ]);
    table["commanders/atraxa-a"] = commanderPage("Atraxa, Praetors' Voice", ["W", "U", "B", "G"], [1, 300, 500, 400, 0]);
    table["commanders/atraxa-c"] = commanderPage("Atraxa, Praetors' Voice", ["W", "U", "B", "G"], [1, 60, 10, 10, 0]);
    table["average-decks/atraxa-a/core"] = averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups());
    table["average-decks/atraxa-c/core"] = averageDeck(["Atraxa, Praetors' Voice"], atraxaGroups());
    await ctx.edhrec.run({ targets: { 2: 1, 3: 1, 4: 1, 5: 0 }, refresh: true });
    expect(ctx.edhrec.state).toMatchObject({ error: null, selected: { 2: 1, 3: 1, 4: 1, 5: 0 } });
    const core = ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-c:core")).get()!;
    expect(core.name).toBe("Atraxa, Praetors' Voice — Core (EDHREC average)");
    expect(core.bracket).toBe(2);
    expect(core.sourceUrl).toBe("https://edhrec.com/average-decks/atraxa-c/core");
    expect((core.importMeta as { edhrecBracket: string }).edhrecBracket).toBe("core");
    expect(core.agentEligible).toBe(true);
    const report = fs.readFileSync(ctx.edhrec.state.reportPath!, "utf8");
    expect(report).toContain('## Bracket 2 (EDHREC "core"): 1 picked');
    expect(report).toContain("Bracket 2 commanders also picked at Bracket 3 or 4: 0.");
    expect(report.indexOf("## Bracket 2")).toBeLessThan(report.indexOf("## Bracket 3"));
  });

  it("a Bracket 2 deck the bracket rules rate higher is not dealt to bots, unless the owner switches it on", async () => {
    const key = "edhrec:atraxa-c:core";
    const row = () => ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, key)).get()!;
    const id = row().id;
    expect(row().agentEligible).toBe(true);
    // The fixture cards hold no Game Changer or combo, so the floor is set by hand: a two-card combo's 4.
    ctx.handle.db.update(libraryDecks).set({ bracketFloor: 4 }).where(eq(libraryDecks.id, id)).run();
    await ctx.edhrec.run({ recheckCoverage: true });
    expect(row().agentEligible).toBe(false);
    expect((row().importMeta as { botHold: string }).botHold).toContain("Bracket 4 or higher");
    expect(ctx.library.list({ source: "edhrec" }).find((d) => d.id === id)!.importInfo!.botHold).toContain("Bracket 4 or higher");
    const report = fs.readFileSync(ctx.edhrec.state.reportPath!, "utf8");
    expect(report).toContain("Atraxa, Praetors' Voice — Core (EDHREC average): held back from bots");
    // The Bracket 3 deck with the same cards is untouched.
    expect(ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-a:upgraded")).get()!.agentEligible).toBe(true);
    // The owner's switch wins and survives later checks.
    ctx.library.patch(id, { agentEligible: true });
    await ctx.edhrec.run({ recheckCoverage: true });
    expect(row().agentEligible).toBe(true);
    // Filed under a higher bracket (and back in the check's hands) the hold is gone.
    ctx.handle.db.update(libraryDecks).set({ bracket: 4, agentEligible: false, importMeta: { ...(row().importMeta as object), eligibleBy: null } }).where(eq(libraryDecks.id, id)).run();
    await ctx.edhrec.run({ recheckCoverage: true });
    expect(row().agentEligible).toBe(true);
    expect((row().importMeta as { botHold: string | null }).botHold).toBeNull();
  });

  it("a re-import remembers that the owner switched a deck off for bots", async () => {
    const key = "edhrec:atraxa-a:upgraded";
    const row = () => ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, key)).get()!;
    ctx.library.patch(row().id, { agentEligible: false });
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 1, 5: 0 } });
    expect(ctx.edhrec.state.error).toBeNull();
    expect(row().agentEligible).toBe(false);
    expect((row().importMeta as { eligibleBy: string }).eligibleBy).toBe("owner");
    ctx.library.patch(row().id, { agentEligible: true });
  });

  it("Bracket 2 passes over a deck that plays higher and takes the next one, so the target counts decks bots are dealt", async () => {
    // "Atraxa D" has the most core decks. Its average is the one list without Rancor, which this test's
    // analyzer rates at Bracket 4 (the fixture cards hold no Game Changer or combo of their own).
    table["commanders/week"] = listPage([
      { name: "Atraxa A", slug: "atraxa-a", numDecks: 900 },
      { name: "Atraxa B", slug: "atraxa-b", numDecks: 800 },
      { name: "Atraxa C", slug: "atraxa-c", numDecks: 100 },
      { name: "Atraxa D", slug: "atraxa-d", numDecks: 90 },
    ]);
    table["commanders/atraxa-d"] = commanderPage("Atraxa, Praetors' Voice", ["W", "U", "B", "G"], [1, 500, 0, 0, 0]);
    const groups = atraxaGroups();
    table["average-decks/atraxa-d/core"] = averageDeck(["Atraxa, Praetors' Voice"], { ...groups, Enchantment: [["Glorious Anthem", 1]], Land: [["Forest", 92]] });
    const real = ctx.analyzer.analyze.bind(ctx.analyzer);
    const spy = vi.spyOn(ctx.analyzer, "analyze").mockImplementation(async (cards, opts) => {
      const r = await real(cards, opts);
      if (cards.some((c) => c.name === "Rancor")) return r;
      return { ...r, analysis: { ...r.analysis, floor: 4, reasons: [...r.analysis.reasons, { bracket: 4, text: "A two-card combo." }] } } as typeof r;
    });
    try {
      await ctx.edhrec.run({ targets: { 2: 1, 3: 1, 4: 1, 5: 0 }, refresh: true });
    } finally {
      spy.mockRestore();
    }
    expect(ctx.edhrec.state).toMatchObject({ error: null, selected: { 2: 1, 3: 1, 4: 1, 5: 0 } });
    expect(ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-d:core")).get()).toBeUndefined();
    const next = ctx.handle.db.select().from(libraryDecks).where(eq(libraryDecks.sourceKey, "edhrec:atraxa-c:core")).get()!;
    expect(next).toMatchObject({ bracket: 2, agentEligible: true });
    const report = fs.readFileSync(ctx.edhrec.state.reportPath!, "utf8");
    expect(report).toContain("passed over, bots would not be dealt it: the bracket rules put it at Bracket 4 or higher (EDHREC says 2): A two-card combo.");
    // Brackets 3 and 4 keep a deck the rules rate higher: the rule is for Bracket 2 alone.
    const up = await ctx.edhrec.evaluate({ slug: "atraxa-a", name: "a", identity: "WUBG", bracketCounts: { 1: 0, 2: 0, 3: 500, 4: 0, 5: 0 } }, 3);
    expect(up.ok).toBe(true);
  });

  it("scales the diversity caps with a larger target and reads targets from a request safely", () => {
    expect(rulesFor(3, 75)).toMatchObject({ target: 75, identityCap: 4, archetypeCap: 12, winConMin: 3 });
    expect(rulesFor(3, 150)).toMatchObject({ target: 150, identityCap: 8, archetypeCap: 24, winConMin: 6, minDecks: 20 });
    expect(rulesFor(2, 150)).toMatchObject({ bracket: 2, target: 150, identityCap: 8, coverage: "identity" });
    expect(rulesFor(4, 10)).toMatchObject({ target: 10, identityCap: 4, archetypeCap: 12 });
    expect(rulesFor(5, 25)).toMatchObject({ target: 25, identityCap: 3, minDecks: 50, coverage: "group" });
    expect(DEFAULT_TARGETS).toEqual({ 2: 150, 3: 150, 4: 150, 5: 25 });
    expect(sanitizeTargets({ "2": 150, "3": 0, "4": 9999, "5": "x", "6": 10 })).toEqual({ 2: 150, 3: 0 });
    expect(sanitizeTargets(null)).toEqual({});
  });

  it("fetches a cached answer again once it is older than the run's maximum age", async () => {
    const before = fetcher.calls.length;
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 0, 5: 0 }, dryRun: true });
    expect(fetcher.calls.length).toBe(before); // everything is fresh in the cache
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const dir = path.join(tmp, "edhrec-cache");
    const age = (d: string) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) age(p);
        else {
          const cached = JSON.parse(fs.readFileSync(p, "utf8")) as { fetchedAt?: string };
          cached.fetchedAt = old.toISOString();
          fs.writeFileSync(p, JSON.stringify(cached));
        }
      }
    };
    age(dir);
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 0, 5: 0 }, dryRun: true });
    expect(fetcher.calls.length).toBeGreaterThan(before);
    const refetched = fetcher.calls.length;
    await ctx.edhrec.run({ targets: { 2: 0, 3: 1, 4: 0, 5: 0 }, dryRun: true, maxAgeDays: 0 });
    expect(fetcher.calls.length).toBe(refetched);
  });

  it("without a rules engine nothing becomes agent-eligible, and the machine routes stay closed to outsiders", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/admin/import-edhrec", remoteAddress: "10.9.9.9", payload: {} });
    expect(res.statusCode).toBe(403);
    const status = await ctx.app.inject({ method: "GET", url: "/api/admin/import-edhrec" });
    expect(status.json().state.phase).toBe("done");
    expect(coverageCalls.length).toBeGreaterThanOrEqual(2);
  });
});
