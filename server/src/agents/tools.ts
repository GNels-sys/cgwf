import type Anthropic from "@anthropic-ai/sdk";
import { MANA_COLORS, viewCardName, type CardPrinting, type EventInput, type ManaColor, type PlayerId, type PlayerView, type Row, type ViewCard } from "@cgwf/shared";

/**
 * The agent's action vocabulary: one tool per bookkeeping action, each mapped
 * one-to-one onto the shared event types (same path humans use). `mapToolCall`
 * validates against the agent's own view and never touches hidden zones; the
 * reducer on the server has the final word.
 */
export type Printings = Record<string, CardPrinting>;

export interface ToolContext {
  me: PlayerId;
  view: PlayerView;
  printings: Printings;
  /** Players that are computer opponents (the attacker applies their damage). */
  agentIds: ReadonlySet<PlayerId>;
}

export interface MappedCall {
  events: EventInput[];
  summary: string;
  /** The runner appends extra context to the tool result (e.g. the searched library). */
  resultHint?: "library" | undefined;
  /** True for pass_turn / concede: the turn loop ends after this call. */
  endsTurn?: boolean | undefined;
}

export type MapResult = { ok: true; call: MappedCall } | { ok: false; error: string };

const ZONE_TARGETS = ["hand", "graveyard", "exile", "library_top", "library_bottom", "battlefield", "command"] as const;
const STEP_TARGETS = ["main1", "combat", "main2", "end"] as const;

function obj(props: Record<string, unknown>, required: string[]): Anthropic.Tool.InputSchema {
  return { type: "object", properties: props, required, additionalProperties: false } as Anthropic.Tool.InputSchema;
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
  { name: "play_land", description: "Play a land from your hand onto the battlefield (one per turn).", input_schema: obj({ iid: { type: "string", description: "Card id from your hand" } }, ["iid"]) },
  {
    name: "cast_permanent",
    description: "Cast a creature, artifact, enchantment, planeswalker or battle from your hand (or your commander from the command zone): it enters the battlefield. Pay for it by listing the lands/rocks to tap.",
    input_schema: obj({ iid: { type: "string" }, tap_lands: { type: "array", items: { type: "string" }, description: "Ids of the untapped mana sources you tap to pay" } }, ["iid", "tap_lands"]),
  },
  {
    name: "cast_spell",
    description: "Cast an instant or sorcery from your hand: apply its effect with other tools in the same reply, this moves the card to your graveyard. Pay by listing the mana sources to tap.",
    input_schema: obj({ iid: { type: "string" }, tap_lands: { type: "array", items: { type: "string" } } }, ["iid", "tap_lands"]),
  },
  { name: "tap_cards", description: "Tap or untap your own permanents (mana, abilities, attacking is done by attack).", input_schema: obj({ iids: { type: "array", items: { type: "string" } }, tapped: { type: "boolean" } }, ["iids", "tapped"]) },
  {
    name: "move_card",
    description: "Move a visible card to a zone: your own cards anywhere; opponents' permanents only to their graveyard/exile/hand (removal, bounce) or back under their control. Dying creatures go to the graveyard.",
    input_schema: obj(
      {
        iid: { type: "string" },
        to: { type: "string", enum: [...ZONE_TARGETS] },
        row: { type: "string", enum: ["creatures", "other", "enchantments", "artifacts", "lands"], description: "Battlefield section (optional; defaults from the type)" },
      },
      ["iid", "to"],
    ),
  },
  { name: "attach", description: "Attach an Aura or Equipment you control to a creature (pay equip costs by tapping lands first). Use to_iid null to unattach.", input_schema: obj({ iid: { type: "string" }, to_iid: { type: ["string", "null"] } }, ["iid", "to_iid"]) },
  { name: "change_counters", description: "Add or remove counters on a card (+1/+1, -1/-1, loyalty, charge, ...). Negative delta removes.", input_schema: obj({ iid: { type: "string" }, kind: { type: "string" }, delta: { type: "integer" } }, ["iid", "kind", "delta"]) },
  { name: "change_life", description: "Change a player's life total by delta (negative = damage/loss). Use 'me' or a player's name.", input_schema: obj({ player: { type: "string" }, delta: { type: "integer" } }, ["player", "delta"]) },
  { name: "player_counter", description: "Change a player's poison/energy/experience counters.", input_schema: obj({ player: { type: "string" }, kind: { type: "string" }, delta: { type: "integer" } }, ["player", "kind", "delta"]) },
  { name: "commander_damage", description: "Record combat damage a commander dealt to a player (21 total kills).", input_schema: obj({ player: { type: "string" }, commander_iid: { type: "string" }, delta: { type: "integer" } }, ["player", "commander_iid", "delta"]) },
  {
    name: "create_token",
    description: "Create one or more tokens under your control.",
    input_schema: obj(
      {
        name: { type: "string" },
        type_line: { type: "string", description: "e.g. 'Token Creature — Goblin' or 'Token Artifact — Treasure'" },
        power: { type: ["string", "null"] },
        toughness: { type: ["string", "null"] },
        colors: { type: "array", items: { type: "string", enum: ["W", "U", "B", "R", "G"] } },
        text: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 20 },
      },
      ["name", "type_line", "power", "toughness", "colors", "text", "count"],
    ),
  },
  { name: "draw_cards", description: "Draw cards (effects only; the turn's draw is automatic).", input_schema: obj({ count: { type: "integer", minimum: 1, maximum: 10 } }, ["count"]) },
  { name: "shuffle_library", description: "Shuffle your library.", input_schema: obj({}, []) },
  { name: "search_library", description: "Search your library (a tutor or fetch effect): the result lists your library cards with ids so you can move_card one to your hand or the battlefield, then shuffle_library.", input_schema: obj({}, []) },
  { name: "adjust_mana", description: "Add (or remove) mana in your pool, for effects that make mana.", input_schema: obj({ color: { type: "string", enum: [...MANA_COLORS] }, delta: { type: "integer" } }, ["color", "delta"]) },
  { name: "set_step", description: "Move your turn to a step: combat (declare attackers next), main2, end.", input_schema: obj({ step: { type: "string", enum: [...STEP_TARGETS] } }, ["step"]) },
  {
    name: "attack",
    description: "Declare an attack on a player: the table taps the attackers (vigilance excepted), logs it, lets human defenders declare blocks, and applies combat damage (default assignment) when you move past combat or pass the turn.",
    input_schema: obj({ attacker_iids: { type: "array", items: { type: "string" } }, defender: { type: "string", description: "Defending player's name" }, total_power: { type: "integer", minimum: 0 } }, ["attacker_iids", "defender", "total_power"]),
  },
  { name: "resolve_trigger", description: "Mark one of your pending triggers as handled.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "dismiss_triggers", description: "Clear all your pending triggers that do not apply.", input_schema: obj({}, []) },
  { name: "flip_card", description: "Transform / turn over a two-faced card you control.", input_schema: obj({ iid: { type: "string" } }, ["iid"]) },
  { name: "untap_all", description: "Untap all your permanents (rare effects).", input_schema: obj({}, []) },
  { name: "say", description: "Post a short public note in the game log (announce attacks, spells humans must react to, or what you are doing).", input_schema: obj({ text: { type: "string", maxLength: 200 } }, ["text"]) },
  { name: "pass_turn", description: "End your turn. Required at the end of every turn of yours.", input_schema: obj({}, []) },
  { name: "concede", description: "Concede the game. Only when you cannot win.", input_schema: obj({}, []) },
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOLS.map((t) => t.name));

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} must be a non-empty string`);
  return v.trim();
}
function int(v: unknown, field: string, min = -999, max = 999): number {
  const n = typeof v === "number" ? Math.trunc(v) : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return n;
}
function strList(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${field} must be a list of ids`);
  return v.map((x, i) => str(x, `${field}[${i}]`));
}

function allCards(view: PlayerView): Map<string, ViewCard> {
  const out = new Map<string, ViewCard>();
  for (const p of Object.values(view.players)) {
    const lists = [p.hand.cards, p.graveyard, p.exile, p.command, p.library.known, ...Object.values(p.battlefield)];
    for (const list of lists) for (const c of list) out.set(c.iid, c);
  }
  return out;
}

function findPlayer(ctx: ToolContext, ref: string): PlayerId {
  const r = ref.trim().toLowerCase();
  if (r === "me" || r === "you" || r === "myself" || r === ctx.me.toLowerCase()) return ctx.me;
  const players = Object.values(ctx.view.players);
  const exact = players.find((p) => p.name.toLowerCase() === r || p.id === ref);
  if (exact) return exact.id;
  const partial = players.filter((p) => p.name.toLowerCase().includes(r));
  if (partial.length === 1) return partial[0]!.id;
  throw new Error(`no player called "${ref}"; players: ${players.map((p) => p.name).join(", ")}`);
}

function mine(ctx: ToolContext, c: ViewCard, what: string): void {
  if (c.zone.owner !== ctx.me) throw new Error(`${c.iid} is not under your control; ${what}`);
}

function typeOf(c: ViewCard, printings: Printings): string {
  const p = c.printingId ? printings[c.printingId] : undefined;
  return ((p?.faces[c.face] ?? p?.faces[0])?.typeLine || p?.typeLine || c.custom?.typeLine || "").toLowerCase();
}

/** Validate a tool call against the view and translate it to events. Pure. */
export function mapToolCall(name: string, input: Record<string, unknown>, ctx: ToolContext): MapResult {
  try {
    const cards = allCards(ctx.view);
    const me = ctx.me;
    const card = (iid: string): ViewCard => {
      const c = cards.get(iid);
      if (!c) throw new Error(`no visible card with id ${iid}`);
      return c;
    };
    const nameOf = (c: ViewCard) => viewCardName(c, ctx.printings);
    const tapList = (raw: unknown): EventInput[] => {
      const ids = raw === undefined ? [] : strList(raw, "tap_lands");
      return ids.map((iid) => {
        const c = card(iid);
        mine(ctx, c, "you can only tap your own permanents");
        if (c.zone.kind !== "battlefield") throw new Error(`${iid} is not on the battlefield`);
        if (c.tapped) throw new Error(`${iid} ${nameOf(c)} is already tapped`);
        return { type: "CardTapped", payload: { iid, tapped: true } } as EventInput;
      });
    };

    switch (name) {
      case "play_land": {
        const c = card(str(input.iid, "iid"));
        if (c.zone.kind !== "hand" || c.zone.owner !== me) throw new Error(`${c.iid} is not in your hand`);
        if (!/\bland\b/.test(typeOf(c, ctx.printings))) throw new Error(`${nameOf(c)} is not a land; use cast_permanent or cast_spell`);
        return ok([{ type: "CardMoved", payload: { iid: c.iid, to: { kind: "battlefield", owner: me } } }], `played ${nameOf(c)}`);
      }
      case "cast_permanent": {
        const c = card(str(input.iid, "iid"));
        if (!((c.zone.kind === "hand" || c.zone.kind === "command") && c.zone.owner === me)) throw new Error(`${c.iid} is not in your hand or command zone`);
        const t = typeOf(c, ctx.printings);
        if (/\b(instant|sorcery)\b/.test(t)) throw new Error(`${nameOf(c)} is an instant/sorcery; use cast_spell`);
        if (/\bland\b/.test(t) && !/\bcreature\b/.test(t)) throw new Error(`${nameOf(c)} is a land; use play_land`);
        const taps = tapList(input.tap_lands);
        return ok([...taps, { type: "CardMoved", payload: { iid: c.iid, to: { kind: "battlefield", owner: me } } }], `cast ${nameOf(c)}${taps.length ? ` tapping ${taps.length}` : ""}`);
      }
      case "cast_spell": {
        const c = card(str(input.iid, "iid"));
        if (c.zone.kind !== "hand" || c.zone.owner !== me) throw new Error(`${c.iid} is not in your hand`);
        if (!/\b(instant|sorcery)\b/.test(typeOf(c, ctx.printings))) throw new Error(`${nameOf(c)} is a permanent; use cast_permanent`);
        const taps = tapList(input.tap_lands);
        return ok([...taps, { type: "CardRevealed", payload: { iid: c.iid } }, { type: "CardMoved", payload: { iid: c.iid, to: { kind: "graveyard", owner: me } } }], `cast ${nameOf(c)}${taps.length ? ` tapping ${taps.length}` : ""}`);
      }
      case "tap_cards": {
        const ids = strList(input.iids, "iids");
        const tapped = Boolean(input.tapped);
        const events = ids.map((iid) => {
          const c = card(iid);
          mine(ctx, c, "tap your own permanents only");
          if (c.zone.kind !== "battlefield") throw new Error(`${iid} is not on the battlefield`);
          return { type: "CardTapped", payload: { iid, tapped } } as EventInput;
        });
        return ok(events, `${tapped ? "tapped" : "untapped"} ${ids.length}`);
      }
      case "move_card": {
        const c = card(str(input.iid, "iid"));
        const to = str(input.to, "to");
        if (!(ZONE_TARGETS as readonly string[]).includes(to)) throw new Error(`to must be one of ${ZONE_TARGETS.join(", ")}`);
        if (c.zone.kind === "hand" || c.zone.kind === "library") {
          if (c.zone.owner !== me) throw new Error("you cannot touch another player's hand or library");
        }
        const theirs = c.owner !== me;
        if (theirs && (to === "hand" || to === "library_top" || to === "library_bottom" || to === "command")) {
          // Bounce / tuck goes to the OWNER's zone; the reducer enforces that too.
        }
        const owner = to === "battlefield" ? (theirs && c.zone.kind === "battlefield" ? c.zone.owner : me) : c.owner;
        const row = typeof input.row === "string" ? (input.row as Row) : undefined;
        const target =
          to === "library_top"
            ? { kind: "library" as const, owner, position: "top" as const }
            : to === "library_bottom"
              ? { kind: "library" as const, owner, position: "bottom" as const }
              : to === "battlefield"
                ? { kind: "battlefield" as const, owner, ...(row ? { row } : {}) }
                : { kind: to as "hand" | "graveyard" | "exile" | "command", owner };
        return ok([{ type: "CardMoved", payload: { iid: c.iid, to: target } }], `moved ${nameOf(c)} to ${to}`);
      }
      case "attach": {
        const c = card(str(input.iid, "iid"));
        mine(ctx, c, "attach only your own auras/equipment");
        const to = input.to_iid === null || input.to_iid === undefined ? null : str(input.to_iid, "to_iid");
        if (to) card(to);
        return ok([{ type: "Attached", payload: { iid: c.iid, to } }], to ? `attached ${nameOf(c)} to ${to}` : `unattached ${nameOf(c)}`);
      }
      case "change_counters": {
        const c = card(str(input.iid, "iid"));
        const kind = str(input.kind, "kind").slice(0, 20);
        const delta = int(input.delta, "delta", -50, 50);
        if (delta === 0) throw new Error("delta must not be 0");
        return ok([{ type: "CounterChanged", payload: { iid: c.iid, kind, delta } }], `${delta > 0 ? "+" : ""}${delta} ${kind} on ${nameOf(c)}`);
      }
      case "change_life": {
        const player = findPlayer(ctx, str(input.player, "player"));
        const delta = int(input.delta, "delta", -200, 200);
        if (delta === 0) throw new Error("delta must not be 0");
        return ok([{ type: "LifeChanged", payload: { player, delta } }], `${ctx.view.players[player]?.name} ${delta > 0 ? "+" : ""}${delta} life`);
      }
      case "player_counter": {
        const player = findPlayer(ctx, str(input.player, "player"));
        const kind = str(input.kind, "kind").slice(0, 20);
        const delta = int(input.delta, "delta", -50, 50);
        return ok([{ type: "PlayerCounterChanged", payload: { player, kind, delta } }], `${kind} ${delta > 0 ? "+" : ""}${delta} on ${ctx.view.players[player]?.name}`);
      }
      case "commander_damage": {
        const player = findPlayer(ctx, str(input.player, "player"));
        const commanderIid = str(input.commander_iid, "commander_iid");
        const cmd = card(commanderIid);
        if (!cmd.isCommander) throw new Error(`${commanderIid} is not a commander`);
        const delta = int(input.delta, "delta", -50, 50);
        return ok([{ type: "CommanderDamage", payload: { player, commanderIid, delta } }], `commander damage ${delta} to ${ctx.view.players[player]?.name}`);
      }
      case "create_token": {
        const count = int(input.count ?? 1, "count", 1, 20);
        const colors = (Array.isArray(input.colors) ? input.colors : []).filter((c): c is "W" | "U" | "B" | "R" | "G" => typeof c === "string" && "WUBRG".includes(c));
        const custom = {
          name: str(input.name, "name").slice(0, 40),
          typeLine: (typeof input.type_line === "string" && input.type_line.trim() ? input.type_line.trim() : "Token").slice(0, 60),
          power: input.power === null || input.power === undefined ? null : String(input.power).slice(0, 4),
          toughness: input.toughness === null || input.toughness === undefined ? null : String(input.toughness).slice(0, 4),
          colors,
          text: typeof input.text === "string" ? input.text.slice(0, 300) : "",
        };
        const row: Row = /\bcreature\b/i.test(custom.typeLine) ? "creatures" : /\bartifact\b/i.test(custom.typeLine) ? "artifacts" : /\benchantment\b/i.test(custom.typeLine) ? "enchantments" : "other";
        return ok([{ type: "TokenCreated", payload: { player: me, printing: null, custom, count, row } }], `created ${count} ${custom.name}`);
      }
      case "draw_cards": {
        const count = int(input.count, "count", 1, 10);
        return ok([{ type: "CardsDrawn", payload: { player: me, count } }], `drew ${count}`);
      }
      case "shuffle_library":
        return ok([{ type: "LibraryShuffled", payload: { player: me } }], "shuffled");
      case "search_library":
        return { ok: true, call: { events: [{ type: "LibrarySearched", payload: { player: me } }], summary: "searched library", resultHint: "library" } };
      case "adjust_mana": {
        const color = str(input.color, "color") as ManaColor;
        if (!(MANA_COLORS as readonly string[]).includes(color)) throw new Error("color must be W/U/B/R/G/C");
        const delta = int(input.delta, "delta", -20, 20);
        return ok([{ type: "ManaChanged", payload: { player: me, color, delta } }], `mana ${color} ${delta}`);
      }
      case "set_step": {
        const step = str(input.step, "step");
        if (ctx.view.activePlayer !== me) throw new Error("not your turn");
        const map: Record<string, "main1" | "attackers" | "main2" | "end"> = { main1: "main1", combat: "attackers", main2: "main2", end: "end" };
        const target = map[step];
        if (!target) throw new Error(`step must be one of ${STEP_TARGETS.join(", ")}`);
        return ok([{ type: "StepSet", payload: { step: target } }], `step ${step}`);
      }
      case "attack": {
        if (ctx.view.activePlayer !== me) throw new Error("you can only attack on your own turn");
        const ids = strList(input.attacker_iids, "attacker_iids");
        if (ids.length === 0) throw new Error("no attackers given");
        const defender = findPlayer(ctx, str(input.defender, "defender"));
        if (defender === me) throw new Error("you cannot attack yourself");
        int(input.total_power ?? 0, "total_power", 0, 500); // accepted for compatibility; the table computes damage itself
        const attacks: Array<{ iid: string; player: string }> = [];
        for (const iid of ids) {
          const c = card(iid);
          mine(ctx, c, "you can only attack with your own creatures");
          if (c.zone.kind !== "battlefield") throw new Error(`${iid} is not on the battlefield`);
          if (c.tapped) throw new Error(`${iid} ${nameOf(c)} is tapped and cannot attack`);
          attacks.push({ iid, player: defender });
        }
        const defName = ctx.view.players[defender]?.name ?? "them";
        return ok([{ type: "AttackersDeclared", payload: { attacks } }], `attacked ${defName} with ${attacks.length} creature(s)`);
      }
      case "resolve_trigger": {
        const id = str(input.id, "id");
        if (!ctx.view.pendingTriggers.some((t) => t.id === id && t.controller === me)) throw new Error(`no pending trigger ${id} of yours`);
        return ok([{ type: "TriggerResolved", payload: { id } }], `resolved trigger ${id}`);
      }
      case "dismiss_triggers":
        return ok([{ type: "TriggersDismissed", payload: { player: me } }], "dismissed triggers");
      case "flip_card": {
        const c = card(str(input.iid, "iid"));
        mine(ctx, c, "flip your own cards only");
        return ok([{ type: "CardFlipped", payload: { iid: c.iid } }], `flipped ${nameOf(c)}`);
      }
      case "untap_all":
        return ok([{ type: "UntapAll", payload: { player: me } }], "untapped all");
      case "say": {
        const text = str(input.text, "text").slice(0, 200);
        return ok([{ type: "NoteAdded", payload: { player: me, text } }], `said: ${text}`);
      }
      case "pass_turn":
        if (ctx.view.activePlayer !== me) throw new Error("not your turn");
        return { ok: true, call: { events: [{ type: "TurnAdvanced", payload: {} }], summary: "passed the turn", endsTurn: true } };
      case "concede":
        return { ok: true, call: { events: [{ type: "PlayerConceded", payload: { player: me } }], summary: "conceded", endsTurn: true } };
      default:
        throw new Error(`unknown tool ${name}`);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function ok(events: EventInput[], summary: string): MapResult {
  return { ok: true, call: { events, summary } };
}
