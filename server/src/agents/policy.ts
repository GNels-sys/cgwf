import { viewCardName, type CardPrinting, type PlayerId, type PlayerView, type ViewCard } from "@cgwf/shared";

/**
 * Scripted decisions used when no API key is configured (dry run) and in tests.
 * Deliberately simple and legal: one land, the cheapest permanent the untapped
 * lands can pay for, an all-out attack with creatures that were already here
 * last turn when it is safe-ish, then pass. The same tool vocabulary as the
 * model, so the runner code path is identical.
 */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

type Printings = Record<string, CardPrinting>;

function typeOf(c: ViewCard, printings: Printings): string {
  const p = c.printingId ? printings[c.printingId] : undefined;
  return (p?.faces[0]?.typeLine || p?.typeLine || c.custom?.typeLine || "").toLowerCase();
}
function cmcOf(c: ViewCard, printings: Printings): number {
  const p = c.printingId ? printings[c.printingId] : undefined;
  return p?.cmc ?? 0;
}
function powerOf(c: ViewCard, printings: Printings): number {
  const p = c.printingId ? printings[c.printingId] : undefined;
  const raw = p?.faces[0]?.power ?? p?.power ?? c.custom?.power ?? "0";
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n + (c.counters["+1/+1"] ?? 0) - (c.counters["-1/-1"] ?? 0) : 0;
}

/** Keep unless the seven-card hand has fewer than two or more than five lands (one mulligan at most). */
export function shouldMulligan(hand: ViewCard[], printings: Printings, mulligans: number): boolean {
  if (mulligans >= 1) return false;
  const lands = hand.filter((c) => /\bland\b/.test(typeOf(c, printings))).length;
  return lands < 2 || lands > 5;
}

/** Which cards to put on the bottom after a mulligan: the most expensive spells first, extra lands if flooded. */
export function cardsToBottom(hand: ViewCard[], printings: Printings, n: number): ViewCard[] {
  const lands = hand.filter((c) => /\bland\b/.test(typeOf(c, printings)));
  const spells = hand.filter((c) => !lands.includes(c)).sort((a, b) => cmcOf(b, printings) - cmcOf(a, printings));
  const out: ViewCard[] = [];
  const extraLands = Math.max(0, lands.length - 4);
  out.push(...lands.slice(0, Math.min(extraLands, n)));
  for (const c of spells) {
    if (out.length >= n) break;
    out.push(c);
  }
  for (const c of lands) {
    if (out.length >= n) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, n);
}

export interface DryRunContext {
  me: PlayerId;
  view: PlayerView;
  printings: Printings;
  /** Creatures that entered this turn (summoning sick). */
  enteredThisTurn: ReadonlySet<string>;
}

/** One whole turn as a batch of tool calls, ending with pass_turn. */
export function dryRunTurn(ctx: DryRunContext): ToolCall[] {
  const me = ctx.view.players[ctx.me];
  if (!me) return [{ name: "pass_turn", input: {} }];
  const calls: ToolCall[] = [];
  const hand = me.hand.cards;
  const land = hand.find((c) => /\bland\b/.test(typeOf(c, ctx.printings)));
  let untappedLands = me.battlefield.lands.filter((c) => !c.tapped).length + me.battlefield.artifacts.filter((c) => !c.tapped && /add \{/i.test((c.printingId ? ctx.printings[c.printingId]?.oracleText : "") ?? "")).length;
  if (land) {
    calls.push({ name: "play_land", input: { iid: land.iid } });
    untappedLands++;
  }
  // Cheapest castable permanent (creatures first), paid with untapped lands.
  const sources = [...me.battlefield.lands.filter((c) => !c.tapped).map((c) => c.iid)];
  const castable = hand
    .filter((c) => c !== land)
    .filter((c) => {
      const t = typeOf(c, ctx.printings);
      return !/\bland\b/.test(t) && !/\b(instant|sorcery)\b/.test(t) && cmcOf(c, ctx.printings) <= untappedLands;
    })
    .sort((a, b) => Number(/\bcreature\b/.test(typeOf(b, ctx.printings))) - Number(/\bcreature\b/.test(typeOf(a, ctx.printings))) || cmcOf(b, ctx.printings) - cmcOf(a, ctx.printings));
  const pick = castable[0];
  if (pick) {
    const need = cmcOf(pick, ctx.printings);
    // The land played this turn is not in `sources` yet; the reducer sees it after play_land, so tap existing ones first and leave the rest unpaid-but-counted.
    calls.push({ name: "cast_permanent", input: { iid: pick.iid, tap_lands: sources.slice(0, Math.min(need, sources.length)) } });
  }
  // Attack with creatures that were here last turn, at the opponent with the most life, if we have more power than their untapped creatures.
  const attackers = me.battlefield.creatures.filter((c) => !c.tapped && !ctx.enteredThisTurn.has(c.iid) && !c.attachedTo);
  const opponents = ctx.view.turnOrder.filter((id) => id !== ctx.me).map((id) => ctx.view.players[id]!).filter((p) => !p.conceded);
  if (attackers.length && opponents.length && ctx.view.turn > 2) {
    const target = opponents.slice().sort((a, b) => b.life - a.life)[0]!;
    const blockers = target.battlefield.creatures.filter((c) => !c.tapped).length;
    const power = attackers.reduce((n, c) => n + powerOf(c, ctx.printings), 0);
    if (blockers === 0 || power >= blockers * 3) {
      calls.push({ name: "set_step", input: { step: "combat" } });
      calls.push({ name: "attack", input: { attacker_iids: attackers.map((c) => c.iid), defender: target.name, total_power: power } });
    }
  }
  calls.push({ name: "pass_turn", input: {} });
  return calls;
}

/** Dry run on an opponent's turn: acknowledge our triggers without applying anything. */
export function dryRunTriggers(ctx: DryRunContext): ToolCall[] {
  const mine = ctx.view.pendingTriggers.filter((t) => t.controller === ctx.me);
  if (mine.length === 0) return [];
  return [{ name: "dismiss_triggers", input: {} }];
}

export function describeHand(hand: ViewCard[], printings: Printings): string {
  return hand.map((c) => viewCardName(c, printings)).join(", ");
}
