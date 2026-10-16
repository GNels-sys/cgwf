import { expanded, isArtifact, isCreature, isLand, text, type AnalysisCard } from "./cards.js";
import { detectTutors } from "./tutors.js";

/**
 * Functional role detectors: the counts deck sites show (ramp, draw, removal,
 * wipes, counterspells, tutors, recursion, protection). All are regex
 * heuristics over Scryfall's Oracle wording (reminder text stripped, the card's
 * own name as "~"). Each returns the matched cards, one entry per name with its
 * quantity, so the UI can show what was counted and the reader can disagree.
 *
 * Phase 6's `countRamp` / `countCardDraw` / `countInteraction` (fastMana.ts) are
 * thin wrappers over these so the bracket summary and the stats panel agree.
 */
export interface Hit {
  name: string;
  quantity: number;
}

function collect(cards: AnalysisCard[], matches: (card: AnalysisCard, t: string) => boolean): Hit[] {
  const out = new Map<string, Hit>();
  for (const c of cards) {
    if (!matches(c, text(c))) continue;
    const prev = out.get(c.name);
    if (prev) prev.quantity += Math.max(1, c.quantity);
    else out.set(c.name, { name: c.name, quantity: Math.max(1, c.quantity) });
  }
  return [...out.values()];
}

export function hitCount(hits: Hit[]): number {
  return hits.reduce((n, h) => n + h.quantity, 0);
}

/** Cheap rocks and dorks plus land ramp (fetch a land, put a land onto the battlefield, extra land drops). */
export function findRamp(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (c, t) => {
    if (isLand(c)) return false;
    if (c.cmc <= 3 && (isArtifact(c) || isCreature(c)) && /(?:\{t\}|\{q\}|: ?)add \{|\badd one mana of any color\b|\badd \{[wubrgc]\}/.test(t)) return true;
    if (/\bsearch your library for (?:a|up to \w+|two|three) (?:basic )?(?:land|forest|plains|island|swamp|mountain)/.test(t)) return true;
    if (/\bput (?:a|that|target|up to \w+) (?:basic )?land cards? (?:from (?:your hand|your graveyard|among them) )?onto the battlefield\b/.test(t)) return true;
    if (/\byou may play an additional land\b/.test(t)) return true;
    return false;
  });
}

const DRAW = /\bdraw (?:a card|two cards|three cards|four cards|x cards|that many cards|cards equal to|a card for each)\b/;
const NOT_OURS = /\b(?:each|target|that|an) (?:opponent|player) draws?\b|\beach player draws\b|\bits controller draws\b/;
const IMPULSE = /\bexile the top (?:card|two cards|three cards|x cards|\w+ cards) of your library\b[^.]*\b(?:you may (?:play|cast)|until (?:the end of your next turn|end of turn))/;

/** Card draw and impulse draw ("exile the top card ... you may play it"), plus Investigate. */
export function findCardDraw(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (_c, t) => (DRAW.test(t) && !NOT_OURS.test(t)) || IMPULSE.test(t) || /\binvestigate\b/.test(t));
}

const TARGETS = "(?:creature|nonland permanent|noncreature permanent|permanent|artifact|enchantment|artifact or enchantment|creature or planeswalker|creature or enchantment|artifact, enchantment, or creature|planeswalker|land|nonbasic land|spell)";
const REMOVAL_DESTROY = new RegExp(`\\b(?:destroy|exile) (?:target|up to \\w+ target|another target|any number of target) [a-z]*\\s?${TARGETS}`);
const REMOVAL_DAMAGE = /\bdeals? (?:\d+|x) damage to (?:any target|target creature|target creature or planeswalker|target creature or player|target creature an opponent controls|that creature)\b/;
const REMOVAL_BOUNCE = /\breturn target (?:creature|nonland permanent|permanent|artifact|enchantment) (?:(?:an opponent controls|you don't control) )?to its owner's hand\b/;
const REMOVAL_SHRINK = /\btarget creature gets -\d+\/-\d+\b/;
const REMOVAL_EDICT = /\b(?:target|each) (?:opponent|player) sacrifices (?:a|two|three) creatures?\b/;
const REMOVAL_FIGHT = /\btarget creature you control fights\b|\bfights target creature\b|\bdeals damage equal to its power to target creature\b/;
const REMOVAL_EXILE_UNTIL = /\bexile target (?:creature|nonland permanent|permanent|artifact)[^.]*\buntil\b/;

/** Targeted removal: destroy/exile/bounce/shrink/edict/fight/burn one thing. */
export function findRemoval(cards: AnalysisCard[]): Hit[] {
  return collect(
    cards,
    (_c, t) =>
      REMOVAL_DESTROY.test(t) || REMOVAL_DAMAGE.test(t) || REMOVAL_BOUNCE.test(t) || REMOVAL_SHRINK.test(t) || REMOVAL_EDICT.test(t) || REMOVAL_FIGHT.test(t) || REMOVAL_EXILE_UNTIL.test(t),
  );
}

const WIPE_ALL = /\b(?:destroy|exile) (?:all|each) (?:other )?(?:[a-z]+ )?(?:creatures|nonland permanents|permanents|artifacts|enchantments|artifacts and enchantments|artifacts, creatures, and lands|planeswalkers|creatures and planeswalkers)\b/;
const WIPE_DAMAGE = /\bdeals? (?:\d+|x) damage to each (?:creature|creature and each player|creature and each planeswalker|creature and each opponent|nonland permanent)\b/;
const WIPE_SAC = /\beach player sacrifices (?:all|each) (?:[a-z]+ )?(?:creatures|permanents|nonland permanents|artifacts|enchantments)\b/;
const WIPE_SHRINK = /\b(?:all|each) creatures? gets? -(?:\d+|x)\/-(?:\d+|x)\b/;
const WIPE_BOUNCE = /\breturn (?:all|each) (?:[a-z]+ )?(?:creatures|nonland permanents|permanents) to their owners' hands\b/;
const WIPE_CHOOSE = /\beach player chooses [^.]* then sacrifices the rest\b/;

/** Board wipes: everything-of-a-kind removal. Mass land denial (Armageddon) is not a wipe here. */
export function findBoardWipes(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (_c, t) => {
    if (/\b(?:destroy|exile) all lands\b/.test(t) && !/\bcreatures\b/.test(t)) return false;
    return WIPE_ALL.test(t) || WIPE_DAMAGE.test(t) || WIPE_SAC.test(t) || WIPE_SHRINK.test(t) || WIPE_BOUNCE.test(t) || WIPE_CHOOSE.test(t);
  });
}

const COUNTER = /\bcounter target (?:spell|creature spell|noncreature spell|instant or sorcery spell|activated or triggered ability|activated ability|triggered ability|spell or ability|spell that targets)\b/;

export function findCounterspells(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (_c, t) => COUNTER.test(t));
}

/** Tutors as Phase 6 defines them (land-only searches are ramp, "cards named X" ignored). */
export function findTutors(cards: AnalysisCard[]): Hit[] {
  const out = new Map<string, Hit>();
  for (const h of detectTutors(cards).cards) {
    const prev = out.get(h.name);
    if (prev) prev.quantity += 1;
    else out.set(h.name, { name: h.name, quantity: 1 });
  }
  return [...out.values()];
}

const RECURSION_RETURN = /\b(?:return|put) (?:target|up to \w+ target|all|each|that|a|an|another target|any number of target|x target) [^.]*?\bfrom (?:your|a|all|each) graveyards? (?:to|onto|on) (?:your hand|the battlefield|the top of your library)\b/;
const RECURSION_SELF = /\breturn ~ from your graveyard to (?:your hand|the battlefield)\b/;
const RECURSION_CAST = /\byou may cast (?:target|up to \w+ target|that|~) [^.]*?\bfrom your graveyard\b|\bcast ~ from your graveyard\b/;
const RECURSION_PLAY = /\byou may play (?:lands?|cards?) from your graveyard\b/;

/** Graveyard recursion: anything that returns cards from a graveyard to hand, battlefield or library top, or lets you cast from it. */
export function findRecursion(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (c, t) => {
    if (RECURSION_RETURN.test(t) || RECURSION_SELF.test(t) || RECURSION_CAST.test(t) || RECURSION_PLAY.test(t)) return true;
    return c.keywords.some((k) => /^(?:unearth|escape|embalm|eternalize)$/i.test(k));
  });
}

const PROTECT_GRANT = /\b(?:gains?|have|has|get|gets) (?:[^.]{0,60}?\b)?(?:hexproof|indestructible|shroud|protection from)\b/;
const PROTECT_REGEN = /\bregenerate (?:target|~|each|all|another target)\b/;
const PROTECT_PHASE = /\bphases? out\b/;
const PROTECT_COUNTER_TARGET = /\bcounter target spell (?:or ability )?that targets\b/;
const PROTECT_PREVENT = /\bprevent all (?:combat )?damage that would be dealt (?:to|this turn)\b/;
const PROTECT_BLINK_SAVE = /\bexile (?:target|another target) (?:creature|nonland permanent|permanent) you (?:control|own)[^.]*\breturn (?:it|that card) to the battlefield\b/;
const PROTECT_FLASH_RETURN = /\breturn (?:target|another target) (?:creature|permanent) you control to its owner's hand\b/;

/** Protection: granting hexproof/indestructible/shroud/protection, regeneration, phasing, redirect counters, fogs, blink-to-save. */
export function findProtection(cards: AnalysisCard[]): Hit[] {
  return collect(cards, (_c, t) => {
    if (PROTECT_GRANT.test(t)) {
      // "~ has hexproof as long as" style self-protection on a permanent is not interaction; keep it only
      // when the grant targets or covers other permanents.
      if (!/\b(?:target|you control|you own|creatures you|permanents you|other)\b/.test(t)) return false;
      return true;
    }
    return PROTECT_REGEN.test(t) || PROTECT_PHASE.test(t) || PROTECT_COUNTER_TARGET.test(t) || PROTECT_PREVENT.test(t) || PROTECT_BLINK_SAVE.test(t) || PROTECT_FLASH_RETURN.test(t);
  });
}

/** Phase 6's "interaction" = removal + counterspells (kept for the bracket summary). */
export function findInteraction(cards: AnalysisCard[]): Hit[] {
  const out = new Map<string, Hit>();
  for (const h of [...findRemoval(cards), ...findCounterspells(cards)]) {
    if (!out.has(h.name)) out.set(h.name, { ...h });
  }
  return [...out.values()];
}

/** Count duplicates honestly: a hit list over `expanded(cards)` is what the counts mean. */
export function expandedHits(cards: AnalysisCard[], finder: (cards: AnalysisCard[]) => Hit[]): Hit[] {
  return finder(expanded(cards).map((c) => ({ ...c, quantity: 1 })));
}
