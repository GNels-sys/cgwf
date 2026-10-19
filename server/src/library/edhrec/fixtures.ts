/**
 * EDHREC response fixtures for tests (no network in CI). The shapes copy the real responses
 * captured on 2026-10-18 (commanders/week.json, commanders/<slug>.json,
 * average-decks/<slug>/<bracket>.json), trimmed to the fields the importer reads.
 */
export function listPage(entries: Array<{ name: string; slug: string; numDecks: number }>) {
  return {
    header: "Commanders",
    container: { json_dict: { cardlists: [{ header: "Past Week", cardviews: entries.map((e, i) => ({ id: `id-${e.slug}`, name: e.name, sanitized: e.slug, slug: e.slug, url: `/commanders/${e.slug}`, num_decks: e.numDecks, potential_decks: 0, rank: i + 1 })) }] } },
  };
}

export function commanderPage(name: string, colorIdentity: string[], counts: [number, number, number, number, number]) {
  return {
    bracket_counts: { "1": counts[0], "2": counts[1], "3": counts[2], "4": counts[3], "5": counts[4] },
    header: `${name} (Commander)`,
    container: { json_dict: { card: { name, names: name.split(" // "), color_identity: colorIdentity, num_decks: counts.reduce((a, b) => a + b, 0) }, cardlists: [] } },
  };
}

export function averageDeck(commanders: string[], groups: Record<string, Array<[string, number]>>, scryfall: Array<{ u: string; q: number; c: "c" | "m" }> = []) {
  return {
    header: `Average Deck for ${commanders.join(" // ")}`,
    deck: { commander: commanders, commander_v2: commanders, cards: groups },
    archidekt: scryfall.map((s) => ({ c: s.c, f: 0, q: s.q, u: s.u })),
  };
}

/** A legal 100-card Atraxa list from cards.sample.json: eight spells and 91 Forests. */
export function atraxaGroups(extra: Array<[string, number]> = []): Record<string, Array<[string, number]>> {
  return {
    Artifact: [
      ["Sol Ring", 1],
      ["Arcane Signet", 1],
      ["Lightning Greaves", 1],
    ],
    Creature: [
      ["Lotus Cobra", 1],
      ["Scute Swarm", 1],
      ["Tireless Tracker", 1],
    ],
    Enchantment: [
      ["Glorious Anthem", 1],
      ["Rancor", 1],
    ],
    Land: [["Forest", 91 - extra.reduce((n, e) => n + e[1], 0)], ...extra],
  };
}

/** A fetch that answers from a path -> JSON table; unknown paths get EDHREC's 403. Counts calls. */
export function fixtureFetch(table: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    const p = url.replace("https://json.edhrec.com/pages/", "").replace(/\.json$/, "");
    calls.push(p);
    if (!(p in table)) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    const v = table[p];
    if (v instanceof Response) return v;
    return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}
