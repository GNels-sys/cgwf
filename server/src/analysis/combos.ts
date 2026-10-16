import type { ComboHit } from "@cgwf/shared";

/**
 * Pure classification of Commander Spellbook "find my combos" results. The
 * network client lives in spellbook.ts; tests feed hand-written variants here.
 *
 * Bracket rules: Brackets 1-2 allow no two-card infinite combos at all;
 * Bracket 3 allows none that are "early-game" (cheap enough for the first ~six
 * turns). We call a two-card combo early when the mana value Spellbook says is
 * needed to assemble it is 6 or less. That is a heuristic, and it is labelled
 * as one in the UI.
 */
export const EARLY_COMBO_MANA_VALUE = 6;

export interface SpellbookVariant {
  id: string;
  uses: Array<{ card: { name: string }; quantity?: number | undefined; mustBeCommander?: boolean | undefined }>;
  requires?: Array<{ template?: { name?: string | undefined } | undefined; quantity?: number | undefined }> | undefined;
  produces: Array<{ feature: { name: string; status?: string | undefined; uncountable?: boolean | undefined }; quantity?: number | undefined }>;
  manaValueNeeded?: number | undefined;
  manaNeeded?: string | undefined;
  bracketTag?: string | null | undefined;
  status?: string | undefined;
  identity?: string | undefined;
  description?: string | undefined;
  popularity?: number | null | undefined;
}

export interface SpellbookResults {
  identity?: string | undefined;
  included: SpellbookVariant[];
  almostIncluded?: SpellbookVariant[] | undefined;
}

/** Features that mean "the game ends" or "loop forever": the ones brackets care about. */
const GAME_ENDING = /\b(win the game|infinite|each opponent loses the game|opponents? lose the game|lose the game|near-arbitrary|arbitrarily large|lock)\b/i;

export function isGameEnding(v: SpellbookVariant): boolean {
  return v.produces.some((p) => GAME_ENDING.test(p.feature.name));
}

export function classifyCombos(results: SpellbookResults | null | undefined): ComboHit[] {
  if (!results) return [];
  const out: ComboHit[] = [];
  const seen = new Set<string>();
  for (const v of results.included ?? []) {
    if (v.status && v.status !== "OK") continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const cards = v.uses.map((u) => u.card.name);
    const pieces =
      v.uses.reduce((n, u) => n + Math.max(1, u.quantity ?? 1), 0) + (v.requires?.reduce((n, r) => n + Math.max(1, r.quantity ?? 1), 0) ?? 0);
    const mv = typeof v.manaValueNeeded === "number" && Number.isFinite(v.manaValueNeeded) ? v.manaValueNeeded : Number.POSITIVE_INFINITY;
    const twoCard = pieces <= 2 && isGameEnding(v);
    out.push({
      id: v.id,
      cards,
      produces: v.produces.map((p) => p.feature.name),
      manaValueNeeded: Number.isFinite(mv) ? mv : 99,
      twoCard,
      early: twoCard && mv <= EARLY_COMBO_MANA_VALUE,
      bracketTag: v.bracketTag ?? null,
      url: `https://commanderspellbook.com/combo/${encodeURIComponent(v.id)}/`,
    });
  }
  // Cheapest two-card combos first, then by piece count.
  return out.sort((a, b) => Number(b.twoCard) - Number(a.twoCard) || a.manaValueNeeded - b.manaValueNeeded || a.cards.length - b.cards.length);
}
