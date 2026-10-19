import { identityKey } from "./identity.js";

/**
 * Pure readers for EDHREC's public JSON (json.edhrec.com/pages/...). Shapes verified 2026-10-18:
 *   commanders/{week|month|year|<identity>}.json -> container.json_dict.cardlists[0].cardviews[]
 *       {name, slug, num_decks, rank?}; partner / background pairs are one entry "A // B".
 *   commanders/<slug>.json -> bracket_counts {"1".."5": decks}, container.json_dict.card
 *       {name, names[], color_identity[], num_decks}.
 *   average-decks/<slug>/<upgraded|optimized|cedh>.json -> deck {commander[], cards {Type: [[name, qty]]}},
 *       plus `archidekt` [{c: "c"|"m", q, u: scryfall id}] and `header`.
 * Anything missing or malformed returns null / [] instead of throwing, so one odd page never stops
 * an import.
 */

export interface ListEntry {
  name: string;
  slug: string;
  numDecks: number;
}

export interface CommanderPage {
  slug: string;
  name: string;
  /** WUBRG-ordered colour identity, "" = colourless. */
  identity: string;
  /** Decks per EDHREC bracket 1..5. */
  bracketCounts: Record<1 | 2 | 3 | 4 | 5, number>;
  numDecks: number;
}

export interface AverageDeck {
  slug: string;
  commanders: string[];
  /** Main deck (everything but the commanders), names as EDHREC/Scryfall spell them. */
  cards: Array<{ name: string; quantity: number }>;
  /** Scryfall printing ids from the `archidekt` block (commanders first), when present. */
  scryfallIds: Array<{ id: string; quantity: number; commander: boolean }>;
  header: string;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseList(json: unknown): ListEntry[] {
  const lists = arr(obj(obj(obj(json)?.container)?.json_dict)?.cardlists);
  const views = arr(obj(lists[0])?.cardviews);
  const out: ListEntry[] = [];
  for (const v of views) {
    const o = obj(v);
    if (!o || typeof o.slug !== "string" || typeof o.name !== "string") continue;
    out.push({ name: o.name, slug: o.slug, numDecks: num(o.num_decks) });
  }
  return out;
}

export function parseCommanderPage(slug: string, json: unknown): CommanderPage | null {
  const root = obj(json);
  const card = obj(obj(obj(root?.container)?.json_dict)?.card);
  if (!root || !card || typeof card.name !== "string") return null;
  const raw = obj(root.bracket_counts) ?? {};
  const bracketCounts = { 1: num(raw["1"]), 2: num(raw["2"]), 3: num(raw["3"]), 4: num(raw["4"]), 5: num(raw["5"]) };
  const colors = arr(card.color_identity).filter((c): c is string => typeof c === "string");
  return { slug, name: card.name, identity: identityKey(colors), bracketCounts, numDecks: num(card.num_decks) };
}

export function parseAverageDeck(slug: string, json: unknown): AverageDeck | null {
  const root = obj(json);
  const deck = obj(root?.deck);
  if (!root || !deck) return null;
  const commanders = arr(deck.commander).filter((c): c is string => typeof c === "string" && c.trim().length > 0);
  if (commanders.length === 0) return null;
  const cards: AverageDeck["cards"] = [];
  const groups = obj(deck.cards) ?? {};
  for (const list of Object.values(groups)) {
    for (const entry of arr(list)) {
      const pair = arr(entry);
      const name = pair[0];
      if (typeof name !== "string" || !name.trim()) continue;
      cards.push({ name, quantity: Math.max(1, Math.trunc(num(pair[1]) || 1)) });
    }
  }
  const scryfallIds = arr(root.archidekt).flatMap((e) => {
    const o = obj(e);
    if (!o || typeof o.u !== "string") return [];
    return [{ id: o.u, quantity: Math.max(1, Math.trunc(num(o.q) || 1)), commander: o.c === "c" }];
  });
  return { slug, commanders, cards, scryfallIds, header: typeof root.header === "string" ? root.header : "" };
}

/** Decklist text our resolver reads: a Commander section, then the deck. */
export function averageDeckText(d: AverageDeck): string {
  return ["Commander", ...d.commanders.map((c) => `1 ${c}`), "", "Deck", ...d.cards.map((c) => `${c.quantity} ${c.name}`), ""].join("\n");
}

export function totalCards(d: AverageDeck): number {
  return d.commanders.length + d.cards.reduce((n, c) => n + c.quantity, 0);
}
