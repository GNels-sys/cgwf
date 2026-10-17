import { cardDisplayName } from "./effects.js";
import { permanentsOf, derivedFor, typeLineOf } from "./combat.js";
import { isOut, type CardInstance, type GameState, type WinAdvisory } from "./types.js";

/**
 * Advisory detection of "you win the game" cards whose STATIC condition looks met
 * right now. Deliberately narrow: counters on the card itself, life totals,
 * "you control N or more <type>", cards in your graveyard, and Barren Glory's
 * empty board. Anything else (Thassa's Oracle, Laboratory Maniac, Approach of the
 * Second Sun, "at the beginning of your upkeep" timing) is left to the players.
 * Nothing here ends the game: the controller confirms with WinClaimed.
 */

const NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100, "one hundred": 100,
};

export function wordToNumber(word: string): number | null {
  const w = word.trim().toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  if (NUMBERS[w] !== undefined) return NUMBERS[w]!;
  const m = w.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)$/);
  if (m) return NUMBERS[m[1]!]! + NUMBERS[m[2]!]!;
  return null;
}

function stripReminders(text: string): string {
  return text.replace(/\([^)]*\)/g, "");
}

/** Lower-cased oracle text with the card's own name (and its short name) replaced by "~". */
export function normalizeText(c: CardInstance): string {
  const p = c.printing;
  const face = p ? (p.faces[c.face] ?? p.faces[0]) : undefined;
  const raw = c.custom?.text ?? face?.oracleText ?? p?.oracleText ?? "";
  const name = c.custom?.name ?? (p ? cardDisplayName(p, c.face) : "");
  let t = stripReminders(raw);
  if (name) {
    const first = name.split(",")[0]!.trim();
    t = t.split(name).join("~");
    if (first && first !== name) t = t.split(first).join("~");
  }
  return t.toLowerCase();
}

const NUM = "(\\d+|one hundred|[a-z]+(?:-[a-z]+)?)";

function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

function typeMatches(c: CardInstance, typeWord: string): boolean {
  const word = singular(typeWord.toLowerCase());
  if (word === "permanent") return true;
  return new RegExp(`\\b${word}\\b`).test(typeLineOf(c));
}

export interface WinCheck {
  condition: string;
  met: boolean;
}

/** Evaluate the static patterns we understand for one permanent. Null when the text has no recognised condition. */
export function checkWinCondition(state: GameState, c: CardInstance): WinCheck | null {
  const text = normalizeText(c);
  if (!/\byou win the game\b/.test(text)) return null;
  const player = state.players[c.zone.owner];
  if (!player) return null;

  // "~ has twenty or more charge counters" / "there are one hundred or more tower counters on ~"
  let m = text.match(new RegExp(`~ has ${NUM} or more ([a-z+/-]+) counters?`)) ?? text.match(new RegExp(`there are ${NUM} or more ([a-z+/-]+) counters? on ~`));
  if (m) {
    const n = wordToNumber(m[1]!);
    const kind = m[2]!;
    if (n !== null) {
      const have = c.counters[kind] ?? 0;
      return { condition: `${n} or more ${kind} counters (has ${have})`, met: have >= n };
    }
  }
  // "if you have 40 or more life" / "if you have exactly 13 life"
  m = text.match(new RegExp(`you have ${NUM} or more life`));
  if (m) {
    const n = wordToNumber(m[1]!);
    if (n !== null) return { condition: `${n} or more life (has ${player.life})`, met: player.life >= n };
  }
  m = text.match(new RegExp(`you have exactly ${NUM} life`));
  if (m) {
    const n = wordToNumber(m[1]!);
    if (n !== null) return { condition: `exactly ${n} life (has ${player.life})`, met: player.life === n };
  }
  // "if you control a creature with power 20 or greater"
  m = text.match(new RegExp(`you control a creature with power ${NUM} or greater`));
  if (m) {
    const n = wordToNumber(m[1]!);
    if (n !== null) {
      const derived = derivedFor(state, player.id);
      const best = Math.max(-1, ...[...derived.values()].filter((d) => d.isCreature).map((d) => d.power ?? -1));
      return { condition: `a creature with power ${n} or greater (best ${best < 0 ? "none" : best})`, met: best >= n };
    }
  }
  // "if you control ten or more Gates" / "twenty or more creatures" / "seven or more lands"
  m = text.match(new RegExp(`you control ${NUM} or more ([a-z]+?)s?\\b`));
  if (m) {
    const n = wordToNumber(m[1]!);
    const type = m[2]!;
    if (n !== null && type !== "card") {
      const have = permanentsOf(state, player.id).filter((x) => !x.faceDown && typeMatches(x, type)).length;
      return { condition: `${n} or more ${type}s (has ${have})`, met: have >= n };
    }
  }
  // "if there are twenty or more creature cards in your graveyard"
  m = text.match(new RegExp(`${NUM} or more (?:([a-z]+) )?cards (?:are )?in your graveyard`));
  if (m) {
    const n = wordToNumber(m[1]!);
    const type = m[2];
    if (n !== null) {
      const have = player.zones.graveyard.map((iid) => state.cards[iid]).filter((x): x is CardInstance => Boolean(x) && (!type || typeMatches(x!, type))).length;
      return { condition: `${n} or more ${type ? `${type} ` : ""}cards in your graveyard (has ${have})`, met: have >= n };
    }
  }
  // Barren Glory: "if you control no permanents other than ~ and have no cards in hand"
  if (/you control no permanents other than ~ and have no cards in hand/.test(text)) {
    const others = permanentsOf(state, player.id).filter((x) => x.iid !== c.iid).length;
    const hand = player.zones.hand.length;
    return { condition: `no other permanents and no cards in hand (${others} permanents, ${hand} in hand)`, met: others === 0 && hand === 0 };
  }
  return null;
}

/** Every face-up permanent whose recognised win condition is met right now, minus dismissed ones. */
export function detectWinConditions(state: GameState): WinAdvisory[] {
  if (state.phase !== "playing") return [];
  const out: WinAdvisory[] = [];
  for (const id of state.turnOrder) {
    const p = state.players[id];
    if (!p || isOut(p)) continue;
    for (const c of permanentsOf(state, id)) {
      if (c.faceDown || state.dismissedWins.includes(c.iid)) continue;
      const check = checkWinCondition(state, c);
      if (!check?.met) continue;
      const name = c.custom?.name ?? (c.printing ? cardDisplayName(c.printing, c.face) : "a card");
      out.push({ id: `${c.iid}:win`, iid: c.iid, controller: id, name, condition: check.condition });
    }
  }
  return out;
}
