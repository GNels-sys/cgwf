import { describe, expect, it } from "vitest";
import type { ArchetypeTag } from "@cgwf/shared";
import { IDENTITIES, identityKey } from "./identity.js";
import { averageDeckText, parseAverageDeck, parseCommanderPage, parseList, totalCards } from "./parse.js";
import { diversitySummary, rankCandidates, selectBracket, type Candidate, type Evaluation, type SelectionRules } from "./select.js";
import { averageDeck, commanderPage, listPage } from "./fixtures.js";
import type { WinCondition } from "./wincon.js";

const ARCHS: ArchetypeTag[] = ["tokens", "counters", "aristocrats", "voltron", "spellslinger", "reanimator", "lands", "artifacts", "enchantress", "control", "combo", "aggro"];
const WINS: WinCondition[] = ["combat", "combo", "drain", "alternate", "control"];

/** n candidates per identity, deck counts falling with the index; evaluation from a table. */
function pool(perIdentity: number, decks = (i: number) => 1000 - i) {
  const candidates: Candidate[] = [];
  const evals = new Map<string, Evaluation>();
  let n = 0;
  for (const id of IDENTITIES) {
    for (let k = 0; k < perIdentity; k++) {
      const slug = `${id.slug}-${k}`;
      const count = decks(n);
      candidates.push({ slug, name: `${id.label} ${k}`, identity: id.key, bracketCounts: { 1: 0, 2: 0, 3: count, 4: count, 5: count } });
      evals.set(slug, { ok: true, primary: ARCHS[n % ARCHS.length]!, winCondition: WINS[n % WINS.length]! });
      n++;
    }
  }
  return { candidates, evaluate: async (c: Candidate) => evals.get(c.slug)!, evals };
}

const B3: SelectionRules = { bracket: 3, target: 75, identityCap: 4, archetypeCap: 12, minArchetypes: 10, minDecks: 20, coverage: "identity", winConMin: 3 };

describe("EDHREC parsers", () => {
  it("reads the ranked lists, commander pages and average decks (partners as two commanders)", () => {
    expect(parseList(listPage([{ name: "Krenko, Mob Boss", slug: "krenko-mob-boss", numDecks: 9 }]))).toEqual([{ name: "Krenko, Mob Boss", slug: "krenko-mob-boss", numDecks: 9 }]);
    expect(parseList({ nonsense: true })).toEqual([]);
    const page = parseCommanderPage("thrasios-triton-hero-tymna-the-weaver", commanderPage("Thrasios, Triton Hero // Tymna the Weaver", ["W", "U", "G", "B"], [1, 2, 3, 40, 900]))!;
    expect(page).toMatchObject({ identity: "WUBG", bracketCounts: { 3: 3, 4: 40, 5: 900 } });
    expect(parseCommanderPage("x", { container: {} })).toBeNull();
    const deck = parseAverageDeck("p", averageDeck(["Thrasios, Triton Hero", "Tymna the Weaver"], { Creature: [["Dark Confidant", 1]], Land: [["Island", 3]] }, [{ u: "abc", q: 1, c: "c" }]))!;
    expect(deck.commanders).toEqual(["Thrasios, Triton Hero", "Tymna the Weaver"]);
    expect(totalCards(deck)).toBe(6);
    expect(deck.scryfallIds).toEqual([{ id: "abc", quantity: 1, commander: true }]);
    expect(averageDeckText(deck)).toBe("Commander\n1 Thrasios, Triton Hero\n1 Tymna the Weaver\n\nDeck\n1 Dark Confidant\n3 Island\n");
    expect(parseAverageDeck("p", { deck: { commander: [] } })).toBeNull();
  });

  it("knows all 32 identities with unique slugs and WUBRG keys", () => {
    expect(IDENTITIES).toHaveLength(32);
    expect(new Set(IDENTITIES.map((i) => i.slug)).size).toBe(32);
    expect(new Set(IDENTITIES.map((i) => i.key)).size).toBe(32);
    expect(identityKey(["G", "U"])).toBe("UG");
    expect(identityKey("gw")).toBe("WG");
  });
});

describe("selection per bracket", () => {
  it("ranks by the bracket's deck count and drops commanders under the minimum", () => {
    const c = (slug: string, b3: number, b5: number): Candidate => ({ slug, name: slug, identity: "R", bracketCounts: { 1: 0, 2: 0, 3: b3, 4: 0, 5: b5 } });
    const ranked = rankCandidates([c("a", 10, 900), c("b", 500, 10), c("c", 300, 60)], 3, 20);
    expect(ranked.map((x) => x.slug)).toEqual(["b", "c"]);
    expect(rankCandidates([c("a", 10, 900), c("b", 500, 10), c("c", 300, 60)], 5, 50).map((x) => x.slug)).toEqual(["a", "c"]);
  });

  it("fills 75 with every identity represented, at most 4 per identity and 12 per archetype, 10+ archetypes and mixed win conditions", async () => {
    const { candidates, evaluate } = pool(6);
    const r = await selectBracket(candidates, B3, evaluate);
    expect(r.picks).toHaveLength(75);
    const div = diversitySummary(r.picks);
    expect(Object.keys(div.identities)).toHaveLength(32);
    expect(Math.max(...Object.values(div.identities))).toBeLessThanOrEqual(4);
    expect(Math.max(...Object.values(div.archetypes))).toBeLessThanOrEqual(12);
    expect(Object.keys(div.archetypes).length).toBeGreaterThanOrEqual(10);
    for (const w of WINS) expect(div.winConditions[w] ?? 0).toBeGreaterThanOrEqual(3);
    expect(r.picks.filter((p) => p.pass === "A")).toHaveLength(32);
    expect(r.unmet).toEqual([]);
    expect(new Set(r.picks.map((p) => p.slug)).size).toBe(75);
  });

  it("skips commanders whose deck fails to evaluate and records why", async () => {
    const { candidates, evals, evaluate } = pool(2);
    evals.set("mono-red-0", { ok: false, reason: "cards not in our card data: Brand New Card" });
    const r = await selectBracket(candidates, { ...B3, target: 40 }, evaluate);
    expect(r.picks.map((p) => p.slug)).not.toContain("mono-red-0");
    expect(r.picks.map((p) => p.slug)).toContain("mono-red-1");
    expect(r.rejected).toEqual([{ slug: "mono-red-0", name: "Mono-red 0", reason: "cards not in our card data: Brand New Card" }]);
  });

  it("enforces the archetype cap, relaxing it only when nothing else can fill the bracket", async () => {
    const { candidates, evals, evaluate } = pool(4);
    for (const c of candidates) evals.set(c.slug, { ok: true, primary: c.identity.length % 2 ? "combo" : "tokens", winCondition: "combo" });
    const r = await selectBracket(candidates, { ...B3, target: 30 }, evaluate);
    const div = diversitySummary(r.picks);
    expect(div.archetypes.combo).toBeGreaterThan(12);
    expect(r.picks.some((p) => p.pass === "E")).toBe(true);
    expect(r.unmet.join(" ")).toMatch(/archetype cap of 12 relaxed/);
    expect(r.unmet.join(" ")).toMatch(/only 2 distinct primary archetypes/);
  });

  it("caps the overlap with an earlier bracket at the given number", async () => {
    const { candidates, evaluate } = pool(4);
    const earlier = new Set(candidates.slice(0, 60).map((c) => c.slug));
    const r = await selectBracket(candidates, { ...B3, bracket: 4, overlapWith: earlier, overlapCap: 25 }, evaluate);
    expect(r.picks.filter((p) => earlier.has(p.slug)).length).toBeLessThanOrEqual(25);
    expect(r.picks).toHaveLength(75);
  });

  it("cEDH: one deck per identity size group, at most 3 per identity, only commanders with 50+ cEDH decks", async () => {
    const { candidates, evaluate } = pool(3, (i) => (i % 5 === 0 ? 30 : 400 - i));
    const r = await selectBracket(candidates, { bracket: 5, target: 25, identityCap: 3, archetypeCap: 12, minArchetypes: 10, minDecks: 50, coverage: "group", winConMin: 1 }, evaluate);
    expect(r.picks).toHaveLength(25);
    expect(r.picks.every((p) => p.decks >= 50)).toBe(true);
    const groups = diversitySummary(r.picks).groups;
    for (const g of ["mono-colour", "two-colour", "three-colour", "four-colour", "five-colour", "colourless"]) expect(groups[g] ?? 0, g).toBeGreaterThanOrEqual(1);
    expect(Math.max(...Object.values(diversitySummary(r.picks).identities))).toBeLessThanOrEqual(3);
  });
});
