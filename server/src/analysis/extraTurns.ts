import { expanded, text, type AnalysisCard } from "./cards.js";

/**
 * Extra turns. Bracket 1 allows none; Brackets 2 and 3 allow a few that are
 * "not intended to be chained in succession or looped". We call it chaining
 * potential when the deck can realistically take several in a row: three or
 * more extra-turn cards, or any extra turn plus a way to recur / copy spells,
 * or a card that puts itself back (Nexus of Fate, Beacon of Tomorrows).
 */
const EXTRA_TURN = /\btakes? (?:an|two|three) extra turns?\b/;
// "Target player takes an extra turn" (Time Warp) is still yours; only explicit gifts to opponents are excluded.
const OPPONENT_TURN = /\b(?:target|each) opponent takes an extra turn\b/;

const RECURSION: Array<{ re: RegExp; why: string }> = [
  { re: /\breturn (?:target|up to \w+ target|all) (?:[a-z]+ )*(?:instant|sorcery|instant or sorcery|instant and\/or sorcery)(?: card)?s? (?:cards? )?from your graveyard to your hand\b/, why: "recurs instants and sorceries" },
  { re: /\breturn target card from your graveyard to your hand\b/, why: "recurs any card" },
  { re: /\b(?:you may )?cast (?:target |up to \w+ target )?(?:instant|sorcery|instant or sorcery)(?: card)?s? (?:cards? )?from your graveyard\b/, why: "casts spells from the graveyard" },
  { re: /\bgains? flashback\b/, why: "gives spells flashback" },
  { re: /\bcopy (?:target|that|the next) (?:instant or sorcery |instant |sorcery )?spell\b/, why: "copies spells" },
  { re: /\bexile target instant card from your graveyard\b.*\bcopy\b/, why: "copies spells from the graveyard" },
];

export interface ExtraTurnResult {
  cards: string[];
  chaining: boolean;
  chainingWhy: string | null;
}

export function detectExtraTurns(cards: AnalysisCard[]): ExtraTurnResult {
  const hits = expanded(cards).filter((c) => {
    const t = text(c);
    return EXTRA_TURN.test(t) && !OPPONENT_TURN.test(t);
  });
  const names = hits.map((c) => c.name);
  const selfRecurring = hits.filter((c) => {
    const t = text(c);
    return (
      /\bshuffle ~ into (?:its owner's|your) library\b/.test(t) ||
      /\bput ~ on the bottom of (?:its owner's|your) library\b/.test(t) ||
      /\bif ~ would be put into a graveyard\b/.test(t)
    );
  });
  const recursion = cards
    .filter((c) => !hits.includes(c))
    .flatMap((c) => {
      const t = text(c);
      const r = RECURSION.find((p) => p.re.test(t));
      return r ? [{ name: c.name, why: r.why }] : [];
    });

  let chaining = false;
  let why: string | null = null;
  if (names.length >= 3) {
    chaining = true;
    why = `${names.length} extra-turn cards can follow one another`;
  } else if (selfRecurring.length > 0) {
    chaining = true;
    why = `${selfRecurring[0]!.name} puts itself back into the library`;
  } else if (names.length >= 1 && recursion.length > 0) {
    chaining = true;
    why = `${recursion[0]!.name} ${recursion[0]!.why}, so extra turns can repeat`;
  }
  return { cards: [...new Set(names)], chaining, chainingWhy: why };
}
