import { asc, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  normalizeName,
  PLACEMENT_MAX_CARDS,
  PLACEMENT_MAX_DECKS,
  rankPlacements,
  type PlacementCardResult,
  type PlacementDeckInfo,
  type PlacementOption,
  type PlacementResponse,
  type PlacementSkip,
} from "@cgwf/shared";
import type { DbHandle } from "../../db/index.js";
import { cards, decks, type CardRow } from "../../db/schema.js";
import { resolveDecklist } from "../../decks/resolve.js";
import { rowToSummary } from "../../scryfall/map.js";
import type { NameIndex } from "../../search/index.js";
import { DoctorError, type DeckDoctor } from "./service.js";

/**
 * Card placement (owner only while it is tested, 2026-11-11): "I have these cards; which of my decks should each
 * one go into?" The pasted list is resolved like a decklist import (one copy of each card; repeats and basics
 * dropped), then every one of the player's decks is weighed ONCE with all the cards as Doctor candidates
 * (DeckDoctor.placeInDeck), so the scoring is exactly the Doctor's: EDHREC synergy and inclusion for that deck's
 * commander, roles the deck is short of, Spellbook combos the card completes, the bracket replay. Each card's
 * decks come back best first (shared rankPlacements). Adding is the Doctor's own apply route. No model spend.
 */
export async function placeCards(
  deps: { handle: DbHandle; index: NameIndex; doctor: DeckDoctor; log?: FastifyBaseLogger | undefined },
  userId: string,
  req: { text: string; deckIds?: string[] | undefined },
): Promise<PlacementResponse> {
  const { handle, index, doctor } = deps;
  const text = String(req.text ?? "").slice(0, 20_000);
  if (!text.trim()) throw new DoctorError("paste at least one card", 400);

  // 1. The cards: resolve like an import, one entry per card (by Oracle id), in the order typed.
  const resolved = resolveDecklist({ handle, index }, text);
  const results: PlacementCardResult[] = [];
  const rowByOracle = new Map<string, CardRow>();
  const seen = new Set<string>();
  let truncatedCards = false;
  const ids: string[] = [];
  const picks: Array<{ lineRaw: string; status: string; note: string | null; cardId: string | null; name: string }> = [];
  for (const l of resolved.lines) {
    if (!l.card) {
      picks.push({ lineRaw: l.line.raw, status: "unresolved", note: l.note, cardId: null, name: l.line.name });
      continue;
    }
    // The default paper printing of the card (the Doctor's choice too), the typed printing when there is none.
    const def = index.exact(normalizeName(l.card.name));
    const id = def && !def.isToken ? def.id : l.card.id;
    ids.push(id);
    const note = l.status === "ambiguous" ? (l.note ?? `Best guess for "${l.line.name}": ${l.card.name}.`) : l.note;
    picks.push({ lineRaw: l.line.raw, status: "ok", note, cardId: id, name: l.card.name });
  }
  const rows = new Map<string, CardRow>();
  const idList = [...new Set(ids)];
  for (let i = 0; i < idList.length; i += 400) {
    for (const r of handle.db.select().from(cards).where(inArray(cards.id, idList.slice(i, i + 400))).all()) rows.set(r.id, r);
  }
  for (const p of picks) {
    if (results.length >= PLACEMENT_MAX_CARDS) {
      truncatedCards = true;
      break;
    }
    if (p.status === "unresolved" || !p.cardId) {
      results.push({ line: p.lineRaw, status: "unresolved", note: p.note ?? `No card called "${p.name}".`, card: null, oracleId: null, options: [], skipped: [] });
      continue;
    }
    const row = rows.get(p.cardId);
    if (!row || !row.oracleId) continue;
    if (seen.has(row.oracleId)) continue; // "2 Sol Ring" or the same card twice: placed once
    seen.add(row.oracleId);
    const base = { line: p.lineRaw, card: rowToSummary(row), oracleId: row.oracleId, options: [], skipped: [] };
    if (/\bBasic\b/.test(row.typeLine)) {
      results.push({ ...base, status: "not_legal", note: "Basic lands are not placed; add them from the deck page." });
      continue;
    }
    if (row.isToken || (row.legalities as Record<string, string>).commander !== "legal") {
      results.push({ ...base, status: "not_legal", note: `${row.name} is not legal in Commander.` });
      continue;
    }
    results.push({ ...base, status: "ok", note: p.note });
    rowByOracle.set(row.oracleId, row);
  }
  if (results.length === 0) throw new DoctorError("no cards found in that list", 400);

  // 2. The decks: the player's own (by name), or the ones they picked.
  const all = handle.db.select({ id: decks.id, name: decks.name }).from(decks).where(eq(decks.userId, userId)).orderBy(asc(decks.name)).all();
  const wanted = req.deckIds?.length ? new Set(req.deckIds) : null;
  const pool = wanted ? all.filter((d) => wanted.has(d.id)) : all;
  if (pool.length === 0) throw new DoctorError(wanted ? "none of those decks are yours" : "you have no decks yet: import one first", 400);
  const truncatedDecks = pool.length > PLACEMENT_MAX_DECKS;
  const chosen = pool.slice(0, PLACEMENT_MAX_DECKS);

  // 3. Weigh every deck once with all the placeable cards.
  const placeable = [...rowByOracle.values()];
  const options = new Map<string, PlacementOption[]>();
  const skipped = new Map<string, PlacementSkip[]>();
  const deckInfo: PlacementDeckInfo[] = [];
  for (const d of chosen) {
    if (placeable.length === 0) break;
    try {
      const r = await doctor.placeInDeck(userId, d.id, placeable);
      deckInfo.push(r.deck);
      for (const [oid, o] of r.options) options.set(oid, [...(options.get(oid) ?? []), o]);
      for (const [oid, reason] of r.skipped) skipped.set(oid, [...(skipped.get(oid) ?? []), { deckId: d.id, deckName: d.name, reason }]);
    } catch (err) {
      const message = err instanceof DoctorError ? err.message : "this deck could not be weighed";
      if (!(err instanceof DoctorError)) deps.log?.warn({ err, deckId: d.id }, "card placement: deck failed");
      deckInfo.push({ deckId: d.id, name: d.name, commanders: [], targetBracket: null, edhrec: "unavailable", message });
      for (const oid of rowByOracle.keys()) skipped.set(oid, [...(skipped.get(oid) ?? []), { deckId: d.id, deckName: d.name, reason: `Could not weigh this deck: ${message}.` }]);
    }
  }

  for (const c of results) {
    if (c.status !== "ok" || !c.oracleId) continue;
    c.options = rankPlacements(options.get(c.oracleId) ?? []);
    c.skipped = skipped.get(c.oracleId) ?? [];
  }
  return { cards: results, decks: deckInfo, limits: { maxCards: PLACEMENT_MAX_CARDS, maxDecks: PLACEMENT_MAX_DECKS, truncatedCards, truncatedDecks } };
}
