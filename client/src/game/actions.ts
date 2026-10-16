import { CARD_COUNTER_KINDS, ROWS, hasBackFace, type ClientMessage, type EventInput, type MoveTarget, type PlayerView, type Row, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { battlefieldCards, nameOf, printingOf, type Printings } from "./model";
import type { Action, Dialog } from "./Sheets";

/**
 * Builds the action lists behind every sheet. Pure functions of the view plus
 * a few callbacks, so the Table component stays about layout.
 */

export interface Ctx {
  view: PlayerView;
  printings: Printings;
  /** My player id when seated, else null (spectator). */
  me: string | null;
  dispatch: (e: EventInput) => void;
  send: (m: ClientMessage) => void;
  dialog: (d: Dialog) => void;
  zoom: (c: ViewCard) => void;
  /** Show a list of cards (zone viewer). */
  showCards: (title: string, cards: ViewCard[], subtitle?: string) => void;
  close: () => void;
}

const ROW_LABEL: Record<Row, string> = { lands: "Lands", creatures: "Creatures", other: "Other" };

export function cardActions(ctx: Ctx, card: ViewCard): Action[] {
  const { view, me, dispatch, dialog, close } = ctx;
  const out: Action[] = [];
  const mine = me !== null && card.owner === me;
  const zone = card.zone;
  const holder = zone.owner;
  const controlMine = me !== null && holder === me;
  const act = (e: EventInput) => {
    dispatch(e);
    close();
  };
  const move = (label: string, to: MoveTarget, hint?: string) => {
    const a: Action = { label, run: () => act({ type: "CardMoved", payload: { iid: card.iid, to } }) };
    if (hint) a.hint = hint;
    out.push(a);
  };
  if (!me) return [{ label: "Zoom", run: () => ctx.zoom(card) }];

  const opponents = view.turnOrder.filter((id) => id !== me && !view.players[id]!.conceded);
  const printing = printingOf(card, ctx.printings);
  const twoFaced = printing ? hasBackFace(printing.layout) || printing.faces.length >= 2 : false;

  switch (zone.kind) {
    case "hand": {
      if (!controlMine) break;
      move("Play", { kind: "battlefield", owner: me });
      move("Play face down", { kind: "battlefield", owner: me, faceDown: true });
      out.push({ label: "Reveal to everyone", run: () => act({ type: "CardRevealed", payload: { iid: card.iid } }) });
      move("Discard", { kind: "graveyard", owner: me });
      move("Exile", { kind: "exile", owner: me });
      move("Top of library", { kind: "library", owner: me, position: "top" });
      move("Bottom of library", { kind: "library", owner: me, position: "bottom" });
      break;
    }
    case "battlefield": {
      out.push({ label: card.tapped ? "Untap" : "Tap", run: () => act({ type: "CardTapped", payload: { iid: card.iid, tapped: !card.tapped } }) });
      for (const kind of CARD_COUNTER_KINDS.slice(0, 3)) {
        const have = card.counters[kind] ?? 0;
        out.push({
          label: `${kind} counter`,
          hint: have ? `has ${have}` : undefined,
          run: () =>
            dialog({
              kind: "number",
              title: `${kind} counters on ${nameOf(card, ctx.printings)} (now ${have})`,
              initial: 1,
              quick: [-3, -1, 1, 3],
              submitLabel: "Add",
              onSubmit: (n) => act({ type: "CounterChanged", payload: { iid: card.iid, kind, delta: n } }),
            }),
        } as Action);
      }
      out.push({
        label: "Other counter...",
        run: () =>
          dialog({
            kind: "text",
            title: "Counter name",
            placeholder: "charge, oil, shield...",
            onSubmit: (kind) =>
              dialog({
                kind: "number",
                title: `${kind} counters (now ${card.counters[kind] ?? 0})`,
                initial: 1,
                quick: [-1, 1],
                submitLabel: "Add",
                onSubmit: (n) => act({ type: "CounterChanged", payload: { iid: card.iid, kind, delta: n } }),
              }),
          }),
      });
      if (twoFaced) out.push({ label: card.face === 0 ? "Transform / flip" : "Transform back", run: () => act({ type: "CardFlipped", payload: { iid: card.iid } }) });
      out.push({ label: card.faceDown ? "Turn face up" : "Turn face down", run: () => act({ type: "CardTurned", payload: { iid: card.iid, faceDown: !card.faceDown } }) });
      if (card.attachedTo) out.push({ label: "Unattach", run: () => act({ type: "Attached", payload: { iid: card.iid, to: null } }) });
      out.push({
        label: "Attach to...",
        run: () => {
          const hosts = Object.values(view.players)
            .flatMap((p) => battlefieldCards(p).map((c) => ({ p, c })))
            .filter(({ c }) => c.iid !== card.iid);
          dialog({
            kind: "pick",
            title: `Attach ${nameOf(card, ctx.printings)} to`,
            options: hosts.map(({ p, c }) => ({ value: c.iid, label: nameOf(c, ctx.printings), hint: p.id === me ? "yours" : p.name })),
            onPick: (to) => act({ type: "Attached", payload: { iid: card.iid, to } }),
          });
        },
      });
      out.push({ label: "Create token copy", run: () => act({ type: "CardCopied", payload: { iid: card.iid, player: me } }) });
      out.push({
        label: "Move to row...",
        run: () =>
          dialog({
            kind: "pick",
            title: "Row",
            options: ROWS.filter((r) => r !== zone.row).map((r) => ({ value: r, label: ROW_LABEL[r] })),
            onPick: (row) => act({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "battlefield", owner: holder, row: row as Row, faceDown: card.faceDown } } }),
          }),
      });
      if (opponents.length > 0 || holder !== me) {
        out.push({
          label: "Give control to...",
          run: () =>
            dialog({
              kind: "pick",
              title: "New controller",
              options: view.turnOrder.filter((id) => id !== holder && !view.players[id]!.conceded).map((id) => ({ value: id, label: id === me ? "Me" : view.players[id]!.name })),
              onPick: (owner) => act({ type: "CardMoved", payload: { iid: card.iid, to: { kind: "battlefield", owner, row: zone.row ?? "other", faceDown: card.faceDown } } }),
            }),
        });
      }
      if (mine && !card.isToken) move("To hand", { kind: "hand", owner: me });
      if (card.isCommander && mine) move("To command zone", { kind: "command", owner: me });
      move(card.isToken ? "Remove token" : "Graveyard", { kind: "graveyard", owner: card.owner });
      if (!card.isToken) move("Exile", { kind: "exile", owner: card.owner });
      if (mine && !card.isToken) {
        move("Top of library", { kind: "library", owner: me, position: "top" });
        move("Bottom of library", { kind: "library", owner: me, position: "bottom" });
      }
      break;
    }
    case "graveyard":
    case "exile": {
      if (card.faceDown && mine) out.push({ label: "Turn face up", run: () => act({ type: "CardTurned", payload: { iid: card.iid, faceDown: false } }) });
      move("To battlefield", { kind: "battlefield", owner: me });
      if (mine) move("To hand", { kind: "hand", owner: me });
      if (zone.kind === "graveyard") move("Exile", { kind: "exile", owner: card.owner });
      else move("Graveyard", { kind: "graveyard", owner: card.owner });
      if (card.isCommander && mine) move("To command zone", { kind: "command", owner: me });
      if (mine) {
        move("Top of library", { kind: "library", owner: me, position: "top" });
        move("Bottom of library", { kind: "library", owner: me, position: "bottom" });
      }
      break;
    }
    case "command": {
      if (!mine) break;
      const tax = view.players[me]!.commanderTax[card.iid] ?? 0;
      move("Cast (to battlefield)", { kind: "battlefield", owner: me }, tax ? `tax is +${tax}` : undefined);
      out.push({ label: "Commander tax +2", hint: `now +${tax}`, run: () => act({ type: "CommanderTaxChanged", payload: { player: me, commanderIid: card.iid, delta: 2 } }) });
      if (tax > 0) out.push({ label: "Commander tax -2", run: () => act({ type: "CommanderTaxChanged", payload: { player: me, commanderIid: card.iid, delta: -2 } }) });
      move("To hand", { kind: "hand", owner: me });
      break;
    }
    case "library": {
      if (!mine) break;
      move("To hand", { kind: "hand", owner: me });
      move("To battlefield", { kind: "battlefield", owner: me });
      move("Graveyard", { kind: "graveyard", owner: me });
      move("Exile", { kind: "exile", owner: me });
      move("Top of library", { kind: "library", owner: me, position: "top" });
      move("Bottom of library", { kind: "library", owner: me, position: "bottom" });
      break;
    }
  }
  out.push({ label: "Zoom", run: () => ctx.zoom(card) });
  return out;
}

export function libraryActions(ctx: Ctx, p: ViewPlayer): Action[] {
  const { me, dispatch, dialog, close } = ctx;
  if (me !== p.id) return [];
  const act = (e: EventInput) => {
    dispatch(e);
    close();
  };
  const count = p.library.count;
  const out: Action[] = [
    { label: "Draw a card", run: () => act({ type: "CardsDrawn", payload: { player: me, count: 1 } }), disabled: count === 0 },
    {
      label: "Draw several...",
      disabled: count === 0,
      run: () => dialog({ kind: "number", title: "Draw how many?", initial: 2, min: 1, max: 50, submitLabel: "Draw", onSubmit: (n) => act({ type: "CardsDrawn", payload: { player: me, count: n } }) }),
    },
    { label: "Shuffle", run: () => act({ type: "LibraryShuffled", payload: { player: me } }) },
    { label: "Reveal top card", run: () => act({ type: "LibraryRevealed", payload: { player: me, count: 1 } }), disabled: count === 0 },
    {
      label: "Look at top...",
      disabled: count === 0,
      run: () => dialog({ kind: "number", title: "Look at how many?", initial: 3, min: 1, max: 50, submitLabel: "Look", onSubmit: (n) => act({ type: "LibraryLooked", payload: { player: me, count: n } }) }),
    },
    { label: "Search library", hint: "shows every card to you only", run: () => act({ type: "LibrarySearched", payload: { player: me } }), disabled: count === 0 },
    {
      label: "Mill...",
      disabled: count === 0,
      run: () => dialog({ kind: "number", title: "Mill how many?", initial: 1, min: 1, max: 50, submitLabel: "Mill", onSubmit: (n) => act({ type: "Milled", payload: { player: me, count: n } }) }),
    },
  ];
  if (p.library.known.length > 0) {
    out.unshift({
      label: `Cards you can see (${p.library.known.length})`,
      run: () => {
        close();
        ctx.showCards("Your library (top first)", p.library.known, "Known until you shuffle");
      },
    });
  }
  return out;
}

export function playerActions(ctx: Ctx, p: ViewPlayer): Action[] {
  const { view, me, dispatch, dialog, close } = ctx;
  if (!me) return [];
  const act = (e: EventInput) => {
    dispatch(e);
    close();
  };
  const out: Action[] = [];
  const counter = (kind: string) => ({
    label: `${kind[0]!.toUpperCase()}${kind.slice(1)}`,
    hint: p.counters[kind] ? `${p.counters[kind]}` : undefined,
    run: () =>
      dialog({
        kind: "number",
        title: `${kind} for ${p.id === me ? "you" : p.name} (now ${p.counters[kind] ?? 0})`,
        initial: 1,
        quick: [-1, 1, 2],
        submitLabel: "Add",
        onSubmit: (n) => act({ type: "PlayerCounterChanged", payload: { player: p.id, kind, delta: n } }),
      }),
  });
  out.push(counter("poison") as Action, counter("energy") as Action, counter("experience") as Action);
  out.push({
    label: "Other player counter...",
    run: () => dialog({ kind: "text", title: "Counter name", placeholder: "rad, tickets...", onSubmit: (kind) => (counter(kind) as Action).run() }),
  });
  if (p.id === me) {
    const commanders = view.turnOrder
      .filter((id) => id !== me)
      .flatMap((id) => {
        const opp = view.players[id]!;
        return [...opp.command, ...battlefieldCards(opp), ...opp.graveyard, ...opp.exile].filter((c) => c.isCommander).map((c) => ({ opp, c }));
      });
    out.push({
      label: "Commander damage taken...",
      hint: Object.keys(p.commanderDamage).length ? Object.values(p.commanderDamage).join(" / ") : undefined,
      run: () =>
        dialog({
          kind: "pick",
          title: "From which commander?",
          options: commanders.map(({ opp, c }) => ({ value: c.iid, label: nameOf(c, ctx.printings), hint: `${opp.name} - ${p.commanderDamage[c.iid] ?? 0} so far` })),
          onPick: (commanderIid) =>
            dialog({
              kind: "number",
              title: "Damage taken",
              initial: 1,
              quick: [-1, 1, 2, 3, 5],
              submitLabel: "Add",
              onSubmit: (n) => act({ type: "CommanderDamage", payload: { player: me, commanderIid, delta: n } }),
            }),
        }),
    });
  }
  return out;
}

export function diceActions(ctx: Ctx): Action[] {
  const { me, dispatch, close } = ctx;
  if (!me) return [];
  const act = (e: EventInput) => {
    dispatch(e);
    close();
  };
  return [
    ...[4, 6, 8, 10, 12, 20].map((sides) => ({ label: `Roll d${sides}`, run: () => act({ type: "DiceRolled", payload: { player: me, sides } }) })),
    { label: "Flip a coin", run: () => act({ type: "CoinFlipped", payload: { player: me } }) },
    { label: "Random opponent", run: () => act({ type: "RandomOpponent", payload: { player: me } }) },
  ];
}
