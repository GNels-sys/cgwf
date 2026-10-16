import type { DeckAnalysis, PowerSignal } from "@cgwf/shared";
import { detectArchetypes } from "./archetypes.js";
import { decideBracket } from "./bracket.js";
import { expanded, isLand, type AnalysisCard } from "./cards.js";
import { classifyCombos, type SpellbookResults } from "./combos.js";
import { detectExtraTurns } from "./extraTurns.js";
import { countCardDraw, countInteraction, countRamp, detectFastMana, detectFreeInteraction } from "./fastMana.js";
import { detectGameChangers, type GameChangersList } from "./gameChangers.js";
import { detectMassLandDenial } from "./landDenial.js";
import { summarize } from "./summary.js";
import { detectTutors } from "./tutors.js";

export type { AnalysisCard } from "./cards.js";
export { fromRow } from "./cards.js";
export { loadGameChangers, fromNames as gameChangersFromNames, type GameChangersList } from "./gameChangers.js";
export { classifyCombos, type SpellbookResults, type SpellbookVariant } from "./combos.js";
export { primerSkeleton } from "./primer.js";

export interface AnalyzeOptions {
  gameChangers: GameChangersList;
  /** Commander Spellbook results for this exact list, or null when the lookup failed, or undefined when it was not attempted. */
  combos?: SpellbookResults | null;
  now?: Date;
}

/** The whole engine, pure: cards in, analysis out. No I/O. */
export function analyzeDeck(cards: AnalysisCard[], opts: AnalyzeOptions): DeckAnalysis {
  const all = expanded(cards);
  const nonland = all.filter((c) => !isLand(c));
  const gameChangers = detectGameChangers(cards, opts.gameChangers);
  const massLandDenial = detectMassLandDenial(cards);
  const extraTurns = detectExtraTurns(cards);
  const tutors = detectTutors(cards);
  const fastMana = detectFastMana(cards);
  const free = detectFreeInteraction(cards);
  const combos = classifyCombos(opts.combos ?? null);
  const combosStatus: DeckAnalysis["combosStatus"] = opts.combos === undefined ? "skipped" : opts.combos === null ? "unavailable" : "ok";
  const averageManaValue = nonland.length ? nonland.reduce((s, c) => s + c.cmc, 0) / nonland.length : 0;
  const archetypes = detectArchetypes({ cards, comboCount: combos.length, twoCardComboCount: combos.filter((c) => c.twoCard).length });

  const signals: PowerSignal[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (fastMana.length) signals.push({ kind: "fast_mana", weight: Math.min(6, fastMana.length * 1.2), cards: fastMana, text: plural(fastMana.length, "fast-mana piece") });
  if (tutors.count) signals.push({ kind: "tutors", weight: Math.min(6, tutors.count * 0.8), cards: tutors.cards.map((t) => t.name), text: plural(tutors.count, "tutor") });
  if (free.length) signals.push({ kind: "free_interaction", weight: Math.min(6, free.length * 2), cards: free, text: plural(free.length, "free spell") });
  if (nonland.length >= 40 && averageManaValue < 2.6) signals.push({ kind: "low_curve", weight: 3, cards: [], text: `very low curve (${averageManaValue.toFixed(2)})` });
  else if (nonland.length >= 40 && averageManaValue < 3.0) signals.push({ kind: "low_curve", weight: 1.5, cards: [], text: `low curve (${averageManaValue.toFixed(2)})` });
  if (gameChangers.length) signals.push({ kind: "game_changers", weight: gameChangers.length * 1.5, cards: gameChangers, text: plural(gameChangers.length, "Game Changer") });
  if (combos.length) {
    const two = combos.filter((c) => c.twoCard).length;
    signals.push({
      kind: "combo_density",
      weight: Math.min(6, combos.length * 1.5 + two),
      cards: [...new Set(combos.flatMap((c) => c.cards))].slice(0, 8),
      text: `${plural(combos.length, "combo")} on Commander Spellbook`,
    });
  }
  if (extraTurns.cards.length) {
    signals.push({ kind: "extra_turns", weight: extraTurns.cards.length * (extraTurns.chaining ? 2 : 1), cards: extraTurns.cards, text: plural(extraTurns.cards.length, "extra-turn card") });
  }
  const stax = archetypes.find((a) => a.tag === "stax");
  if (stax && stax.confidence >= 0.5) signals.push({ kind: "stax", weight: 2, cards: stax.evidence, text: "stax pieces" });

  const decision = decideBracket({ gameChangers, massLandDenial, extraTurns, combos, signals });

  const partial: Omit<DeckAnalysis, "summary"> = {
    floor: decision.floor,
    suggested: decision.suggested,
    reasons: decision.reasons,
    signals,
    judgmentNote: decision.judgmentNote,
    gameChangers,
    massLandDenial: massLandDenial.map((m) => m.name),
    extraTurns,
    tutors: { count: tutors.count, cards: tutors.cards },
    fastMana,
    combos,
    combosStatus,
    archetypes,
    stats: {
      cards: all.length,
      nonlandCount: nonland.length,
      landCount: all.length - nonland.length,
      averageManaValue: Math.round(averageManaValue * 100) / 100,
      interactionCount: countInteraction(cards),
      rampCount: countRamp(cards),
      cardDrawCount: countCardDraw(cards),
    },
    gameChangersListDate: opts.gameChangers.listDate,
    computedAt: (opts.now ?? new Date()).toISOString(),
  };
  const commanders = cards.filter((c) => c.board === "commander").map((c) => c.name);
  return { ...partial, summary: summarize(partial, commanders) };
}
