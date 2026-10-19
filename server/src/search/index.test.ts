import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-index-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { cards } = await import("../db/schema.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

describe("name index collisions", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    ctx = await buildApp({ logger: false });
    await ctx.ingestor.run({ file: fixture });
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps the real card when a playtest card's name differs only by punctuation (Rampant Growth vs Rampant, Growth)", () => {
    const real = ctx.handle.db.select().from(cards).all().find((c) => c.name === "Sol Ring" && c.inBooster)!;
    // A not-in-booster playtest card whose normalised name collides with Sol Ring's.
    ctx.handle.db.insert(cards).values({ ...real, id: "playtest-sol-ring", oracleId: "playtest-oracle", name: "Sol, Ring", set: "unk", setName: "Unknown Event", setType: "funny", isRegular: false, treatmentCount: 1, collectorNumber: "UG1", inBooster: false, releasedAt: "2030-01-01" }).run();
    ctx.index.build();
    expect(ctx.index.exact("sol ring")?.name).toBe("Sol Ring");
  });
});
