import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { SearchResponse, CardResponse, StatusResponse } from "@cgwf/shared";

// Point the server at a throwaway data dir before config loads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-test-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("./app.js");
const fixture = fileURLToPath(new URL("./scryfall/fixtures/cards.sample.json", import.meta.url));

describe("API over an ingested fixture", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    await ctx.ingestor.run({ file: fixture });
    expect(ctx.ingestor.state.phase).toBe("done");
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("imports English cards only and reports status", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/status" });
    const body = res.json() as StatusResponse;
    expect(body.cardCount).toBe(17);
    expect(body.lastIngestAt).not.toBeNull();
  });

  it("finds exact, prefix and fuzzy names, preferring the booster printing", async () => {
    const exact = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=Sol%20Ring" })).json() as SearchResponse;
    expect(exact.results[0]?.name).toBe("Sol Ring");
    expect(exact.results[0]?.set).toBe("cmr");
    expect(exact.results).toHaveLength(1); // one entry per card, not per printing

    const fuzzy = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=sol%20rign" })).json() as SearchResponse;
    expect(fuzzy.results[0]?.name).toBe("Sol Ring");

    const prefix = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=lightnin" })).json() as SearchResponse;
    expect(prefix.results[0]?.name).toBe("Lightning Bolt");
  });

  it("finds split cards by either half", async () => {
    const ice = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=ice" })).json() as SearchResponse;
    expect(ice.results.map((r) => r.name)).toContain("Fire // Ice");
  });

  it("keeps tokens out of card search unless asked", async () => {
    const plain = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=treasure" })).json() as SearchResponse;
    expect(plain.results.find((r) => r.name === "Treasure")).toBeUndefined();
    const tokens = (await ctx.app.inject({ method: "GET", url: "/api/cards/search?q=treasure&tokens=1" })).json() as SearchResponse;
    expect(tokens.results[0]?.name).toBe("Treasure");
    expect(tokens.results[0]?.isToken).toBe(true);
  });

  it("returns a full printing with faces", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/cards/a1b2c3d4-0000-4000-8000-000000000003" });
    const body = res.json() as CardResponse;
    expect(body.card.layout).toBe("transform");
    expect(body.card.faces[1]?.name).toBe("Insectile Aberration");
    expect(body.card.keywords).toContain("Transform");
  });

  it("rejects admin ingest without loopback or token", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/admin/ingest", remoteAddress: "10.0.0.9" });
    expect(res.statusCode).toBe(403);
  });

  it("404s unknown images and never proxies arbitrary ids", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/img/normal/not-a-uuid.jpg" });
    expect(res.statusCode).toBe(404);
  });
});
