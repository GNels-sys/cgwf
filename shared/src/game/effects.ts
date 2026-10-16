import type { CardPrinting } from "../cards.js";
import type { AttachmentEffect, CardModifier, CustomToken, ManualAnthem, ZoneRef } from "./types.js";

/**
 * Assisted bookkeeping: pure text parsers and derived stats. Nothing here is
 * enforced; the parsers PREFILL what a player then confirms, and the derived
 * values are what the tiles display. Both server state and client views run
 * the same code, so every client agrees.
 */

/** Keywords we recognise in "has/have ..." lists. Protection is matched as a phrase. */
export const KNOWN_KEYWORDS = [
  "flying",
  "first strike",
  "double strike",
  "deathtouch",
  "haste",
  "hexproof",
  "indestructible",
  "lifelink",
  "menace",
  "reach",
  "trample",
  "vigilance",
  "shroud",
  "flash",
  "defender",
  "ward",
  "fear",
  "intimidate",
  "horsemanship",
  "shadow",
  "skulk",
  "infect",
  "wither",
  "prowess",
  "undying",
  "persist",
  "flanking",
  "banding",
  "phasing",
  "unblockable",
  "islandwalk",
  "swampwalk",
  "forestwalk",
  "mountainwalk",
  "plainswalk",
  "landwalk",
  "changeling",
  "decayed",
  "exalted",
  "toxic",
  "afflict",
  "bushido",
  "rampage",
  "annihilator",
  "battle cry",
  "myriad",
  "melee",
  "training",
  "mentor",
  "backup",
  "ravenous",
  "riot",
  "disturb",
  "boast",
] as const;

/** "flying, first strike and haste" -> ["flying", "first strike", "haste"]. Unknown words are dropped. */
export function parseKeywordList(text: string): string[] {
  const parts = text
    .toLowerCase()
    .replace(/\band\b/g, ",")
    .split(",")
    .map((s) => s.trim().replace(/\.$/, "").trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const prot = part.match(/^protection from [a-z ,'-]+$/);
    if (prot) {
      out.push(part);
      continue;
    }
    // "protection from red and from blue" -> the second half arrives as "from blue".
    if (/^from [a-z ,'-]+$/.test(part) && out.at(-1)?.startsWith("protection from")) {
      out.push(`protection ${part}`);
      continue;
    }
    const ward = part.match(/^ward(?: \{[^}]+\})?$/);
    if (ward) {
      out.push(part);
      continue;
    }
    const kw = KNOWN_KEYWORDS.find((k) => part === k || part.startsWith(`${k} `));
    if (kw) out.push(kw);
  }
  return [...new Set(out)];
}

function faceText(printing: CardPrinting, face: 0 | 1): string {
  const f = printing.faces[face] ?? printing.faces[0];
  return f ? f.oracleText : printing.oracleText;
}

function parseStat(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * "Equipped creature gets +2/+0 and has trample." -> {power 2, toughness 0, keywords [trample]}.
 * Also "Enchanted creature gets +X/+Y", "Equipped creature has haste and shroud." Returns null
 * when nothing static is recognised (conditional bonuses like "for each" are reported as-is;
 * the player edits before confirming).
 */
export function parseAttachmentEffect(oracleText: string): AttachmentEffect | null {
  let power = 0;
  let toughness = 0;
  const keywords: string[] = [];
  let found = false;
  for (const raw of oracleText.split("\n")) {
    const line = raw.trim();
    if (!/^(equipped|enchanted|fortified) (creature|permanent|land)/i.test(line)) continue;
    const pt = line.match(/\bgets? ([+-]\d+)\/([+-]\d+)/i);
    if (pt) {
      power += Number(pt[1]);
      toughness += Number(pt[2]);
      found = true;
    }
    const has = line.match(/\b(?:has|have) ([^.]+)/i);
    if (has) {
      const kws = parseKeywordList(has[1]!);
      if (kws.length) {
        keywords.push(...kws);
        found = true;
      }
    }
  }
  return found ? { power, toughness, keywords: [...new Set(keywords)] } : null;
}

export interface DetectedAnthem {
  sourceIid: string;
  name: string;
  power: number;
  toughness: number;
  keywords: string[];
  /** "Other creatures you control": the source itself is excluded. */
  other: boolean;
  dismissed: boolean;
}

/** "Creatures you control get +1/+1." / "Other creatures you control get +1/+1 and have vigilance." */
export function parseAnthem(oracleText: string): { power: number; toughness: number; keywords: string[]; other: boolean } | null {
  for (const raw of oracleText.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(other )?creatures you control (.*)$/i);
    if (!m) continue;
    const rest = m[2] ?? "";
    // Skip clearly conditional or temporary forms.
    if (/\buntil end of turn\b|\bas long as\b|\bfor each\b|\bwith\b/i.test(rest)) continue;
    const pt = rest.match(/^get ([+-]\d+)\/([+-]\d+)/i);
    const has = rest.match(/\bhave ([^.]+)/i);
    const keywords = has ? parseKeywordList(has[1]!) : [];
    if (!pt && keywords.length === 0) continue;
    return { power: pt ? Number(pt[1]) : 0, toughness: pt ? Number(pt[2]) : 0, keywords, other: Boolean(m[1]) };
  }
  return null;
}

/** The subset of a card the derivation needs; both CardInstance and ViewCard satisfy it. */
export interface BattlefieldCardLike {
  iid: string;
  zone: ZoneRef;
  custom: CustomToken | null;
  face: 0 | 1;
  faceDown: boolean;
  counters: Record<string, number>;
  attachedTo: string | null;
  effect: AttachmentEffect | null;
  modifier: CardModifier | null;
  anthemDismissed: boolean;
}

export interface GrantedEffect {
  /** Attachment or anthem source instance id, or "manual" / "anthem:<id>". */
  source: string;
  label: string;
  power: number;
  toughness: number;
  keywords: string[];
}

export interface DerivedCard {
  /** Printed numbers when numeric; null when "*" or not a creature. */
  basePower: number | null;
  baseToughness: number | null;
  power: number | null;
  toughness: number | null;
  /** Non-zero when anything modifies printed stats. */
  deltaPower: number;
  deltaToughness: number;
  keywords: string[];
  attachments: string[];
  effects: GrantedEffect[];
  isCreature: boolean;
}

export interface DerivedBattlefield {
  cards: Map<string, DerivedCard>;
  anthems: DetectedAnthem[];
  manual: ManualAnthem[];
}

/**
 * Derive displayed stats for ONE controller's battlefield. `cards` are all the
 * cards in that player's battlefield sections; `getPrinting` resolves card data.
 */
export function deriveBattlefield(cards: BattlefieldCardLike[], getPrinting: (c: BattlefieldCardLike) => CardPrinting | null, manual: ManualAnthem[] = []): DerivedBattlefield {
  const anthems: DetectedAnthem[] = [];
  for (const c of cards) {
    if (c.faceDown) continue;
    const p = getPrinting(c);
    if (!p) continue;
    const a = parseAnthem(faceText(p, c.face));
    if (a) anthems.push({ sourceIid: c.iid, name: cardDisplayName(p, c.face), ...a, dismissed: c.anthemDismissed });
  }
  anthems.sort((x, y) => x.name.localeCompare(y.name));
  const byIid = new Map(cards.map((c) => [c.iid, c]));
  const out = new Map<string, DerivedCard>();
  for (const c of cards) {
    const p = getPrinting(c);
    const face = p ? (p.faces[c.face] ?? p.faces[0]) : undefined;
    const typeLine = c.custom?.typeLine ?? face?.typeLine ?? p?.typeLine ?? "";
    const isCreature = /\bcreature\b/i.test(typeLine.split(" // ")[0] ?? typeLine);
    const basePower = c.custom ? parseStat(c.custom.power) : parseStat(face?.power ?? p?.power);
    const baseToughness = c.custom ? parseStat(c.custom.toughness) : parseStat(face?.toughness ?? p?.toughness);
    const printedKeywords = c.faceDown ? [] : (p?.keywords ?? []).map((k) => k.toLowerCase());
    const effects: GrantedEffect[] = [];
    const attachments = cards.filter((o) => o.attachedTo === c.iid).map((o) => o.iid);
    for (const aid of attachments) {
      const a = byIid.get(aid)!;
      if (!a.effect) continue;
      const ap = getPrinting(a);
      effects.push({ source: aid, label: a.custom?.name ?? (ap ? cardDisplayName(ap, a.face) : "Attachment"), power: a.effect.power, toughness: a.effect.toughness, keywords: a.effect.keywords });
    }
    if (isCreature) {
      for (const an of anthems) {
        if (an.dismissed) continue;
        if (an.other && an.sourceIid === c.iid) continue;
        effects.push({ source: an.sourceIid, label: an.name, power: an.power, toughness: an.toughness, keywords: an.keywords });
      }
      for (const m of manual) effects.push({ source: `anthem:${m.id}`, label: m.note || "Manual anthem", power: m.power, toughness: m.toughness, keywords: m.keywords });
    }
    if (c.modifier && (c.modifier.power || c.modifier.toughness || c.modifier.keywords.length)) {
      effects.push({ source: "manual", label: "Manual", power: c.modifier.power, toughness: c.modifier.toughness, keywords: c.modifier.keywords });
    }
    const plus = c.counters["+1/+1"] ?? 0;
    const minus = c.counters["-1/-1"] ?? 0;
    const deltaPower = plus - minus + effects.reduce((n, e) => n + e.power, 0);
    const deltaToughness = plus - minus + effects.reduce((n, e) => n + e.toughness, 0);
    const removed = new Set((c.modifier?.removedKeywords ?? []).map((k) => k.toLowerCase()));
    const keywords = [...new Set([...printedKeywords, ...effects.flatMap((e) => e.keywords.map((k) => k.toLowerCase()))])].filter((k) => !removed.has(k));
    out.set(c.iid, {
      basePower,
      baseToughness,
      power: basePower === null ? null : basePower + deltaPower,
      toughness: baseToughness === null ? null : baseToughness + deltaToughness,
      deltaPower,
      deltaToughness,
      keywords,
      attachments,
      effects,
      isCreature,
    });
  }
  return { cards: out, anthems, manual };
}

export function cardDisplayName(p: CardPrinting, face: 0 | 1): string {
  const f = p.faces[face] ?? p.faces[0];
  return f ? f.name : p.name;
}

/** Sum of the active anthems for a section header badge: "+2/+2, vigilance (Glorious Anthem, ...)". */
export function describeAnthems(d: DerivedBattlefield): string | null {
  const active = d.anthems.filter((a) => !a.dismissed);
  const all = [...active.map((a) => ({ p: a.power, t: a.toughness, k: a.keywords, n: a.name })), ...d.manual.map((m) => ({ p: m.power, t: m.toughness, k: m.keywords, n: m.note || "manual" }))];
  if (!all.length) return null;
  const p = all.reduce((n, a) => n + a.p, 0);
  const t = all.reduce((n, a) => n + a.t, 0);
  const kws = [...new Set(all.flatMap((a) => a.k))];
  const parts: string[] = [];
  if (p || t) parts.push(`${p >= 0 ? "+" : ""}${p}/${t >= 0 ? "+" : ""}${t}`);
  if (kws.length) parts.push(kws.join(", "));
  return `${parts.join(", ")} (${all.map((a) => a.n).join(", ")})`;
}
