import type {
  CardPrinting,
  EngineOption,
  EngineOptionPlayer,
  EnginePrompt,
  PlayerId,
  PlayerView,
} from "@cgwf/shared";
import { findCard } from "./model";

/**
 * The list sheet for engine choices, grouped the way a table reads (owner request 2026-10-20: "a card list of
 * items that we can interact with, separated by player"): one section per player in turn order starting with
 * the viewer, the player as a target at the top of their section, then their cards by zone (battlefield by
 * section, graveyard, exile, command zone, hand, library), then anything on the stack. Pure: only what the
 * engine sent as options is listed, so hidden information stays as the engine describes it.
 */

export interface ChoiceSection {
  key: string;
  label: string;
  options: EngineOption[];
}

export interface PlayerGroup {
  player: PlayerId;
  name: string;
  life: number | null;
  isYou: boolean;
  /** The player themself as an option (a target), shown at the top of their section. */
  playerOption: EngineOptionPlayer | null;
  sections: ChoiceSection[];
}

export interface ChoiceGroups {
  players: PlayerGroup[];
  /** Spells and abilities on the stack. */
  stack: EngineOption[];
  /** Text options and cards nobody at the table owns or controls (shown last, ungrouped). */
  other: EngineOption[];
}

type ListPrompt = Extract<
  EnginePrompt,
  { kind: "targets" | "chooseMany" | "choose" }
>;

/** Whether a list prompt gets the grouped sheet: some option is a card, a player or a stack item. */
export function isGroupedChoice(p: EnginePrompt | null | undefined): boolean {
  if (
    !p ||
    (p.kind !== "targets" && p.kind !== "chooseMany" && p.kind !== "choose")
  )
    return false;
  if (
    p.kind === "chooseMany" &&
    (p.reason === "mulligan" || p.reason === "putBack")
  )
    return false;
  return p.options.some(
    (o) => o.kind === "card" || o.kind === "player" || o.kind === "spell",
  );
}

/** Battlefield sections in reading order, then the other zones. */
const ZONE_ORDER: Array<[string, string]> = [
  ["bf:creatures", "Creatures"],
  ["bf:artifacts", "Artifacts"],
  ["bf:enchantments", "Enchantments"],
  ["bf:lands", "Lands"],
  ["bf:other", "Other permanents"],
  ["graveyard", "Graveyard"],
  ["exile", "Exile"],
  ["command", "Command zone"],
  ["hand", "Hand"],
  ["library", "Library"],
  ["outside the game", "Outside the game"],
];

/** Battlefield section from the type line when the card is not in the view (it usually is). */
function rowOfType(typeLine: string): string {
  const t = typeLine.toLowerCase();
  if (t.includes("creature")) return "creatures";
  if (t.includes("land")) return "lands";
  if (t.includes("planeswalker") || t.includes("battle")) return "other";
  if (t.includes("artifact")) return "artifacts";
  if (t.includes("enchantment")) return "enchantments";
  return "other";
}

function zoneKey(
  o: Extract<EngineOption, { kind: "card" }>,
  view: PlayerView,
  printings: Record<string, CardPrinting>,
): string {
  const zone = o.zone.toLowerCase();
  if (zone === "battlefield") {
    const onTable = findCard(view, o.iid);
    const row =
      onTable && onTable.zone.kind === "battlefield"
        ? onTable.zone.row
        : rowOfType(
            o.printingId ? (printings[o.printingId]?.typeLine ?? "") : "",
          );
    return `bf:${row}`;
  }
  return zone;
}

/** Players in turn order starting with the viewer (spectators: plain turn order). */
export function playerOrder(view: PlayerView, me: PlayerId | null): PlayerId[] {
  const order = view.turnOrder.filter((id) => view.players[id]);
  const i = me ? order.indexOf(me) : -1;
  return i >= 0 ? [...order.slice(i), ...order.slice(0, i)] : order;
}

export function groupOptions(
  options: EngineOption[],
  view: PlayerView,
  me: PlayerId | null,
  printings: Record<string, CardPrinting> = {},
): ChoiceGroups {
  const byPlayer = new Map<
    PlayerId,
    {
      playerOption: EngineOptionPlayer | null;
      zones: Map<string, EngineOption[]>;
    }
  >();
  const stack: EngineOption[] = [];
  const other: EngineOption[] = [];
  const slot = (p: PlayerId) => {
    let g = byPlayer.get(p);
    if (!g) byPlayer.set(p, (g = { playerOption: null, zones: new Map() }));
    return g;
  };
  for (const o of options) {
    if (o.kind === "player") {
      if (view.players[o.player]) slot(o.player).playerOption = o;
      else other.push(o);
    } else if (o.kind === "spell") {
      stack.push(o);
    } else if (o.kind === "card") {
      // battlefield cards belong to their controller; cards in other zones to their owner
      const who =
        o.zone.toLowerCase() === "battlefield"
          ? (o.controller ?? o.owner)
          : (o.owner ?? o.controller);
      if (o.zone.toLowerCase() === "stack") stack.push(o);
      else if (!who || !view.players[who]) other.push(o);
      else {
        const zones = slot(who).zones;
        const key = zoneKey(o, view, printings);
        zones.set(key, [...(zones.get(key) ?? []), o]);
      }
    } else {
      other.push(o);
    }
  }
  const players: PlayerGroup[] = [];
  for (const id of playerOrder(view, me)) {
    const g = byPlayer.get(id);
    if (!g) continue; // nothing to choose from this player: no section
    const p = view.players[id]!;
    const sections: ChoiceSection[] = [];
    for (const [key, label] of ZONE_ORDER) {
      const list = g.zones.get(key);
      if (list?.length) sections.push({ key, label, options: list });
    }
    for (const [key, list] of g.zones)
      if (!ZONE_ORDER.some(([k]) => k === key))
        sections.push({ key, label: key, options: list });
    players.push({
      player: id,
      name: p.name,
      life: p.life ?? null,
      isYou: id === me,
      playerOption: g.playerOption,
      sections,
    });
  }
  return { players, stack, other };
}

/** "Exile", "Destroy", ...: the verb the primary button uses, read from the ability or the title. */
const VERBS = [
  "Exile",
  "Destroy",
  "Return",
  "Sacrifice",
  "Discard",
  "Tap",
  "Untap",
  "Attach",
  "Counter",
  "Copy",
  "Reveal",
  "Search",
  "Mill",
  "Bounce",
  "Fight",
  "Target",
];
export function actionVerb(p: ListPrompt): string {
  const texts = [p.kind === "targets" ? p.ability : "", p.title];
  for (const t of texts) {
    // the first verb of the effect wins ("Exile target nonland permanent", "Sacrifice a creature")
    let best: { verb: string; at: number } | null = null;
    for (const v of VERBS) {
      const m = new RegExp(`\\b${v}\\b`, "i").exec(t);
      if (m && (!best || m.index < best.at)) best = { verb: v, at: m.index };
    }
    if (best && best.verb !== "Target") return best.verb;
  }
  return "Choose";
}

/** "Rhystic Study and Sol Ring", "A, B and C", "A, B, C and 2 more". */
export function joinChoices(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3)
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** "2 of 3 chosen" and the rule ("choose exactly 2", "up to 3", "1 to 3"). */
export function countLine(min: number, max: number, picked: number): string {
  const rule =
    min === max
      ? `choose exactly ${min}`
      : min === 0
        ? `up to ${max}`
        : `${min} to ${max}`;
  return `${picked} of ${max} chosen · ${rule}`;
}
