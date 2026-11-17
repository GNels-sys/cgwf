import type { EnginePlayable, EnginePrompt, PlayerView, ViewCard } from "@cgwf/shared";

/**
 * Prepared spells (Secrets of Strixhaven; owner report 2026-11-17). While a creature is prepared, a copy of its
 * spell waits in exile and may be cast from there; casting it unprepares the creature. The rules engine always
 * offered that copy, but the only sign on screen was a button named after the spell among the "playable from
 * exile" plays, and nothing said whether a creature was prepared at all. These helpers let the creature itself
 * stand for its spell: it glows, a tap casts the spell, and the tile and the card view say where it stands.
 */

/** The iid of the spell this card may cast right now because it is prepared, or null. */
function readySpell(card: ViewCard): string | null {
  const prepare = card.engine?.prepare;
  return prepare?.ready && prepare.spellIid ? prepare.spellIid : null;
}

/** Priority options a tapped card stands for: its own, plus its prepared spell's. */
export function optionsForCard(prompt: EnginePrompt | null, card: ViewCard): EnginePlayable[] {
  if (prompt?.kind !== "priority") return [];
  const spell = card.zone.kind === "battlefield" ? readySpell(card) : null;
  return prompt.options.filter((o) => o.iid === card.iid || (spell !== null && o.iid === spell));
}

/** Battlefield creatures whose prepared spell is one of this priority's options: they glow like any playable card. */
export function preparedCasters(prompt: EnginePrompt | null, view: PlayerView): string[] {
  if (prompt?.kind !== "priority" || prompt.options.length === 0) return [];
  const offered = new Set(prompt.options.map((o) => o.iid));
  const out: string[] = [];
  for (const p of Object.values(view.players)) {
    for (const card of Object.values(p.battlefield).flat()) {
      const spell = readySpell(card);
      if (spell !== null && offered.has(spell)) out.push(card.iid);
    }
  }
  return out;
}

/**
 * The card database lists "Prepared" as a keyword of every such creature, so the keyword chips showed
 * "prepared" all the time, prepared or not. Where the engine reports the real state, that chip is dropped;
 * the "Prepared" mark and the sentence in the card view say it instead.
 */
export function withoutPrepareKeyword(keywords: string[], card: ViewCard): string[] {
  return card.engine?.prepare ? keywords.filter((k) => k.toLowerCase() !== "prepared") : keywords;
}

/** The sentence under a card in the card view, or null for a card without a prepared spell. */
export function prepareLine(card: ViewCard, mine: boolean): string | null {
  const by = card.engine?.preparedBy;
  if (by) return `${by.name || "A creature"}'s prepared spell. It waits here until it is cast or that creature leaves the battlefield.`;
  const prepare = card.engine?.prepare;
  if (!prepare || card.zone.kind !== "battlefield") return null;
  if (!prepare.ready) return `Not prepared. ${prepare.name} can be cast only while this creature is prepared, and its own text says when that happens.`;
  return mine
    ? `Prepared. You may cast ${prepare.name}: tap this card while it glows. Casting it unprepares this creature.`
    : `Prepared. Its controller may cast ${prepare.name}; casting it unprepares this creature.`;
}
