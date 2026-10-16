import { STEP_LABELS, viewCardName, type CardPrinting, type PlayerId, type PlayerView, type ViewCard, type ViewPlayer } from "@cgwf/shared";

/**
 * Renders what an agent is allowed to know into text. The ONLY input is the
 * per-player view from shared/src/game/view.ts (built for the agent's own id)
 * plus the printings that view references, so hidden information cannot leak
 * here: other hands and every library arrive as counts only. Proved by
 * prompt.test.ts.
 */
export type Printings = Record<string, CardPrinting>;

export interface PromptDeck {
  name: string;
  commanders: string[];
  primer: string;
}

export interface SystemPromptInput {
  agentName: string;
  rulesPrimer: string;
  effectsPrimer: string;
  deck: PromptDeck;
}

const ORACLE_OWN = 260;
const ORACLE_OTHER = 110;
const LOG_TAIL = 14;

function squash(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function faceOf(c: ViewCard, p: CardPrinting) {
  return p.faces[c.face] ?? p.faces[0] ?? null;
}

/** `c12 Krenko, Mob Boss {2}{R}{R} [Legendary Creature — Goblin Warrior] 3/3 (tapped, +1/+1 x2)`. */
export function cardLine(c: ViewCard, printings: Printings, oracleMax: number): string {
  const name = c.faceDown && !c.printingId && !c.custom ? "Face-down card" : viewCardName(c, printings);
  const p = c.printingId ? printings[c.printingId] : undefined;
  const face = p ? faceOf(c, p) : null;
  const parts: string[] = [`${c.iid} ${name}`];
  if (p) {
    const cost = face?.manaCost || p.manaCost;
    if (cost) parts.push(cost);
    const type = face?.typeLine || p.typeLine;
    if (type) parts.push(`[${type}]`);
    const pw = face?.power ?? p.power;
    const tg = face?.toughness ?? p.toughness;
    if (pw !== null && pw !== undefined && tg !== null && tg !== undefined) parts.push(`${pw}/${tg}`);
    const loy = face?.loyalty ?? p.loyalty;
    if (loy) parts.push(`loyalty ${loy}`);
  } else if (c.custom) {
    parts.push(`[${c.custom.typeLine}]`);
    if (c.custom.power !== null && c.custom.toughness !== null) parts.push(`${c.custom.power}/${c.custom.toughness}`);
  }
  const flags: string[] = [];
  if (c.tapped) flags.push("tapped");
  if (c.faceDown) flags.push("face-down");
  if (c.isToken) flags.push("token");
  if (c.isCommander) flags.push("commander");
  for (const [k, v] of Object.entries(c.counters)) if (v) flags.push(`${k} x${v}`);
  if (c.attachedTo) flags.push(`attached to ${c.attachedTo}`);
  if (c.effect) flags.push(`grants ${c.effect.power >= 0 ? "+" : ""}${c.effect.power}/${c.effect.toughness >= 0 ? "+" : ""}${c.effect.toughness}${c.effect.keywords.length ? ` ${c.effect.keywords.join(", ")}` : ""}`);
  if (c.modifier && (c.modifier.power || c.modifier.toughness || c.modifier.keywords.length)) flags.push(`manual ${c.modifier.power}/${c.modifier.toughness} ${c.modifier.keywords.join(", ")}`.trim());
  if (flags.length) parts.push(`(${flags.join(", ")})`);
  let line = parts.join(" ");
  const text = face?.oracleText || p?.oracleText || c.custom?.text || "";
  if (text && oracleMax > 0) line += ` — ${squash(text, oracleMax)}`;
  return line;
}

function sectionLines(p: ViewPlayer, printings: Printings, oracleMax: number): string[] {
  const out: string[] = [];
  const rows: Array<[string, ViewCard[]]> = [
    ["Creatures", p.battlefield.creatures],
    ["Other", p.battlefield.other],
    ["Enchantments", p.battlefield.enchantments],
    ["Artifacts", p.battlefield.artifacts],
    ["Lands", p.battlefield.lands],
  ];
  for (const [label, cards] of rows) {
    if (cards.length === 0) continue;
    if (label === "Lands") {
      // Lands are many and simple: name + tapped flag only, grouped.
      const counts = new Map<string, { n: number; tapped: number; ids: string[] }>();
      for (const c of cards) {
        const name = viewCardName(c, printings);
        const e = counts.get(name) ?? { n: 0, tapped: 0, ids: [] };
        e.n++;
        if (c.tapped) e.tapped++;
        e.ids.push(c.iid + (c.tapped ? "(T)" : ""));
        counts.set(name, e);
      }
      const untapped = cards.filter((c) => !c.tapped).length;
      out.push(`  Lands (${cards.length}, ${untapped} untapped): ${[...counts.entries()].map(([name, e]) => `${name} x${e.n} [${e.ids.join(" ")}]`).join("; ")}`);
      continue;
    }
    out.push(`  ${label}:`);
    for (const c of cards) out.push(`    ${cardLine(c, printings, oracleMax)}`);
  }
  return out;
}

function playerBlock(p: ViewPlayer, me: PlayerId, printings: Printings): string[] {
  const mine = p.id === me;
  const out: string[] = [];
  const counters = Object.entries(p.counters)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const cmdDmg = Object.values(p.commanderDamage).reduce((a, b) => a + b, 0);
  out.push(
    `${mine ? "YOU" : p.name} (seat ${p.seat + 1}${mine ? "" : ", opponent"}): life ${p.life}${counters ? `, ${counters}` : ""}${cmdDmg ? `, commander damage taken ${cmdDmg}` : ""}${p.conceded ? ", CONCEDED" : ""}; hand ${p.hand.count}, library ${p.library.count}, graveyard ${p.graveyard.length}, exile ${p.exile.length}`,
  );
  if (p.command.length) out.push(`  Command zone: ${p.command.map((c) => `${cardLine(c, printings, mine ? ORACLE_OWN : ORACLE_OTHER)}${p.commanderTax[c.iid] ? ` (tax +{${p.commanderTax[c.iid]}})` : ""}`).join("; ")}`);
  const field = sectionLines(p, printings, mine ? ORACLE_OWN : ORACLE_OTHER);
  if (field.length) out.push(...field);
  else out.push("  Battlefield: empty");
  if (p.graveyard.length) out.push(`  Graveyard (newest last): ${p.graveyard.slice(-8).map((c) => `${c.iid} ${viewCardName(c, printings)}`).join(", ")}${p.graveyard.length > 8 ? " …" : ""}`);
  if (p.exile.length) out.push(`  Exile: ${p.exile.slice(-6).map((c) => `${c.iid} ${viewCardName(c, printings)}`).join(", ")}`);
  if (p.manualAnthems.length) out.push(`  Anthems noted: ${p.manualAnthems.map((a) => `${a.power >= 0 ? "+" : ""}${a.power}/${a.toughness >= 0 ? "+" : ""}${a.toughness} ${a.keywords.join(" ")} (${a.note})`).join("; ")}`);
  return out;
}

/** The whole situation, from the agent's seat. */
export function renderState(view: PlayerView, printings: Printings, me: PlayerId): string {
  const mePlayer = view.players[me];
  if (!mePlayer) throw new Error("renderState: viewer is not a player");
  const out: string[] = [];
  const active = view.players[view.activePlayer];
  out.push(`Turn ${view.turn}, step ${STEP_LABELS[view.step]}, active player: ${view.activePlayer === me ? "YOU" : (active?.name ?? "?")}. Phase: ${view.phase}.`);
  out.push("");
  out.push("== Players ==");
  for (const id of view.turnOrder) {
    const p = view.players[id];
    if (!p) continue;
    out.push(...playerBlock(p, me, printings));
    out.push("");
  }
  out.push("== Your hand ==");
  if (mePlayer.hand.cards.length === 0) out.push("  (empty)");
  for (const c of mePlayer.hand.cards) out.push(`  ${cardLine(c, printings, ORACLE_OWN)}`);
  if (mePlayer.library.known.length) {
    out.push("== Known cards in your library ==");
    for (const c of mePlayer.library.known.slice(0, 40)) out.push(`  ${c.position !== undefined ? `#${c.position + 1} ` : ""}${cardLine(c, printings, 0)}`);
  }
  const mana = Object.entries(mePlayer.mana)
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${c}${n}`)
    .join(" ");
  if (mana) out.push(`== Your mana pool == ${mana}`);
  const triggers = view.pendingTriggers.filter((t) => t.controller === me);
  if (triggers.length) {
    out.push("== Your pending triggers (apply with tools, then resolve_trigger) ==");
    for (const t of triggers) out.push(`  ${t.id}: ${t.kind} from ${t.name} (${t.iid})`);
  }
  if (view.log.length) {
    out.push("== Recent log ==");
    for (const l of view.log.slice(-LOG_TAIL)) out.push(`  #${l.seq} ${l.text}`);
  }
  if (view.winner) out.push(`== Game over: ${view.players[view.winner]?.name ?? view.winner} won ==`);
  return out.join("\n");
}

/** A shorter re-render used between tool batches within one turn. */
export function renderDelta(view: PlayerView, printings: Printings, me: PlayerId): string {
  const mePlayer = view.players[me];
  if (!mePlayer) return "";
  const out: string[] = [];
  out.push(`Turn ${view.turn}, step ${STEP_LABELS[view.step]}, active: ${view.activePlayer === me ? "YOU" : (view.players[view.activePlayer]?.name ?? "?")}.`);
  out.push(`Life: ${view.turnOrder.map((id) => `${id === me ? "you" : view.players[id]?.name} ${view.players[id]?.life}`).join(", ")}.`);
  out.push("Your battlefield:");
  const field = sectionLines(mePlayer, printings, 0);
  out.push(...(field.length ? field : ["  empty"]));
  out.push("Your hand:");
  if (mePlayer.hand.cards.length === 0) out.push("  (empty)");
  for (const c of mePlayer.hand.cards) out.push(`  ${cardLine(c, printings, 0)}`);
  const triggers = view.pendingTriggers.filter((t) => t.controller === me);
  if (triggers.length) out.push(`Pending triggers: ${triggers.map((t) => `${t.id} ${t.kind} (${t.name})`).join("; ")}`);
  out.push("Recent log:");
  for (const l of view.log.slice(-6)) out.push(`  #${l.seq} ${l.text}`);
  return out.join("\n");
}

export function systemPrompt(input: SystemPromptInput): string {
  return [
    `You are ${input.agentName}, a computer opponent at a casual Commander table. You play to win within the rules, politely, and you keep the game moving.`,
    "",
    "Reply with ONE short sentence of rationale, then call tools. Use several tool calls in one reply when they belong together (tap lands + cast). End every turn of yours with pass_turn. Never write card identities you cannot see; never pretend to know hidden cards.",
    "",
    input.rulesPrimer.trim(),
    "",
    input.effectsPrimer.trim(),
    "",
    `# Your deck: ${input.deck.name}`,
    `Commander: ${input.deck.commanders.join(" / ") || "(none)"}`,
    "",
    input.deck.primer.trim() || "(no primer: play the deck straightforwardly - ramp, deploy threats, attack when safe)",
  ].join("\n");
}

export function turnInstruction(kind: "turn" | "trigger" | "continue"): string {
  switch (kind) {
    case "turn":
      return "It is YOUR turn and you are in your first main phase (the table already untapped and drew for you). Play your turn with tools: land, spells with their mana, combat if good, then pass_turn.";
    case "trigger":
      return "It is NOT your turn. The table noticed triggers on your permanents (listed above). Apply what actually triggers with tools and resolve or dismiss them. Do not take other actions; do not pass the turn.";
    case "continue":
      return "Continue your turn, or call pass_turn if you are done.";
  }
}
