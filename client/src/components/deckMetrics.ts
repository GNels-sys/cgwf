import type { Bracket, DeckSummary, PipCounts } from "@cgwf/shared";
import { api } from "../api";

export interface DeckMetrics {
  bracket: Bracket | null;
  pips: PipCounts | null;
}

/** All fixed mana requirements: W/U/B/R/G/C plus numeric generic costs. X remains 0. */
export function totalManaPips(pips: PipCounts): number {
  return Math.round((pips.coloredTotal + pips.generic) * 100) / 100;
}

// Share work across collection remounts. The version and short lifetime keep edits
// and refreshed combo analysis visible without persisting private deck data.
const cache = new Map<string, { expires: number; value: Promise<DeckMetrics> }>();
let queue: Promise<unknown> = Promise.resolve();
let lastStart = 0;

export function loadDeckMetrics(userId: string, deck: DeckSummary): Promise<DeckMetrics> {
  const key = JSON.stringify([userId, deck.id, deck.updatedAt]);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const value = queue.then(async () => {
    // Analysis allows 30 requests/minute. Pace starts, including retries/remounts.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2100 - (Date.now() - lastStart))));
    lastStart = Date.now();
    const [analysis, stats] = await Promise.allSettled([
      api.decks.analysis(deck.id), api.decks.stats(deck.id),
    ]);
    const result = {
      bracket: analysis.status === "fulfilled" ? analysis.value.analysis.suggested : null,
      pips: stats.status === "fulfilled" ? stats.value.stats.pips : null,
    };
    if (!result.bracket || !result.pips) cache.delete(key);
    else {
      const entry = cache.get(key);
      if (entry) entry.expires = Date.now() + 60_000;
    }
    return result;
  });
  queue = value.catch(() => undefined);
  // Bound memory while retaining recently visited collections.
  for (const [oldKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(oldKey);
  if (cache.size >= 300) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Infinity, value });
  return value;
}

export type DeckSort = "updated" | "bracket-asc" | "bracket-desc" | "pips" | "name";

export function sortDecks(decks: DeckSummary[], metrics: Record<string, DeckMetrics>, sort: DeckSort): DeckSummary[] {
  return [...decks].sort((a, b) => {
    const am = metrics[a.id], bm = metrics[b.id];
    let result = 0;
    if (sort === "bracket-asc" || sort === "bracket-desc" || sort === "pips") {
      const av = sort === "pips" ? (am?.pips ? totalManaPips(am.pips) : null) : am?.bracket;
      const bv = sort === "pips" ? (bm?.pips ? totalManaPips(bm.pips) : null) : bm?.bracket;
      // Unavailable and still-loading values always stay at the end.
      if (av == null || bv == null) result = av == null ? (bv == null ? 0 : 1) : -1;
      else result = (av - bv) * (sort === "bracket-asc" ? 1 : -1);
    } else if (sort === "updated") result = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    return result || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
