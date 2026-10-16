import type {
  Breakdowns,
  CardTypeKey,
  ColorSourceRow,
  CurveBucket,
  DeckStats,
  FunctionalCount,
  FunctionalKey,
  WubrgColor,
  ManaProduction,
  ManaSourceCard,
  ManaValueTotals,
  PipColor,
  PipCounts,
  SourceKind,
} from "@cgwf/shared";
import { CARD_TYPE_KEYS, WUBRG, PIP_COLORS } from "@cgwf/shared";
import { expanded, isArtifact, isCreature, isInstantOrSorcery, isLand, text, type AnalysisCard } from "./cards.js";
import { findBoardWipes, findCardDraw, findCounterspells, findProtection, findRamp, findRecursion, findRemoval, findTutors, type Hit } from "./functional.js";

/**
 * Deck statistics, pure: cards in, numbers out. See shared/src/stats.ts for
 * the shapes and CLAUDE.md "Deck statistics (Phase 9)" for how each number is
 * defined and where the heuristics stop.
 *
 * Every function here works on `expanded(cards)` (one entry per physical copy)
 * and counts commanders together with the main deck.
 */

const KARSTEN = {
  author: "Frank Karsten",
  title: "How Many Sources Do You Need to Consistently Cast Your Spells? A 2022 Update",
  url: "https://www.channelfireball.com/article/How-Many-Sources-Do-You-Need-to-Consistently-Cast-Your-Spells-A-2022-Update/dc23a7d2-0a16-4c0b-ad36-586fcca03ad8/",
  text: "Rule of thumb from Frank Karsten's colour-source tables: a colour you want to cast on curve deserves a share of your mana sources at least as large as its share of your pips, and double-pip costs ({U}{U}) want noticeably more. His tables give the exact counts for a 99-card deck; treat them as a guideline for Commander, not a rule.",
};

// ---------------------------------------------------------------- mana costs

/** The cost the deck list casts: the front half of a split / two-faced cost. */
export function frontCost(manaCost: string): string {
  return (manaCost.split(" // ")[0] ?? "").trim();
}

/** Mana value of a cost string by the rules: numbers add, X/Y/Z are 0, {2/W} is 2, every other symbol is 1. */
export function manaValueOf(cost: string): number {
  let mv = 0;
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const sym = (m[1] ?? "").toUpperCase();
    if (/^\d+$/.test(sym)) mv += Number(sym);
    else if (/^[XYZ]$/.test(sym)) continue;
    else if (/^\d+\/[WUBRG]$/.test(sym)) mv += Number(sym.split("/")[0]);
    else if (sym === "½") mv += 0.5;
    else mv += 1;
  }
  return mv;
}

/** Mana value used everywhere in the stats: parsed from the front cost; Scryfall's cmc when there is no cost. */
export function cardManaValue(card: AnalysisCard): number {
  const cost = frontCost(card.manaCost);
  if (!cost) return isLand(card) ? 0 : card.cmc;
  return manaValueOf(cost);
}

export interface SymbolPips {
  colored: Record<PipColor, number>;
  generic: number;
  hybrid: number;
  phyrexian: number;
  hasX: boolean;
}

function emptyPips(): Record<PipColor, number> {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

/**
 * Pips in one cost. Hybrid two-colour symbols add 0.5 to each colour; {2/W} and
 * Phyrexian {W/P} count as one pip of their colour; {C} is its own column; {S}
 * (snow) is generic because any mana type pays it.
 */
export function pipsOf(cost: string): SymbolPips {
  const out: SymbolPips = { colored: emptyPips(), generic: 0, hybrid: 0, phyrexian: 0, hasX: false };
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const sym = (m[1] ?? "").toUpperCase();
    if (/^\d+$/.test(sym)) {
      out.generic += Number(sym);
      continue;
    }
    if (/^[XYZ]$/.test(sym)) {
      out.hasX = true;
      continue;
    }
    if (sym === "C") {
      out.colored.C += 1;
      continue;
    }
    if (sym === "S") {
      out.generic += 1;
      continue;
    }
    const parts = sym.split("/");
    const colors = parts.filter((p): p is WubrgColor => (WUBRG as readonly string[]).includes(p));
    if (colors.length === 0) continue;
    if (parts.includes("P")) out.phyrexian += 1;
    if (colors.length >= 2) {
      out.hybrid += 1;
      for (const c of colors) out.colored[c] += 1 / colors.length;
    } else {
      out.colored[colors[0]!] += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- curve + totals

export function manaCurve(cards: AnalysisCard[]): CurveBucket[] {
  const buckets: CurveBucket[] = ([0, 1, 2, 3, 4, 5, 6, 7] as const).map((value) => ({ value, nonland: 0, lands: 0 }));
  for (const c of expanded(cards)) {
    const mv = Math.min(7, Math.max(0, Math.floor(cardManaValue(c))));
    const b = buckets[mv]!;
    if (isLand(c)) b.lands += 1;
    else b.nonland += 1;
  }
  return buckets;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function manaValueTotals(cards: AnalysisCard[]): ManaValueTotals {
  const all = expanded(cards);
  const nonland = all.filter((c) => !isLand(c));
  const nonlandTotal = nonland.reduce((s, c) => s + cardManaValue(c), 0);
  const total = all.reduce((s, c) => s + cardManaValue(c), 0);
  return {
    total: round2(total),
    nonlandTotal: round2(nonlandTotal),
    nonlandCount: nonland.length,
    landCount: all.length - nonland.length,
    cardCount: all.length,
    averageNonland: nonland.length ? round2(nonlandTotal / nonland.length) : 0,
    averageAll: all.length ? round2(total / all.length) : 0,
  };
}

export function pipCounts(cards: AnalysisCard[]): PipCounts {
  const colored = emptyPips();
  let generic = 0;
  let hybridSymbols = 0;
  let phyrexianSymbols = 0;
  const xNames = new Set<string>();
  let xSpells = 0;
  for (const c of expanded(cards)) {
    const p = pipsOf(frontCost(c.manaCost));
    for (const k of PIP_COLORS) colored[k] += p.colored[k];
    generic += p.generic;
    hybridSymbols += p.hybrid;
    phyrexianSymbols += p.phyrexian;
    if (p.hasX) {
      xSpells += 1;
      xNames.add(c.name);
    }
  }
  for (const k of PIP_COLORS) colored[k] = round2(colored[k]);
  return {
    colored,
    coloredTotal: round2(PIP_COLORS.reduce((s, k) => s + colored[k], 0)),
    generic,
    hybridSymbols,
    phyrexianSymbols,
    xSpells,
    xSpellNames: [...xNames].sort(),
  };
}

// ---------------------------------------------------------------- mana production

const BASIC_TYPES: Array<[RegExp, WubrgColor]> = [
  [/\bplains\b/, "W"],
  [/\bisland\b/, "U"],
  [/\bswamp\b/, "B"],
  [/\bmountain\b/, "R"],
  [/\bforest\b/, "G"],
];

const ANY_COLOR =
  /\badd (?:one|two|three|x|an amount of|that much) mana (?:of any (?:one )?color|in any combination of colors)\b|\badd (?:one|two) mana of any color\b|\badd (?:one|two|three) mana of (?:that|the chosen) color\b|\badd one mana of any type\b|\badd one mana of any color (?:that|a land)\b/;
const FETCH_LAND = /\bsearch your library for (?:a|an|up to \w+) ([^.;]*?)cards?\b/;

/** Raw lower-cased text WITH reminder text: basic lands only say "({T}: Add {G}.)" in parentheses. */
function rawText(card: AnalysisCard): string {
  return card.oracleText.toLowerCase();
}

/**
 * What a permanent can produce. Lands by basic land type and "Add" text (fetch
 * lands by what they fetch), artifacts / creatures / other permanents by "Add"
 * text. Instants and sorceries (rituals) and one-shot token makers are not
 * sources. Returns null when the card produces nothing.
 */
export function manaSource(card: AnalysisCard): ManaSourceCard | null {
  if (isInstantOrSorcery(card) && !isLand(card)) return null;
  // Lands keep their reminder text (a basic's only text is "({T}: Add {G}.)"); other cards drop it so
  // Treasure reminders ("Sacrifice this artifact: Add one mana of any color") do not count.
  const t = isLand(card) ? rawText(card) : text(card);
  const tl = card.typeLine.toLowerCase().split(" // ")[0] ?? "";
  const produces = new Set<PipColor | "any">();

  if (isLand(card)) for (const [re, color] of BASIC_TYPES) if (re.test(tl)) produces.add(color);

  // "Add {G}", "Add {G} or {W}", "Add {C}{C}", "Add {R}, {G}, or {W}".
  for (const m of t.matchAll(/\badd ((?:\{[wubrgc](?:\/[wubrgc])?\}(?:,? ?(?:or )?)?)+)/g)) {
    for (const s of (m[1] ?? "").matchAll(/\{([wubrgc])(?:\/([wubrgc]))?\}/g)) {
      produces.add(s[1]!.toUpperCase() as PipColor);
      if (s[2]) produces.add(s[2].toUpperCase() as PipColor);
    }
  }
  if (ANY_COLOR.test(t)) produces.add("any");

  // Fetch lands: Evolving Wilds ("a basic land card") -> any; Misty Rainforest ("Forest or Island card") -> G, U.
  if (isLand(card)) {
    const m = FETCH_LAND.exec(t);
    if (m) {
      const phrase = m[1] ?? "";
      let found = false;
      for (const [re, color] of BASIC_TYPES) {
        if (re.test(phrase)) {
          produces.add(color);
          found = true;
        }
      }
      // "a basic land card" / "a land card" with no type named: whatever the deck's basics are.
      if (!found && /\bland\b/.test(phrase)) produces.add("any");
    }
  }

  if (produces.size === 0) return null;
  const kind: SourceKind = isLand(card) ? "land" : isCreature(card) ? "dork" : isArtifact(card) ? "rock" : "other";
  const order: Array<PipColor | "any"> = [...PIP_COLORS, "any"];
  return { name: card.name, quantity: Math.max(1, card.quantity), kind, produces: order.filter((c) => produces.has(c)) };
}

/** Commander colour identity when there is a commander, else the colours of the nonland cards, in WUBRG order. */
export function deckIdentity(cards: AnalysisCard[]): WubrgColor[] {
  const commanders = cards.filter((c) => c.board === "commander");
  const set = new Set<string>();
  if (commanders.length) for (const c of commanders) for (const k of c.colorIdentity) set.add(k.toUpperCase());
  else for (const c of cards) if (!isLand(c)) for (const k of c.colors) set.add(k.toUpperCase());
  return WUBRG.filter((c) => set.has(c));
}

function sourceNote(color: PipColor, pips: number, sources: number, pipShare: number, sourceShare: number, identity: WubrgColor[]): string {
  const name = color === "C" ? "colourless" : { W: "white", U: "blue", B: "black", R: "red", G: "green" }[color];
  if (pips === 0 && sources === 0) return "";
  if (pips === 0) return `${sources} ${name} source${sources === 1 ? "" : "s"} and nothing that needs it.`;
  if (sources === 0) return `${pips} ${name} pip${pips === 1 ? "" : "s"} and no way to make ${name} mana.`;
  if (color !== "C" && !identity.includes(color)) return `${name[0]!.toUpperCase()}${name.slice(1)} is outside the commander's colour identity.`;
  const gap = sourceShare - pipShare;
  const ratio = (sources / pips).toFixed(1);
  if (gap < -0.08) return `Light on ${name}: ${Math.round(sourceShare * 100)}% of sources for ${Math.round(pipShare * 100)}% of pips (${ratio} sources per pip).`;
  if (gap > 0.1) return `Generous on ${name}: ${Math.round(sourceShare * 100)}% of sources for ${Math.round(pipShare * 100)}% of pips (${ratio} sources per pip).`;
  return `In proportion: ${Math.round(sourceShare * 100)}% of sources for ${Math.round(pipShare * 100)}% of pips (${ratio} sources per pip).`;
}

export function manaProduction(cards: AnalysisCard[], pips: PipCounts): ManaProduction {
  const identity = deckIdentity(cards);
  const sourceCards: ManaSourceCard[] = [];
  const perColor: Record<PipColor, Record<SourceKind, number>> = {
    W: { land: 0, rock: 0, dork: 0, other: 0 },
    U: { land: 0, rock: 0, dork: 0, other: 0 },
    B: { land: 0, rock: 0, dork: 0, other: 0 },
    R: { land: 0, rock: 0, dork: 0, other: 0 },
    G: { land: 0, rock: 0, dork: 0, other: 0 },
    C: { land: 0, rock: 0, dork: 0, other: 0 },
  };
  const byKind: Record<SourceKind, number> = { land: 0, rock: 0, dork: 0, other: 0 };
  let anyColorSources = 0;
  let totalSources = 0;

  // One entry per name (quantity summed) for the list; counts use quantities.
  const byName = new Map<string, ManaSourceCard>();
  for (const c of cards) {
    const s = manaSource(c);
    if (!s) continue;
    const prev = byName.get(s.name);
    if (prev) prev.quantity += s.quantity;
    else byName.set(s.name, s);
  }
  for (const s of byName.values()) {
    sourceCards.push(s);
    byKind[s.kind] += s.quantity;
    totalSources += s.quantity;
    const colors = new Set<PipColor>();
    for (const p of s.produces) {
      if (p === "any") {
        anyColorSources += s.quantity;
        for (const c of identity) colors.add(c);
      } else colors.add(p);
    }
    for (const c of colors) perColor[c][s.kind] += s.quantity;
  }
  sourceCards.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  const sourcesFor = (c: PipColor) => perColor[c].land + perColor[c].rock + perColor[c].dork + perColor[c].other;
  const coloredPipTotal = WUBRG.reduce((s, c) => s + pips.colored[c], 0);
  const coloredSourceTotal = WUBRG.reduce((s, c) => s + sourcesFor(c), 0);
  const rows: ColorSourceRow[] = PIP_COLORS.filter((c) => pips.colored[c] > 0 || sourcesFor(c) > 0).map((color) => {
    const p = pips.colored[color];
    const s = sourcesFor(color);
    const pipShare = color === "C" || coloredPipTotal === 0 ? 0 : p / coloredPipTotal;
    const sourceShare = color === "C" || coloredSourceTotal === 0 ? 0 : s / coloredSourceTotal;
    return {
      color,
      pips: p,
      sources: s,
      byKind: perColor[color],
      ratio: p > 0 ? round2(s / p) : null,
      pipShare: round2(pipShare),
      sourceShare: round2(sourceShare),
      note: sourceNote(color, p, s, pipShare, sourceShare, identity),
    };
  });

  const colourWord = identity.length === 0 ? "colourless" : identity.length === 1 ? "one-colour" : `${identity.length}-colour`;
  const lightColours = rows.filter((r) => r.color !== "C" && r.pips > 0 && identity.includes(r.color as WubrgColor) && r.sourceShare - r.pipShare < -0.08).map((r) => r.color);
  const summary =
    `${totalSources} mana source${totalSources === 1 ? "" : "s"} in this ${colourWord} deck: ${byKind.land} land${byKind.land === 1 ? "" : "s"}, ${byKind.rock} rock${byKind.rock === 1 ? "" : "s"}, ${byKind.dork} dork${byKind.dork === 1 ? "" : "s"}` +
    (byKind.other ? `, ${byKind.other} other` : "") +
    `; ${anyColorSources} of them make any colour. ` +
    (lightColours.length ? `Light on ${lightColours.join(" and ")} relative to the pips.` : identity.length ? "Colour sources are roughly in proportion to the pips." : "");

  return { rows, identity, anyColorSources, totalSources, byKind, cards: sourceCards, summary, guideline: KARSTEN };
}

// ---------------------------------------------------------------- breakdowns

const TYPE_RES: Record<CardTypeKey, RegExp> = {
  creature: /\bcreature\b/,
  instant: /\binstant\b/,
  sorcery: /\bsorcery\b/,
  artifact: /\bartifact\b/,
  enchantment: /\benchantment\b/,
  planeswalker: /\bplaneswalker\b/,
  battle: /\bbattle\b/,
  land: /\bland\b/,
};

const TOKEN_MAKER = /(?<!would )\bcreates? (?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|that many|\d+|a number of|one or more) (?:[^.]*?\b)?tokens?\b/; // "would create" / "creates twice that many" (doublers) are excluded

function numeric(v: string | null): number | null {
  if (v === null) return null;
  return /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : null;
}

export function breakdowns(cards: AnalysisCard[], pips: PipCounts): Breakdowns {
  const all = expanded(cards);
  const types: Record<CardTypeKey, number> = { creature: 0, instant: 0, sorcery: 0, artifact: 0, enchantment: 0, planeswalker: 0, battle: 0, land: 0 };
  const colors: Record<WubrgColor, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let multicolor = 0;
  let colorless = 0;
  let basic = 0;
  let creatures = 0;
  let powerSum = 0;
  let toughnessSum = 0;
  let numericPT = 0;
  let nonNumeric = 0;
  const tokenNames = new Set<string>();
  let tokenMakers = 0;

  for (const c of all) {
    const front = c.typeLine.toLowerCase().split(" // ")[0] ?? "";
    for (const k of CARD_TYPE_KEYS) if (TYPE_RES[k].test(front)) types[k] += 1;
    if (isLand(c)) {
      if (/\bbasic\b/.test(front)) basic += 1;
    } else {
      const cs = c.colors.map((x) => x.toUpperCase()).filter((x): x is WubrgColor => (WUBRG as readonly string[]).includes(x));
      if (cs.length === 0) colorless += 1;
      if (cs.length >= 2) multicolor += 1;
      for (const k of cs) colors[k] += 1;
    }
    if (TYPE_RES.creature.test(front)) {
      creatures += 1;
      const p = numeric(c.power);
      const t = numeric(c.toughness);
      if (p !== null && t !== null) {
        powerSum += p;
        toughnessSum += t;
        numericPT += 1;
      } else nonNumeric += 1;
    }
    if (TOKEN_MAKER.test(text(c))) {
      tokenMakers += 1;
      tokenNames.add(c.name);
    }
  }
  const landTotal = types.land;
  return {
    types,
    colors,
    multicolor,
    colorless,
    lands: { total: landTotal, basic, nonbasic: landTotal - basic },
    creatures: {
      count: creatures,
      averagePower: numericPT ? round2(powerSum / numericPT) : null,
      averageToughness: numericPT ? round2(toughnessSum / numericPT) : null,
      nonNumeric,
    },
    xSpells: pips.xSpells,
    tokenMakers: { count: tokenMakers, names: [...tokenNames].sort() },
  };
}

// ---------------------------------------------------------------- functional counts

const FINDERS: Record<FunctionalKey, (cards: AnalysisCard[]) => Hit[]> = {
  ramp: findRamp,
  draw: findCardDraw,
  removal: findRemoval,
  wipes: findBoardWipes,
  counterspells: findCounterspells,
  tutors: findTutors,
  recursion: findRecursion,
  protection: findProtection,
};

export function functionalCounts(cards: AnalysisCard[]): FunctionalCount[] {
  const out: FunctionalCount[] = [];
  for (const key of Object.keys(FINDERS) as FunctionalKey[]) {
    const hits = FINDERS[key](cards).sort((a, b) => a.name.localeCompare(b.name));
    out.push({ key, count: hits.reduce((n, h) => n + h.quantity, 0), cards: hits.map((h) => ({ name: h.name, quantity: h.quantity })) });
  }
  return out;
}

// ---------------------------------------------------------------- everything

export function computeStats(cards: AnalysisCard[], now: Date = new Date()): DeckStats {
  const pips = pipCounts(cards);
  return {
    curve: manaCurve(cards),
    manaValue: manaValueTotals(cards),
    pips,
    production: manaProduction(cards, pips),
    breakdowns: breakdowns(cards, pips),
    functional: functionalCounts(cards),
    commanders: cards.filter((c) => c.board === "commander").map((c) => c.name),
    computedAt: now.toISOString(),
  };
}
