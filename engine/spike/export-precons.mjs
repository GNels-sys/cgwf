#!/usr/bin/env node
// Export four Commander precon decklists from MTGJSON (the same source CGwF's
// library import uses, see server/src/library/precons.ts) into the JSON shape
// the engine spike loads: one file per deck under engine/spike/decks/.
//
//   node engine/spike/export-precons.mjs [productCode]   (default BLC = Bloomburrow Commander)
//
// Output shape (also what Stage 1's CGwF -> engine deck conversion will send):
//   { name, code, commanders: [card], main: [card] }
//   card = { name, setCode, number, scryfallId, count }
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "decks");
const product = (process.argv[2] ?? "BLC").toUpperCase();
const UA = "CGwF-engine-spike/0.1 (private card table; dev tooling)";

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!res.ok) throw new Error(`MTGJSON ${res.status} for ${url}`);
  return res.json();
}

const list = await getJson("https://mtgjson.com/api/v5/DeckList.json");
const decks = list.data.filter((d) => d.type === "Commander Deck" && d.code === product);
if (decks.length === 0) throw new Error(`no Commander Deck rows for product ${product}`);
await mkdir(outDir, { recursive: true });

const toCard = (c) => ({
  name: c.name,
  setCode: c.setCode ?? null,
  number: c.number ?? null,
  scryfallId: c.identifiers?.scryfallId ?? null,
  count: c.count ?? 1,
});

const written = [];
for (const d of decks.slice(0, 4)) {
  await new Promise((r) => setTimeout(r, 250));
  const full = (await getJson(`https://mtgjson.com/api/v5/decks/${encodeURIComponent(d.fileName)}.json`)).data;
  const out = {
    name: full.name,
    code: full.code,
    commanders: (full.commander ?? []).map(toCard),
    main: (full.mainBoard ?? []).map(toCard),
  };
  const file = join(outDir, `${d.fileName}.json`);
  await writeFile(file, JSON.stringify(out, null, 2) + "\n");
  const n = out.main.reduce((a, c) => a + c.count, 0) + out.commanders.reduce((a, c) => a + c.count, 0);
  written.push(`${full.name}: ${out.commanders.map((c) => c.name).join(" / ")} (${n} cards)`);
}
console.log(written.join("\n"));
