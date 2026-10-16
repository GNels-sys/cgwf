import type { CardPrinting } from "../cards.js";
import type { CardInstance, CustomToken, GameState, LogEntry, PlayerId, Row, StackItem, Step, ZoneRef } from "./types.js";

/**
 * Per-player view of the game. This is the ONLY shape a client ever receives.
 * Identities of cards in any library, in other players' hands and of
 * face-down cards are stripped (printingId null, custom null); counts stay.
 * `viewFor` also returns the printings the view references so the server can
 * send each one once per connection instead of inlining 2 KB per card.
 */

export interface ViewCard {
  iid: string;
  /** Scryfall printing id, or null when the identity is hidden from the viewer. */
  printingId: string | null;
  custom: CustomToken | null;
  owner: PlayerId;
  zone: ZoneRef;
  tapped: boolean;
  faceDown: boolean;
  face: 0 | 1;
  counters: Record<string, number>;
  attachedTo: string | null;
  isToken: boolean;
  isCommander: boolean;
  /** True when every player can see the identity (revealed, or a public zone). */
  public: boolean;
  /** Library cards only: 0 = top. */
  position?: number;
}

export interface ViewPlayer {
  id: PlayerId;
  name: string;
  seat: number;
  life: number;
  counters: Record<string, number>;
  commanderDamage: Record<string, number>;
  commanderTax: Record<string, number>;
  mulligans: number;
  kept: boolean;
  conceded: boolean;
  library: { count: number; known: ViewCard[] };
  hand: { count: number; cards: ViewCard[] };
  graveyard: ViewCard[];
  exile: ViewCard[];
  command: ViewCard[];
  battlefield: Record<Row, ViewCard[]>;
}

export interface PlayerView {
  viewer: PlayerId | null;
  phase: GameState["phase"];
  players: Record<PlayerId, ViewPlayer>;
  turnOrder: PlayerId[];
  activePlayer: PlayerId;
  turn: number;
  step: Step;
  stack: StackItem[];
  priority: PlayerId | null;
  log: LogEntry[];
  seq: number;
  winner: PlayerId | null;
}

function identityVisible(c: CardInstance, viewer: PlayerId | null): boolean {
  if (c.revealedTo === "all") return true;
  if (viewer && Array.isArray(c.revealedTo) && c.revealedTo.includes(viewer)) return true;
  switch (c.zone.kind) {
    case "library":
      return false;
    case "hand":
      return viewer !== null && viewer === c.zone.owner;
    case "battlefield":
    case "exile":
      return !c.faceDown || (viewer !== null && (viewer === c.owner || viewer === c.zone.owner));
    default:
      return true;
  }
}

function isPublicIdentity(c: CardInstance): boolean {
  if (c.revealedTo === "all") return true;
  if (c.zone.kind === "library" || c.zone.kind === "hand") return false;
  return !c.faceDown;
}

function toViewCard(c: CardInstance, viewer: PlayerId | null, printings: Map<string, CardPrinting>): ViewCard {
  const visible = identityVisible(c, viewer);
  if (visible && c.printing) printings.set(c.printing.id, c.printing);
  const out: ViewCard = {
    iid: c.iid,
    printingId: visible && c.printing ? c.printing.id : null,
    custom: visible ? c.custom : null,
    owner: c.owner,
    zone: c.zone,
    tapped: c.tapped,
    faceDown: c.faceDown,
    face: c.face,
    counters: c.counters,
    attachedTo: c.attachedTo,
    isToken: c.isToken,
    isCommander: c.isCommander,
    public: isPublicIdentity(c),
  };
  return out;
}

export interface ViewResult {
  view: PlayerView;
  /** Printings referenced by visible cards in this view. */
  printings: Map<string, CardPrinting>;
}

/** Build the view for `viewer` (a seated player id) or for a spectator (null). */
export function viewFor(state: GameState, viewer: PlayerId | null, logLimit = 200): ViewResult {
  const printings = new Map<string, CardPrinting>();
  const get = (iid: string): CardInstance => {
    const c = state.cards[iid];
    if (!c) throw new Error(`view: missing card ${iid}`);
    return c;
  };
  const list = (iids: string[]): ViewCard[] => iids.map((iid) => toViewCard(get(iid), viewer, printings));

  const players: Record<PlayerId, ViewPlayer> = {};
  for (const p of Object.values(state.players)) {
    const known: ViewCard[] = [];
    p.zones.library.forEach((iid, position) => {
      const c = get(iid);
      if (identityVisible(c, viewer)) known.push({ ...toViewCard(c, viewer, printings), position });
    });
    const handCards: ViewCard[] = [];
    for (const iid of p.zones.hand) {
      const c = get(iid);
      if (identityVisible(c, viewer)) handCards.push(toViewCard(c, viewer, printings));
    }
    players[p.id] = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      life: p.life,
      counters: p.counters,
      commanderDamage: p.commanderDamage,
      commanderTax: p.commanderTax,
      mulligans: p.mulligans,
      kept: p.kept,
      conceded: p.conceded,
      library: { count: p.zones.library.length, known },
      hand: { count: p.zones.hand.length, cards: handCards },
      graveyard: list(p.zones.graveyard),
      exile: list(p.zones.exile),
      command: list(p.zones.command),
      battlefield: {
        lands: list(p.zones.battlefield.lands),
        creatures: list(p.zones.battlefield.creatures),
        other: list(p.zones.battlefield.other),
      },
    };
  }

  const view: PlayerView = {
    viewer,
    phase: state.phase,
    players,
    turnOrder: state.turnOrder,
    activePlayer: state.activePlayer,
    turn: state.turn,
    step: state.step,
    stack: state.stack,
    priority: state.priority,
    log: state.log.slice(-logLimit),
    seq: state.seq,
    winner: state.winner,
  };
  return { view, printings };
}

/** Display name for a view card (hidden cards are "Card"). */
export function viewCardName(c: ViewCard, printings: Record<string, CardPrinting>): string {
  if (c.custom) return c.custom.name;
  if (!c.printingId) return "Card";
  const p = printings[c.printingId];
  if (!p) return "Card";
  const face = p.faces[c.face];
  return c.face === 1 && face ? face.name : p.name;
}
