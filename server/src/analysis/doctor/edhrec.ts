import { normalizeName, type Bracket } from "@cgwf/shared";
import type { EdhrecClient } from "../../library/edhrec/client.js";

/**
 * EDHREC's per-commander card data for the Deck Doctor. A commander page
 * (`json.edhrec.com/pages/commanders/<slug>.json`, verified 2026-10-19) lists cards in
 * `container.json_dict.cardlists[].cardviews[]`, each with `synergy` (how much more often decks with this
 * commander play it than other decks of its colours, -1..1), `num_decks` and `potential_decks` (decks
 * with this commander that could play it); inclusion = num_decks / potential_decks. Bracket pages exist
 * at `commanders/<slug>/<core|upgraded|optimized|cedh>.json` and are preferred when the deck's target
 * bracket maps to one. Cached on disk 7 days, fetched politely through the import's client.
 */

export interface EdhrecCardStat {
  name: string;
  synergy: number;
  inclusion: number;
  numDecks: number;
}

export interface CommanderEdhrec {
  slug: string;
  name: string;
  url: string;
  /** The bracket page the numbers come from, or null for the all-brackets page. */
  page: string | null;
  /** Keyed by normalizeName(card name). */
  cards: Map<string, EdhrecCardStat>;
}

export const EDHREC_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** EDHREC's bracket page names (Bracket 1 has none: the all-brackets page is used). */
export const EDHREC_BRACKET_PAGE: Record<Bracket, string | null> = { 1: null, 2: "core", 3: "upgraded", 4: "optimized", 5: "cedh" };

/** EDHREC's slug for a card name: front face, no accents or punctuation, words joined by hyphens. */
export function edhrecSlug(name: string): string {
  const front = name.split(" // ")[0] ?? name;
  return front
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slugs to try for a deck's commander(s): EDHREC joins partner / background pairs in either order. */
export function slugCandidates(commanders: string[]): string[] {
  const slugs = commanders.map(edhrecSlug).filter(Boolean);
  if (slugs.length === 0) return [];
  if (slugs.length === 1) return [slugs[0]!];
  const [a, b] = slugs as [string, string];
  return [`${a}-${b}`, `${b}-${a}`];
}

interface RawView {
  name?: unknown;
  synergy?: unknown;
  num_decks?: unknown;
  potential_decks?: unknown;
}

/** The page's own commander name and every card it lists; null when the page has no card lists. */
export function parseCommanderPage(json: unknown): { name: string; cards: Map<string, EdhrecCardStat> } | null {
  const dict = (json as { container?: { json_dict?: { card?: { name?: unknown }; cardlists?: Array<{ cardviews?: RawView[] }> } } } | null)?.container?.json_dict;
  if (!dict || !Array.isArray(dict.cardlists)) return null;
  const cards = new Map<string, EdhrecCardStat>();
  for (const list of dict.cardlists) {
    for (const v of list.cardviews ?? []) {
      if (typeof v.name !== "string") continue;
      const numDecks = typeof v.num_decks === "number" ? v.num_decks : 0;
      const potential = typeof v.potential_decks === "number" && v.potential_decks > 0 ? v.potential_decks : 0;
      const stat: EdhrecCardStat = {
        name: v.name,
        synergy: typeof v.synergy === "number" && Number.isFinite(v.synergy) ? v.synergy : 0,
        inclusion: potential ? Math.min(1, numDecks / potential) : 0,
        numDecks,
      };
      const key = normalizeName(v.name);
      const prev = cards.get(key);
      if (!prev || stat.numDecks > prev.numDecks) cards.set(key, stat);
    }
  }
  const name = typeof dict.card?.name === "string" ? dict.card.name : "";
  return { name, cards };
}

/** Does the page belong to these commanders? Its name must mention each commander's front face. */
export function pageMatches(pageName: string, commanders: string[]): boolean {
  const page = normalizeName(pageName);
  return commanders.length > 0 && commanders.every((c) => page.includes(normalizeName(c.split(" // ")[0] ?? c)));
}

export type EdhrecLoad =
  | { status: "ok"; data: CommanderEdhrec }
  | { status: "missing"; slug: string | null; message: string }
  | { status: "unavailable"; slug: string | null; message: string };

export async function loadCommanderEdhrec(client: Pick<EdhrecClient, "get">, commanders: string[], bracket: Bracket): Promise<EdhrecLoad> {
  if (commanders.length === 0) return { status: "missing", slug: null, message: "This deck has no commander marked, so there is no EDHREC data to compare with." };
  const slugs = slugCandidates(commanders);
  let lastError: string | null = null;
  for (const slug of slugs) {
    let base: ReturnType<typeof parseCommanderPage> = null;
    try {
      base = parseCommanderPage(await client.get(`commanders/${slug}`, { maxAgeMs: EDHREC_MAX_AGE_MS, failFast: true }));
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!base || !pageMatches(base.name, commanders)) continue;
    const page = EDHREC_BRACKET_PAGE[bracket];
    let cards = base.cards;
    let used: string | null = null;
    if (page) {
      try {
        const bp = parseCommanderPage(await client.get(`commanders/${slug}/${page}`, { maxAgeMs: EDHREC_MAX_AGE_MS, failFast: true }));
        if (bp && bp.cards.size >= 20) {
          // The bracket page's numbers win; cards only on the all-brackets page keep theirs.
          cards = new Map([...base.cards, ...bp.cards]);
          used = page;
        }
      } catch {
        // The all-brackets page is still useful.
      }
    }
    return { status: "ok", data: { slug, name: base.name, url: `https://edhrec.com/commanders/${slug}${used ? `/${used}` : ""}`, page: used, cards } };
  }
  if (lastError) return { status: "unavailable", slug: slugs[0] ?? null, message: `EDHREC could not be reached (${lastError}).` };
  return { status: "missing", slug: slugs[0] ?? null, message: `No EDHREC data for ${commanders.join(" + ")}.` };
}
