import type { Bracket, BracketReason, ComboHit, PowerSignal } from "@cgwf/shared";
import { BRACKET_NAMES } from "@cgwf/shared";
import type { ExtraTurnResult } from "./extraTurns.js";
import type { LandDenialHit } from "./landDenial.js";

/**
 * Bracket decision. Two numbers, kept apart on purpose:
 *
 *  FLOOR     the lowest bracket the written deck-building rules allow. Hard
 *            rules only: Game Changers count, mass land denial, extra turns and
 *            chaining, two-card infinite combos (any / early-game).
 *  SUGGESTED a heuristic guess at where the deck actually plays, from the
 *            floor plus soft power signals (fast mana, tutors, free
 *            interaction, curve, combo density). Never lower than the floor,
 *            never 5 (cEDH is a self-declaration), and 3 vs 4 is explicitly a
 *            judgment call.
 *
 * Rules summary (official, current as of 2026-02-09; details in CLAUDE.md):
 *  B1 Exhibition : no Game Changers, no mass land denial, no extra turns, no two-card combos
 *  B2 Core       : no Game Changers, no MLD, extra turns not chained, no two-card combos
 *  B3 Upgraded   : up to 3 Game Changers, no MLD, extra turns not chained, no EARLY two-card combos
 *  B4 Optimized  : no restrictions beyond the banned list
 *  B5 cEDH       : no restrictions; built for the competitive metagame
 *  Tutor limits were removed in October 2025.
 */
export interface BracketInput {
  gameChangers: string[];
  massLandDenial: LandDenialHit[];
  extraTurns: ExtraTurnResult;
  combos: ComboHit[];
  signals: PowerSignal[];
}

export interface BracketDecision {
  floor: Bracket;
  suggested: Bracket;
  reasons: BracketReason[];
  judgmentNote: string;
  powerScore: number;
}

export function decideBracket(input: BracketInput): BracketDecision {
  const reasons: BracketReason[] = [];
  const gc = input.gameChangers;
  if (gc.length > 3) {
    reasons.push({ kind: "game_changers", bracket: 4, cards: gc, text: `${gc.length} Game Changers; Bracket 3 allows at most three.` });
  } else if (gc.length > 0) {
    reasons.push({ kind: "game_changers", bracket: 3, cards: gc, text: `${gc.length} Game Changer${gc.length > 1 ? "s" : ""}; Brackets 1 and 2 allow none.` });
  }
  if (input.massLandDenial.length > 0) {
    reasons.push({
      kind: "mass_land_denial",
      bracket: 4,
      cards: input.massLandDenial.map((m) => m.name),
      text: `Mass land denial (${input.massLandDenial.map((m) => `${m.name}: ${m.why}`).join("; ")}); only Bracket 4+ allows it.`,
    });
  }
  const et = input.extraTurns;
  if (et.chaining) {
    reasons.push({
      kind: "extra_turn_chaining",
      bracket: 4,
      cards: et.cards,
      text: `Extra turns can chain (${et.chainingWhy}); Brackets 2 and 3 allow extra turns only when they are not chained or looped.`,
    });
  } else if (et.cards.length > 0) {
    reasons.push({ kind: "extra_turns", bracket: 2, cards: et.cards, text: `Extra-turn card${et.cards.length > 1 ? "s" : ""}; Bracket 1 allows none.` });
  }
  const early = input.combos.filter((c) => c.early);
  const twoCard = input.combos.filter((c) => c.twoCard);
  if (early.length > 0) {
    reasons.push({
      kind: "cheap_two_card_combo",
      bracket: 4,
      cards: [...new Set(early.flatMap((c) => c.cards))],
      text: `Two-card infinite combo${early.length > 1 ? "s" : ""} cheap enough for the first six turns (${early.map((c) => c.cards.join(" + ")).join("; ")}); Bracket 3 allows no early-game two-card combos.`,
    });
  } else if (twoCard.length > 0) {
    reasons.push({
      kind: "two_card_combo",
      bracket: 3,
      cards: [...new Set(twoCard.flatMap((c) => c.cards))],
      text: `Two-card infinite combo${twoCard.length > 1 ? "s" : ""} (${twoCard.map((c) => c.cards.join(" + ")).join("; ")}); Brackets 1 and 2 allow none, Bracket 3 allows them only when they are not early-game.`,
    });
  }

  const floor = reasons.reduce<Bracket>((b, r) => (r.bracket > b ? r.bracket : b), 1);

  // Soft signals -> suggested bracket.
  const powerScore = Math.round(input.signals.reduce((s, x) => s + x.weight, 0) * 10) / 10;
  let fromScore: Bracket = 2;
  if (powerScore >= 14) fromScore = 4;
  else if (powerScore >= 7) fromScore = 3;
  let suggested: Bracket = Math.max(floor, fromScore) as Bracket;
  if (suggested > 4) suggested = 4;
  // Bracket 1 is "show off your creation": nobody gets put there by a scanner.
  if (suggested < 2) suggested = 2;

  const notes: string[] = [
    "The floor is what the written rules allow; the suggestion is a heuristic.",
    "Brackets are a tool for the pregame conversation, and deck-building intent matters more than any card count.",
  ];
  if (suggested === 3 || suggested === 4) {
    notes.push(
      "3 vs 4 is a judgment call: Bracket 3 expects at least six turns before anyone wins and win conditions deployed in one big turn; Bracket 4 is built to win as fast and consistently as possible.",
    );
  }
  if (powerScore >= 22 && suggested === 4) notes.push("The power signals are cEDH-level; Bracket 5 is a self-declaration for decks tuned to the competitive metagame.");
  if (floor === 1) notes.push(`Nothing restricted was found, so Bracket 1 (${BRACKET_NAMES[1]}) is allowed, but Bracket 1 is for themed showcase decks; the suggestion starts at 2.`);

  return { floor, suggested, reasons, judgmentNote: notes.join(" "), powerScore };
}
