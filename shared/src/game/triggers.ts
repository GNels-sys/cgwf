import type { CardPrinting } from "../cards.js";
import { cardDisplayName } from "./effects.js";
import type { CardInstance, GameEvent, GameState, PendingTrigger, PlayerId, Step } from "./types.js";

/**
 * Advisory trigger tracker. Given the state AFTER an event was applied and the
 * event itself, list the permanents whose triggered abilities probably fired.
 * Pure and deterministic, so every client can recompute it; the reducer stores
 * the result as pendingTriggers and the players resolve or dismiss them.
 *
 * Families covered: landfall; own-permanent ETB ("whenever a/another creature
 * / artifact / enchantment (constellation) / permanent enters under your
 * control"); the entering card's own "When ~ enters"; and "at the beginning of
 * your/each upkeep / draw step / precombat main phase / combat / end step".
 */

function faceText(p: CardPrinting, face: 0 | 1): string {
  const f = p.faces[face] ?? p.faces[0];
  return f ? f.oracleText : p.oracleText;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TriggerKind = "Landfall" | "Creature ETB" | "Artifact ETB" | "Constellation" | "Permanent ETB" | "ETB" | "Upkeep" | "Draw step" | "Main phase" | "Combat" | "End step";

const STEP_PATTERNS: Array<{ step: Step; re: RegExp; kind: TriggerKind }> = [
  { step: "upkeep", re: /at the beginning of (your|each|each player's) upkeep/i, kind: "Upkeep" },
  { step: "draw", re: /at the beginning of (your|each|each player's) draw step/i, kind: "Draw step" },
  { step: "main1", re: /at the beginning of (your|each|each player's) (precombat main phase|first main phase)/i, kind: "Main phase" },
  { step: "beginCombat", re: /at the beginning of (combat|your combat|each combat)( on your turn)?/i, kind: "Combat" },
  { step: "end", re: /at the beginning of (your|each|each player's) end step/i, kind: "End step" },
];

function battlefield(state: GameState, player: PlayerId): CardInstance[] {
  const p = state.players[player];
  if (!p) return [];
  const out: CardInstance[] = [];
  for (const list of Object.values(p.zones.battlefield)) for (const iid of list) {
    const c = state.cards[iid];
    if (c && !c.faceDown) out.push(c);
  }
  return out;
}

function typeOf(c: CardInstance): string {
  const p = c.printing;
  const face = p ? (p.faces[c.face] ?? p.faces[0]) : undefined;
  return (c.custom?.typeLine ?? face?.typeLine ?? p?.typeLine ?? "").split(" // ")[0]!.toLowerCase();
}

function nameOf(c: CardInstance): string {
  return c.custom?.name ?? (c.printing ? cardDisplayName(c.printing, c.face) : "a card");
}

function textOf(c: CardInstance): string {
  return c.custom?.text ?? (c.printing ? faceText(c.printing, c.face) : "");
}

/** Which ETB families does a permanent's text listen for? */
export function etbListeners(text: string, keywords: readonly string[]): Array<{ kind: TriggerKind; another: boolean }> {
  const out: Array<{ kind: TriggerKind; another: boolean }> = [];
  const t = text.toLowerCase();
  const k = keywords.map((x) => x.toLowerCase());
  if (k.includes("landfall") || /whenever a land (you control )?enters( the battlefield)?( under your control)?/.test(t)) out.push({ kind: "Landfall", another: false });
  let m = t.match(/whenever (a|another) creature (you control )?enters( the battlefield)?( under your control)?/);
  if (m) out.push({ kind: "Creature ETB", another: m[1] === "another" });
  m = t.match(/whenever (a|an|another) ((?:non\w+ )?artifact) (you control )?enters( the battlefield)?( under your control)?/);
  if (m) out.push({ kind: "Artifact ETB", another: m[1] === "another" });
  if (k.includes("constellation") || /whenever (an|another) enchantment (you control )?enters( the battlefield)?( under your control)?/.test(t)) out.push({ kind: "Constellation", another: /another enchantment/.test(t) });
  m = t.match(/whenever (a|another) permanent (you control )?enters( the battlefield)?( under your control)?/);
  if (m) out.push({ kind: "Permanent ETB", another: m[1] === "another" });
  return out;
}

/** Does the card's own text start a "When ~ enters" ability? */
export function hasSelfEtb(text: string, name: string): boolean {
  const first = name.split(",")[0]!.trim();
  const re = new RegExp(`(^|\\n)when (?:${escapeRe(name)}|${escapeRe(first)}|this (?:creature|permanent|artifact|enchantment|land|planeswalker|card)|~) enters(?: the battlefield)?`, "i");
  return re.test(text);
}

function idFor(ev: GameEvent, iid: string, kind: string): string {
  return `${ev.seq}:${iid}:${kind}`;
}

export function detectTriggers(state: GameState, ev: GameEvent): PendingTrigger[] {
  const out: PendingTrigger[] = [];
  const push = (c: CardInstance, kind: TriggerKind) => {
    if (out.some((t) => t.iid === c.iid && t.kind === kind)) return;
    out.push({ id: idFor(ev, c.iid, kind), iid: c.iid, controller: c.zone.owner, kind, name: nameOf(c), seq: ev.seq });
  };

  if (ev.type === "CardMoved" && ev.payload.to.kind === "battlefield") {
    const entering = state.cards[ev.payload.iid];
    if (!entering || entering.zone.kind !== "battlefield" || entering.faceDown) return out;
    const controller = entering.zone.owner;
    const type = typeOf(entering);
    const isLand = /\bland\b/.test(type);
    const isCreature = /\bcreature\b/.test(type);
    const isArtifact = /\bartifact\b/.test(type);
    const isEnchantment = /\benchantment\b/.test(type);
    for (const c of battlefield(state, controller)) {
      for (const l of etbListeners(textOf(c), c.printing?.keywords ?? [])) {
        const self = c.iid === entering.iid;
        if (l.another && self) continue;
        if (l.kind === "Landfall" && isLand) push(c, l.kind);
        else if (l.kind === "Creature ETB" && isCreature) push(c, l.kind);
        else if (l.kind === "Artifact ETB" && isArtifact) push(c, l.kind);
        else if (l.kind === "Constellation" && isEnchantment) push(c, l.kind);
        else if (l.kind === "Permanent ETB") push(c, l.kind);
      }
    }
    if (hasSelfEtb(textOf(entering), nameOf(entering))) push(entering, "ETB");
  } else if (ev.type === "TokenCreated" || ev.type === "CardCopied") {
    // Tokens entering (including token copies): the same ETB families, plus the token's own "When ~ enters".
    const player = ev.type === "TokenCreated" ? ev.payload.player : ev.payload.player;
    const field = battlefield(state, player);
    const newest = field.filter((c) => c.isToken).slice(-(ev.type === "TokenCreated" ? Math.max(1, Math.min(20, Math.floor(ev.payload.count))) : 1));
    for (const tok of newest) {
      const type = typeOf(tok);
      for (const c of field) {
        if (c.iid === tok.iid) continue;
        for (const l of etbListeners(textOf(c), c.printing?.keywords ?? [])) {
          if (l.kind === "Landfall" && /\bland\b/.test(type)) push(c, l.kind);
          else if (l.kind === "Creature ETB" && /\bcreature\b/.test(type)) push(c, l.kind);
          else if (l.kind === "Artifact ETB" && /\bartifact\b/.test(type)) push(c, l.kind);
          else if (l.kind === "Constellation" && /\benchantment\b/.test(type)) push(c, l.kind);
          else if (l.kind === "Permanent ETB") push(c, l.kind);
        }
      }
      if (hasSelfEtb(textOf(tok), nameOf(tok))) push(tok, "ETB");
    }
  } else if (ev.type === "StepAdvanced" || ev.type === "StepSet" || ev.type === "TurnAdvanced") {
    if (state.phase !== "playing") return out;
    const pattern = STEP_PATTERNS.find((s) => s.step === state.step);
    if (!pattern) return out;
    for (const player of state.turnOrder) {
      const mine = player === state.activePlayer;
      for (const c of battlefield(state, player)) {
        const m = textOf(c).match(pattern.re);
        if (!m) continue;
        const who = (m[1] ?? "").toLowerCase();
        const each = who.startsWith("each");
        if (mine || each) push(c, pattern.kind);
      }
    }
  }
  return out;
}
