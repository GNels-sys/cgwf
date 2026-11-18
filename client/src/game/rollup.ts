import type { DerivedCard, ViewCard } from "@cgwf/shared";

/**
 * Identical tokens share one tile with a count (owner request 2026-11-18: a board of 110 tokens). Tokens are
 * identical when nothing a tile shows tells them apart: the same token, tapped or not, the same counters,
 * power and toughness, summoning sickness and damage, and the same combat mark, selection and glow. So 110
 * Saprolings of which 30 attack one player show as two tiles, "x30" with that player's mark and "x80".
 * Only tokens roll up, and only with nothing attached; fewer than ROLL_UP_MIN stay separate tiles.
 */
export const ROLL_UP_MIN = 4;

export interface Pile {
  /** The tile that is drawn: the first of the identical cards. */
  host: ViewCard;
  attachments: ViewCard[];
  /** Every card the tile stands for (just the host when nothing was rolled up). */
  members: ViewCard[];
  key: string;
}

export interface TileLook {
  derived?: DerivedCard | undefined;
  mark?: { label: string; color?: string | undefined } | undefined;
  selected?: boolean;
  highlight?: boolean;
}

/** What a token's tile shows, as a string; null for a card that never rolls up. */
export function tokenSignature(card: ViewCard, look: TileLook = {}): string | null {
  if (!card.isToken || card.attachedTo) return null;
  const counters = Object.entries(card.counters).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const d = look.derived;
  return JSON.stringify([
    card.printingId,
    card.custom,
    card.owner,
    card.tapped,
    card.faceDown,
    card.face,
    counters,
    card.effect,
    card.modifier,
    card.public,
    card.engine ?? null,
    d ? [d.power, d.toughness, d.keywords, d.effects] : null,
    look.mark ? [look.mark.label, look.mark.color ?? null] : null,
    look.selected === true,
    look.highlight === true,
  ]);
}

export function rollUp(stacks: Array<{ host: ViewCard; attachments: ViewCard[] }>, lookOf: (c: ViewCard) => TileLook, min = ROLL_UP_MIN): Pile[] {
  const signatures = stacks.map((s) => (s.attachments.length === 0 ? tokenSignature(s.host, lookOf(s.host)) : null));
  const sizes = new Map<string, number>();
  for (const sig of signatures) if (sig !== null) sizes.set(sig, (sizes.get(sig) ?? 0) + 1);
  const piles: Pile[] = [];
  const open = new Map<string, Pile>();
  stacks.forEach((s, i) => {
    const sig = signatures[i] ?? null;
    if (sig === null || (sizes.get(sig) ?? 0) < min) {
      piles.push({ host: s.host, attachments: s.attachments, members: [s.host], key: s.host.iid });
      return;
    }
    const pile = open.get(sig);
    if (pile) pile.members.push(s.host);
    else {
      // keyed by its first card: the tile stays mounted while cards join or leave behind it
      const made: Pile = { host: s.host, attachments: [], members: [s.host], key: `pile:${s.host.iid}` };
      open.set(sig, made);
      piles.push(made);
    }
  });
  return piles;
}
