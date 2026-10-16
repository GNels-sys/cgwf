import type { ArchetypeHit, ArchetypeTag } from "@cgwf/shared";
import { creatureSubtypes, expanded, hasKeyword, isArtifact, isCreature, isEnchantment, isInstantOrSorcery, isLand, text, type AnalysisCard } from "./cards.js";

/**
 * Archetype / strategy tags from card text and type heuristics. Each tag has
 * weighted signals; the score divided by the tag's threshold is its confidence
 * (capped at 1). Commanders count double because they define the deck.
 * This is deliberately simple and explainable: every tag lists its evidence.
 */
interface Signal {
  re: RegExp;
  weight: number;
}

const TEXT_SIGNALS: Record<ArchetypeTag, Signal[]> = {
  tokens: [
    { re: /\bcreate (?:a|an|two|three|four|x|that many|\d+) [^.]*\btokens?\b/, weight: 1 },
    { re: /\btokens? you control (?:get|have)\b/, weight: 1.5 },
    { re: /\bfor each (?:creature )?token\b/, weight: 1 },
    { re: /\bpopulate\b/, weight: 1 },
    { re: /\bwhenever (?:a|one or more) (?:creature )?tokens? (?:enters|you control enters|are created)/, weight: 1.5 },
  ],
  counters: [
    { re: /\+1\/\+1 counters?\b/, weight: 1 },
    { re: /\bproliferate\b/, weight: 1.5 },
    { re: /\bdouble the number of (?:\+1\/\+1 )?counters\b/, weight: 2 },
    { re: /\bwhenever one or more \+1\/\+1 counters are put\b/, weight: 1.5 },
  ],
  aristocrats: [
    { re: /\bsacrifice (?:a|another|target|x) creatures?\b/, weight: 1 },
    { re: /\bwhenever (?:a|another|~ or another) creature (?:you control )?dies\b/, weight: 1.5 },
    { re: /\bwhenever (?:you sacrifice|a player sacrifices)\b/, weight: 1.5 },
    { re: /\bexploit\b/, weight: 1 },
    { re: /\bafterlife\b/, weight: 0.7 },
    { re: /\beach opponent loses 1 life\b/, weight: 0.5 },
  ],
  voltron: [
    { re: /\bequip \{/, weight: 1 },
    { re: /\benchant creature\b/, weight: 0.7 },
    { re: /\bwhenever (?:equipped|enchanted) creature (?:attacks|deals combat damage)\b/, weight: 1 },
    { re: /\bwhenever ~ deals combat damage to a player\b/, weight: 0.5 },
    { re: /\battach (?:it|target equipment|all equipment)\b/, weight: 1 },
    { re: /\bdouble strike\b/, weight: 0.5 },
    { re: /\bequipment you control\b|\bauras? you control\b|\bauras? (?:attached|you cast)/, weight: 1 },
  ],
  spellslinger: [
    { re: /\bwhenever you cast (?:an instant or sorcery|a noncreature|an instant|a sorcery) spell\b/, weight: 2 },
    { re: /\bmagecraft\b/, weight: 1.5 },
    { re: /\bprowess\b/, weight: 0.7 },
    { re: /\bcopy (?:target|that|the next) (?:instant or sorcery |instant |sorcery )?spell\b/, weight: 1 },
    { re: /\binstant and sorcery (?:spells|cards)\b/, weight: 1 },
  ],
  reanimator: [
    { re: /\breturn (?:target|up to \w+ target|all|each|that) (?:[a-z]+ )*creature cards? from (?:a|your|all|each) graveyards? to the battlefield\b/, weight: 2 },
    { re: /\bput (?:a|target|that|each|all) (?:[a-z]+ )*creature cards? from (?:a|your|each|all) graveyards? onto the battlefield\b/, weight: 2 },
    { re: /\breturn target (?:[a-z]+ )*(?:permanent|creature or planeswalker) card from your graveyard to the battlefield\b/, weight: 2 },
    { re: /\bsearch your library for a card[^.]*put (?:it|that card) into your graveyard\b/, weight: 1.5 },
    { re: /\bdiscard (?:a|two|x) cards?\b/, weight: 0.3 },
    { re: /\bmill (?:two|three|four|five|six|x|\d+) cards\b/, weight: 0.5 },
    { re: /\bunearth\b|\bpersist\b|\bundying\b/, weight: 0.5 },
  ],
  lands: [
    { re: /\blandfall\b/, weight: 2 },
    { re: /\bwhenever a land (?:you control )?enters\b/, weight: 2 },
    { re: /\bplay (?:an additional|two additional) lands?\b/, weight: 1 },
    { re: /\b(?:put|return) (?:a|target|that|up to \w+) (?:[a-z]+ )*land cards? from your graveyard (?:onto the battlefield|to (?:your hand|the battlefield))\b/, weight: 1.5 },
    { re: /\byou may play lands? from your graveyard\b/, weight: 2 },
    { re: /\bsacrifice a land\b/, weight: 0.5 },
    { re: /\bfor each land you control\b/, weight: 0.7 },
  ],
  artifacts: [
    { re: /\bwhenever (?:an|another|one or more) artifacts? (?:you control )?enters?\b/, weight: 2 },
    { re: /\baffinity for artifacts\b/, weight: 1 },
    { re: /\bimprovise\b/, weight: 1 },
    { re: /\bmetalcraft\b/, weight: 1.5 },
    { re: /\bartifacts? you control\b/, weight: 0.5 },
    { re: /\bfor each artifact\b/, weight: 1 },
    { re: /\bwhenever you cast an artifact spell\b/, weight: 1.5 },
  ],
  enchantress: [
    { re: /\bwhenever you cast an enchantment spell\b/, weight: 2 },
    { re: /\bwhenever (?:an|another) enchantment (?:you control )?enters\b/, weight: 2 },
    { re: /\bconstellation\b/, weight: 1.5 },
    { re: /\benchantments? you control\b/, weight: 0.5 },
    { re: /\bfor each enchantment\b/, weight: 1 },
  ],
  stax: [
    { re: /\bcan't untap\b/, weight: 1 },
    { re: /\bplayers? can't cast more than one spell\b|\beach player can't cast more than one spell\b/, weight: 1.5 },
    { re: /\bspells? cost \{\d\} more to cast\b/, weight: 1.5 },
    { re: /\b(?:opponents|players|your opponents) can't (?:search|draw more than|cast spells|untap|gain life|activate|play)\b/, weight: 1 },
    { re: /\bskip (?:their|your|each player's) untap steps?\b/, weight: 1.5 },
    { re: /\bcreatures? can't attack you\b/, weight: 0.5 },
    { re: /\bactivated abilities (?:of [a-z]+ )?(?:cost \{\d\} more|can't be activated)\b/, weight: 1 },
    { re: /\bnoncreature spells (?:cost|each cost)\b/, weight: 1 },
  ],
  group_hug: [
    { re: /\beach player (?:draws|may draw)\b/, weight: 1.2 },
    { re: /\beach player (?:gains|may search|may put|may play an additional)\b/, weight: 1.2 },
    { re: /\btarget (?:player|opponent) (?:draws|gains|may)\b/, weight: 0.5 },
    { re: /\ball players\b/, weight: 0.5 },
    { re: /\bany number of target players\b/, weight: 0.8 },
  ],
  control: [
    { re: /\bcounter target (?:spell|creature spell|noncreature spell|instant or sorcery spell)\b/, weight: 1 },
    { re: /\b(?:destroy|exile) all (?:creatures|nonland permanents|other creatures)\b/, weight: 1.5 },
    { re: /\beach creature (?:gets -|deals damage to itself)\b|\bdeals \d+ damage to each creature\b/, weight: 1.2 },
    { re: /\b(?:destroy|exile) target (?:creature|nonland permanent|permanent|artifact or enchantment|creature or planeswalker)\b/, weight: 0.6 },
  ],
  combo: [
    { re: /\byou win the game\b/, weight: 1.5 },
    { re: /\bif you would draw a card while your library has no cards\b/, weight: 2 },
    { re: /\buntap (?:target|all|each) (?:permanent|artifact|creature|nonland permanent)s?\b/, weight: 0.3 },
    { re: /\binfinite\b/, weight: 1 },
  ],
  aggro: [
    { re: /\bwhenever (?:~|a creature you control|one or more creatures you control) attacks?\b/, weight: 1 },
    { re: /\bcreatures you control get \+\d\/\+\d\b/, weight: 1 },
    { re: /\badditional combat phase\b|\bextra combat\b/, weight: 1.5 },
    { re: /\bcan't block\b/, weight: 0.5 },
    { re: /\bhaste\b/, weight: 0.4 },
  ],
  tribal: [{ re: /\b(?:[a-z]+) creatures you control get \+1\/\+1\b/, weight: 1 }],
  blink: [
    { re: /\bexile (?:target|another target|up to \w+ target) (?:[a-z]+ )*(?:creature|permanent|nonland permanent)s? you (?:control|own)[^.]*\breturn (?:it|them|that card|those cards) to the battlefield\b/, weight: 2 },
    { re: /\bexile (?:~|it|that creature)[^.]*\breturn (?:it|that card) to the battlefield under (?:its|your|their) owner's control\b/, weight: 1.2 },
    { re: /\bwhenever (?:~|a creature|another creature|a permanent) (?:you control )?enters\b/, weight: 0.4 },
    { re: /\bflicker\b|\bblink\b/, weight: 1 },
  ],
  lifegain: [
    { re: /\bwhenever you gain life\b/, weight: 2 },
    { re: /\blifelink\b/, weight: 0.5 },
    { re: /\byou gain (?:x|\d+|that much) life\b/, weight: 0.3 },
    { re: /\bfor each 1 life\b|\bif you have (?:\d+|at least \d+) or more life\b/, weight: 1 },
  ],
  mill: [
    { re: /\b(?:target player|each opponent|target opponent|each player) mills? (?:x|\d+|that many|half)\b/, weight: 1.2 },
    { re: /\bwhenever (?:a|an) (?:player|opponent) mills\b/, weight: 1.5 },
    { re: /\bcards? in (?:their|an opponent's|each opponent's) graveyard\b/, weight: 0.3 },
  ],
  wheels: [
    { re: /\beach player discards (?:their|his or her) hand(?:,? then draws| and draws)\b/, weight: 2 },
    { re: /\bwhenever (?:a player|an opponent) draws a card\b/, weight: 1.2 },
    { re: /\bshuffles? (?:their|his or her) hand (?:and graveyard )?into (?:their|his or her) library, then draws\b/, weight: 2 },
  ],
  big_mana: [
    { re: /\b(?:doubles?|twice) (?:the|that) (?:amount of )?mana\b|\badds? an additional\b.*\bmana\b/, weight: 2 },
    { re: /\badd (?:\{[wubrgc]\}){3,}/, weight: 0.5 },
    { re: /\buntap all lands\b/, weight: 1 },
    { re: /\bfor each (?:land|forest|swamp|island|mountain|plains) you control\b/, weight: 0.7 },
  ],
  theft: [
    { re: /\bgain control of (?:target|that|each|all|up to \w+ target)\b/, weight: 1.5 },
    { re: /\byou may cast (?:spells|that card|it|them|cards) (?:from (?:among|exile|the top)|exiled with)\b/, weight: 0.7 },
    { re: /\b(?:from|of) (?:an opponent's|each opponent's|your opponents'|target player's|that player's) (?:library|graveyard|hand)\b/, weight: 0.8 },
    { re: /\bexile the top card of each (?:opponent's|player's) library\b/, weight: 1 },
  ],
  graveyard: [
    { re: /\bfrom your graveyard\b/, weight: 0.6 },
    { re: /\bdelve\b|\bescape\b|\bflashback\b|\bunearth\b|\bdredge\b|\bdisturb\b|\bembalm\b|\beternalize\b/, weight: 0.6 },
    { re: /\byou mill\b|\bmill (?:two|three|four|five|six|x|\d+) cards\b/, weight: 0.7 },
    { re: /\bfor each (?:creature )?card in your graveyard\b/, weight: 1 },
  ],
  storm: [
    { re: /\bstorm\b/, weight: 3 },
    { re: /\bwhenever you cast your (?:second|third) spell\b|\bspells? you've cast this turn\b|\bfor each (?:other )?spell (?:you've )?cast (?:before it )?this turn\b/, weight: 1.5 },
    { re: /\bcosts? \{\d\} less to cast\b/, weight: 0.3 },
  ],
  politics: [
    { re: /\bgoad\b/, weight: 2 },
    { re: /\bvote\b|\bcouncil's dilemma\b|\bwill of the council\b/, weight: 1.5 },
    { re: /\bmonarch\b|\binitiative\b/, weight: 1 },
    { re: /\btempting offer\b/, weight: 1.5 },
    { re: /\beach opponent (?:may|chooses)\b/, weight: 0.5 },
  ],
};

const THRESHOLDS: Record<ArchetypeTag, number> = {
  tokens: 9,
  counters: 9,
  aristocrats: 8,
  voltron: 8,
  spellslinger: 8,
  reanimator: 7,
  lands: 8,
  artifacts: 9,
  enchantress: 8,
  stax: 7,
  group_hug: 6,
  control: 12,
  combo: 6,
  aggro: 10,
  tribal: 12,
  blink: 7,
  lifegain: 8,
  mill: 7,
  wheels: 5,
  big_mana: 8,
  theft: 6,
  graveyard: 10,
  storm: 7,
  politics: 6,
};

export interface ArchetypeInput {
  cards: AnalysisCard[];
  /** Spellbook combos found (count feeds the "combo" tag). */
  comboCount?: number;
  twoCardComboCount?: number;
}

export function detectArchetypes(input: ArchetypeInput): ArchetypeHit[] {
  const all = expanded(input.cards);
  const scores = new Map<ArchetypeTag, number>();
  const evidence = new Map<ArchetypeTag, Map<string, number>>();
  const bump = (tag: ArchetypeTag, by: number, card?: string) => {
    scores.set(tag, (scores.get(tag) ?? 0) + by);
    if (card) {
      const ev = evidence.get(tag) ?? new Map<string, number>();
      ev.set(card, (ev.get(card) ?? 0) + by);
      evidence.set(tag, ev);
    }
  };

  for (const c of all) {
    const t = text(c).replace(/\s+/g, " ");
    const mult = c.board === "commander" ? 2 : 1;
    for (const tag of Object.keys(TEXT_SIGNALS) as ArchetypeTag[]) {
      for (const s of TEXT_SIGNALS[tag]) if (s.re.test(t)) bump(tag, s.weight * mult, c.name);
    }
    if (hasKeyword(c, "Landfall")) bump("lands", 0.5 * mult, c.name);
    if (hasKeyword(c, "Storm")) bump("storm", 1 * mult, c.name);
    if (hasKeyword(c, "Lifelink")) bump("lifegain", 0.2, c.name);
    if (hasKeyword(c, "Prowess")) bump("spellslinger", 0.3, c.name);
  }

  // Density signals: what the deck is made of, not only what the text says.
  const nonland = all.filter((c) => !isLand(c));
  const count = (pred: (c: AnalysisCard) => boolean) => nonland.filter(pred).length;
  const nInstSorc = count(isInstantOrSorcery);
  const nArt = count((c) => isArtifact(c) && !isCreature(c));
  const nEnch = count((c) => isEnchantment(c) && !isCreature(c));
  const nCreature = count(isCreature);
  const nLands = all.length - nonland.length;
  if (nInstSorc >= 25) bump("spellslinger", 3);
  else if (nInstSorc >= 18) bump("spellslinger", 1.5);
  if (nArt >= 25) bump("artifacts", 3);
  else if (nArt >= 18) bump("artifacts", 1.5);
  if (nEnch >= 20) bump("enchantress", 3);
  else if (nEnch >= 14) bump("enchantress", 1.5);
  if (nLands >= 42) bump("lands", 2);
  const avgCmc = nonland.length ? nonland.reduce((s, c) => s + c.cmc, 0) / nonland.length : 0;
  if (nCreature >= 30 && avgCmc < 3.2) bump("aggro", 2);
  if (count((c) => isCreature(c) && c.cmc >= 7) >= 7) bump("big_mana", 2);
  if (count((c) => /\{x\}/i.test(c.manaCost)) >= 6) bump("big_mana", 1.5);
  if (input.comboCount) bump("combo", Math.min(6, input.comboCount * 1.5));
  if (input.twoCardComboCount) bump("combo", Math.min(4, input.twoCardComboCount * 2));

  // Tribal: the most common creature subtype.
  const subtypeCount = new Map<string, number>();
  for (const c of all) if (isCreature(c)) for (const s of creatureSubtypes(c)) subtypeCount.set(s, (subtypeCount.get(s) ?? 0) + 1);
  let topType: string | null = null;
  let topN = 0;
  for (const [s, n] of subtypeCount) {
    if (n > topN) {
      topType = s;
      topN = n;
    }
  }
  if (topType && topN >= 10) {
    bump("tribal", topN, `${topType} x${topN}`);
    // "Elves you control get +1/+1" style lords and "whenever an Elf enters".
    const re = new RegExp(`\\b${topType.toLowerCase()}s?\\b`);
    for (const c of all) if (re.test(text(c))) bump("tribal", 0.7, c.name);
  }

  const hits: ArchetypeHit[] = [];
  for (const [tag, score] of scores) {
    const confidence = Math.min(1, score / THRESHOLDS[tag]);
    if (confidence < 0.35) continue;
    const ev = [...(evidence.get(tag) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    hits.push({ tag, confidence: Math.round(confidence * 100) / 100, evidence: ev.slice(0, 6) });
  }
  return hits.sort((a, b) => b.confidence - a.confidence).slice(0, 6);
}
