import { text, type AnalysisCard } from "./cards.js";

/**
 * Mass land denial, per the official definition (Feb 2025 article): cards that
 * "destroy, exile, and bounce other lands, keep lands tapped, or change what
 * mana is produced by four or more lands per player without replacing them".
 * Single-target land destruction (Strip Mine) is NOT mass land denial, and
 * neither is a wipe that lets players fetch basics in return (Wave of Vitriol,
 * From the Ashes) or one that spares lands ("except for lands").
 */
const PATTERNS: Array<{ re: RegExp; why: string }> = [
  // Armageddon, Ravages of War, Ruination, Jokulhaups, Obliterate, Decree of Annihilation, Sunder, Boom // Bust
  { re: /\b(destroy|exile|return|sacrifice)s? all\b[^.]*\blands\b/, why: "wipes every land" },
  // Apocalypse, Upheaval, Worldpurge ("permanents" includes lands; "nonland permanents" and "permanents of the color" do not)
  { re: /\b(destroy|exile|return)s? all (?:other |nontoken )?permanents\b(?! (?:of|with|that|named|target|an? ))/, why: "wipes every permanent, lands included" },
  // Wildfire, Destructive Force, Death Cloud, Keldon Firebombers
  { re: /\beach player sacrifices (?:all|four|five|six|seven|eight|x|[4-9]|\d{2,})\b[^.]*\blands\b/, why: "makes every player sacrifice four or more lands" },
  // Cataclysm (lands are among what is kept to one); Balance-style "fewest" is handled below
  { re: /\blands?\b[^.]*\bthen sacrifices the rest\b/, why: "makes every player sacrifice most of their lands" },
  // Hokori, Rising Waters, Back to Basics
  { re: /\blands don't untap during (?:their|its) controllers?'?s?'? untap steps?\b/, why: "keeps lands tapped" },
  // Winter Orb, Static Orb, Stasis
  { re: /\bplayers? can't untap more than (?:one|two) (?:land|permanent)s?\b/, why: "keeps lands tapped" },
  { re: /\bplayers skip their untap steps?\b/, why: "nobody untaps" },
  // Blood Moon, Magus of the Moon, Contamination
  { re: /\bnonbasic lands are (?:mountains|swamps|islands|forests|plains)\b/, why: "turns every nonbasic land into a basic type" },
  { re: /\bif a land is tapped for mana, it produces \{[wubrgc]\} instead of any other type\b/, why: "changes what every land produces" },
  { re: /\blands produce \{[wubrgc]\} instead of any other type\b/, why: "changes what every land produces" },
];

/** The wipe gives lands back (basics from the library): checked against the whole text, it is usually the next sentence. */
const REPLACES = /\bfor each land (?:destroyed|sacrificed|exiled|put into a graveyard) this way\b/;
/** The sentence spares lands ("except for lands") or only evens them out (Balance's "fewest"). */
const SPARES = /\b(?:except|other than)\b[^.]*\blands?\b|\bfewest\b/;

export interface LandDenialHit {
  name: string;
  why: string;
}

export function detectMassLandDenial(cards: AnalysisCard[]): LandDenialHit[] {
  const out: LandDenialHit[] = [];
  for (const c of cards) {
    const t = text(c).replace(/\s+/g, " ");
    // "Destroy all nonland permanents" is a board wipe, not land denial.
    const scrubbed = t.replace(/\bnonland permanents\b/g, "nonland things");
    if (REPLACES.test(scrubbed)) continue;
    let hit: { re: RegExp; why: string } | undefined;
    for (const sentence of scrubbed.split(/(?<=\.)\s+/)) {
      if (SPARES.test(sentence)) continue;
      hit = PATTERNS.find((p) => p.re.test(sentence));
      if (hit) break;
    }
    if (hit && !out.some((o) => o.name === c.name)) out.push({ name: c.name, why: hit.why });
  }
  return out;
}
