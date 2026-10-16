import { hasBackFace, viewCardName, type CardPrinting, type PlayerView, type ViewCard, type ViewPlayer } from "@cgwf/shared";

/** Small read helpers over the per-player view. */

export type Printings = Record<string, CardPrinting>;

export function nameOf(card: ViewCard, printings: Printings): string {
  if (card.faceDown && !card.printingId && !card.custom) return "Face-down card";
  return viewCardName(card, printings);
}

export function printingOf(card: ViewCard, printings: Printings): CardPrinting | null {
  return card.printingId ? (printings[card.printingId] ?? null) : null;
}

/** Which image face to show: the back for transformed two-faced cards. */
export function imageFace(card: ViewCard, printing: CardPrinting | null): 0 | 1 {
  if (!printing) return 0;
  return card.face === 1 && hasBackFace(printing.layout) ? 1 : 0;
}

export function battlefieldCards(p: ViewPlayer): ViewCard[] {
  return [...p.battlefield.lands, ...p.battlefield.creatures, ...p.battlefield.other];
}

export function allVisibleCards(view: PlayerView): Map<string, ViewCard> {
  const out = new Map<string, ViewCard>();
  for (const p of Object.values(view.players)) {
    for (const c of [...battlefieldCards(p), ...p.graveyard, ...p.exile, ...p.command, ...p.hand.cards, ...p.library.known]) out.set(c.iid, c);
  }
  return out;
}

export function findCard(view: PlayerView, iid: string): ViewCard | null {
  return allVisibleCards(view).get(iid) ?? null;
}

export function opponentsOf(view: PlayerView, me: string | null): ViewPlayer[] {
  return view.turnOrder.filter((id) => id !== me).map((id) => view.players[id]!);
}

/** Players in turn order starting after `me`, so the strip reads clockwise. */
export function seatOrderFrom(view: PlayerView, me: string | null): ViewPlayer[] {
  const order = view.turnOrder;
  const i = me ? order.indexOf(me) : -1;
  const rotated = i >= 0 ? [...order.slice(i + 1), ...order.slice(0, i)] : order;
  return rotated.map((id) => view.players[id]!);
}

export function totalCommanderDamage(p: ViewPlayer): number {
  return Object.values(p.commanderDamage).reduce((a, b) => a + b, 0);
}

export function counterSummary(counters: Record<string, number>): string {
  return Object.entries(counters)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
}
