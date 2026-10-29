import {
  EMPTY_MANA,
  defaultSection,
  type CardPrinting,
  type CombatState,
  type EngineAnswer,
  type EngineEntityRef,
  type EngineInfo,
  type EngineOption,
  type EngineOptionCard,
  type EnginePhase,
  type EnginePlayable,
  type EnginePrompt,
  type LogEntry,
  type PlayerId,
  type PlayerView,
  type StackItem,
  type StackTargetRef,
  type Step,
  type ViewCard,
  type ViewPlayer,
} from "@cgwf/shared";

/**
 * Pure conversion of the engine's per-seat frames into the PlayerView the browser already
 * understands. The engine decided what the seat may see (SeatView.java); this file only changes
 * shape: Forge ids become CGwF user ids, cards get Scryfall printing ids, Forge steps become our
 * steps. Nothing here may ADD information: a card without `name` stays identity-less.
 */

export interface SeatInfo {
  seat: number;
  userId: PlayerId;
  name: string;
  /** Forge's player id for this seat (from gameCreated). */
  playerId: number;
}

/** Raw card object as the engine emits it (SeatView.card). */
export interface EngineCardJson {
  id: number;
  zone: string | null;
  controller: number | null;
  owner: number | null;
  tapped: boolean;
  faceDown: boolean;
  token: boolean;
  commander?: boolean;
  damage?: number;
  sick?: boolean;
  /** Colour letters the permanent can tap for ("any" for any-colour sources); battlefield only. */
  mana?: string[];
  attachedTo?: { kind: "player" | "card"; id: number } | null;
  counters?: Record<string, number>;
  name?: string;
  set?: string;
  scryfallSet?: string;
  number?: string | null;
  types?: string;
  manaCost?: string;
  power?: number;
  toughness?: number;
  // prompt-only extras
  index?: number;
  kind?: string;
  canAttack?: Array<{ kind: "player" | "card"; id: number; name?: string | null }>;
  canBlock?: number[];
  attacking?: { kind: "player" | "card"; id: number; name?: string | null };
}

export interface EnginePlayerJson {
  id: number;
  seat: number;
  name: string;
  isYou: boolean;
  human: boolean;
  life: number;
  poison: number;
  lost: boolean;
  handCount: number;
  libraryCount: number;
  landsPlayedThisTurn: number;
  commanderDamage: Record<string, number>;
  manaPool?: Record<string, number>;
  hand?: EngineCardJson[];
  battlefield: EngineCardJson[];
  graveyard: EngineCardJson[];
  exile: EngineCardJson[];
  command: EngineCardJson[];
}

export interface EngineStateJson {
  type: "state";
  turn: number;
  /** Rounds for people (engine RoundTracker); Forge's turn stays the truth. */
  round?: number;
  phase: EnginePhase | null;
  activePlayer: number | null;
  priorityPlayer: number | null;
  viewer: number | null;
  gameOver: boolean;
  winner?: string | null;
  endReason?: string | null;
  players: EnginePlayerJson[];
  stack: Array<{
    id: number;
    description: string;
    kind?: "spell" | "ability" | "trigger";
    sourceCardId?: number;
    sourceName?: string;
    card?: EngineCardJson;
    activatingPlayer: number | null;
    targets?: Array<{ kind: "card" | "player" | "stack"; id: number; name?: string | null; cardId?: number }>;
  }>;
  combat: { attackingPlayer: number; attackers: Array<{ cardId: number; defender?: { kind: "player" | "card"; id: number }; blockedBy: number[] }> } | null;
  log: Array<{ type: string; text: string }>;
}

export interface ConvertContext {
  viewer: PlayerId | null;
  seats: SeatInfo[];
  /** Resolve a card's printing (may learn from the identity fields on the card). */
  printingOf: (card: EngineCardJson) => CardPrinting | null;
  /** The relay's accumulated engine log (newest last). */
  log: LogEntry[];
  seq: number;
  engine: Omit<EngineInfo, "phase">;
}

export const PHASE_TO_STEP: Record<EnginePhase, Step> = {
  UNTAP: "untap",
  UPKEEP: "upkeep",
  DRAW: "draw",
  MAIN1: "main1",
  COMBAT_BEGIN: "beginCombat",
  COMBAT_DECLARE_ATTACKERS: "attackers",
  COMBAT_DECLARE_BLOCKERS: "blockers",
  COMBAT_FIRST_STRIKE_DAMAGE: "damage",
  COMBAT_DAMAGE: "damage",
  COMBAT_END: "endCombat",
  MAIN2: "main2",
  END_OF_TURN: "end",
  CLEANUP: "cleanup",
};

export function stepOf(phase: EnginePhase | null | undefined): Step {
  return phase ? (PHASE_TO_STEP[phase] ?? "main1") : "untap";
}

function userOf(seats: SeatInfo[], forgeId: number | null | undefined): PlayerId | null {
  if (forgeId === null || forgeId === undefined) return null;
  return seats.find((s) => s.playerId === forgeId)?.userId ?? null;
}

function zoneKind(zone: string | null | undefined): ViewCard["zone"]["kind"] {
  switch (zone) {
    case "Hand":
      return "hand";
    case "Library":
      return "library";
    case "Graveyard":
      return "graveyard";
    case "Exile":
      return "exile";
    case "Command":
      return "command";
    default:
      return "battlefield";
  }
}

/** Where an option card is, in words for the choice list (Forge's sideboard holds a companion: outside the game). */
function optionZone(zone: string | null | undefined): string {
  if (zone === "Sideboard") return "outside the game";
  if (zone === "Stack") return "stack";
  return zoneKind(zone);
}

export function toViewCard(c: EngineCardJson, ctx: ConvertContext, printings: Map<string, CardPrinting>): ViewCard {
  const printing = c.name ? ctx.printingOf(c) : null;
  if (printing) printings.set(printing.id, printing);
  const kind = zoneKind(c.zone);
  const ownerUser = userOf(ctx.seats, c.controller ?? c.owner) ?? userOf(ctx.seats, c.owner) ?? "";
  const typeLine = printing?.typeLine ?? c.types ?? "";
  const zone: ViewCard["zone"] = kind === "battlefield" ? { kind, owner: ownerUser, row: defaultSection(typeLine) } : { kind, owner: ownerUser };
  const out: ViewCard = {
    iid: String(c.id),
    printingId: printing?.id ?? null,
    custom: c.name && !printing ? { name: c.name, typeLine: c.types ?? "", power: c.power === undefined ? null : String(c.power), toughness: c.toughness === undefined ? null : String(c.toughness), colors: [], text: "" } : null,
    owner: userOf(ctx.seats, c.owner) ?? ownerUser,
    zone,
    tapped: Boolean(c.tapped),
    faceDown: Boolean(c.faceDown),
    face: 0,
    counters: c.counters ?? {},
    attachedTo: c.attachedTo && c.attachedTo.kind === "card" ? String(c.attachedTo.id) : null,
    isToken: Boolean(c.token),
    isCommander: Boolean(c.commander),
    effect: null,
    modifier: null,
    anthemDismissed: false,
    public: Boolean(c.name) && kind !== "hand" && kind !== "library",
    engine: { power: c.power ?? null, toughness: c.toughness ?? null, damage: c.damage ?? 0, sick: Boolean(c.sick), ...(Array.isArray(c.mana) && c.mana.length ? { mana: c.mana.map(String) } : {}) },
  };
  return out;
}

function toViewPlayer(p: EnginePlayerJson, ctx: ConvertContext, printings: Map<string, CardPrinting>): ViewPlayer | null {
  // The engine stamps the table seat on every player; Forge's player id is the fallback (older frames).
  const seat = (typeof p.seat === "number" && p.seat >= 0 ? ctx.seats.find((s) => s.seat === p.seat) : undefined) ?? ctx.seats.find((s) => s.playerId === p.id);
  if (!seat) return null;
  const list = (cards: EngineCardJson[] | undefined) => (cards ?? []).map((c) => toViewCard(c, ctx, printings));
  const battlefield: ViewPlayer["battlefield"] = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
  for (const vc of list(p.battlefield)) battlefield[vc.zone.row ?? "other"].push(vc);
  const commanderDamage: Record<string, number> = {};
  for (const [cardId, n] of Object.entries(p.commanderDamage ?? {})) commanderDamage[String(cardId)] = n;
  const mana = { ...EMPTY_MANA };
  for (const [k, v] of Object.entries(p.manaPool ?? {})) if (k in mana) mana[k as keyof typeof mana] = v;
  const own = seat.userId === ctx.viewer;
  return {
    id: seat.userId,
    name: seat.name,
    seat: seat.seat,
    life: p.life,
    counters: p.poison ? { poison: p.poison } : {},
    commanderDamage,
    commanderTax: {},
    mulligans: 0,
    kept: true,
    toBottom: 0,
    conceded: false,
    eliminated: p.lost ? "life" : null,
    mana,
    keepMana: false,
    manualAnthems: [],
    library: { count: p.libraryCount, known: [] },
    hand: { count: p.handCount, cards: own ? list(p.hand) : [] },
    graveyard: list(p.graveyard),
    exile: list(p.exile),
    command: list(p.command),
    battlefield,
  };
}

function toCombat(s: EngineStateJson, ctx: ConvertContext): CombatState | null {
  if (!s.combat) return null;
  const attacker = userOf(ctx.seats, s.combat.attackingPlayer);
  if (!attacker) return null;
  const attackers: CombatState["attackers"] = [];
  const blockers: CombatState["blockers"] = [];
  for (const a of s.combat.attackers) {
    const def = a.defender;
    let player: PlayerId | null = null;
    let planeswalker: string | null = null;
    if (def?.kind === "player") player = userOf(ctx.seats, def.id);
    else if (def) {
      planeswalker = String(def.id);
      // the controller of the attacked permanent: look it up in the view's battlefields
      for (const p of s.players) {
        if (p.battlefield.some((c) => c.id === def.id)) player = userOf(ctx.seats, p.id);
      }
    }
    if (!player) continue;
    attackers.push({ iid: String(a.cardId), player, planeswalker });
    for (const b of a.blockedBy) blockers.push({ iid: String(b), attacker: String(a.cardId), player });
  }
  return { attacker, attackers, blockers, blockersDeclared: [], tappedByAttack: [], damageDealt: false };
}

/** Engine `state` frame -> PlayerView (+ the printings the view references). */
export function engineToView(s: EngineStateJson, ctx: ConvertContext): { view: PlayerView; printings: Map<string, CardPrinting> } {
  const printings = new Map<string, CardPrinting>();
  const players: Record<PlayerId, ViewPlayer> = {};
  for (const p of s.players) {
    const vp = toViewPlayer(p, ctx, printings);
    if (vp) players[vp.id] = vp;
  }
  const turnOrder = ctx.seats
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((x) => x.userId)
    .filter((id) => players[id]);
  const active = userOf(ctx.seats, s.activePlayer) ?? turnOrder[0] ?? "";
  const stack: StackItem[] = s.stack.map((si) => {
    const printing = si.card && si.card.name ? ctx.printingOf(si.card) : null;
    if (printing) printings.set(printing.id, printing);
    const targets: StackTargetRef[] = [];
    for (const t of si.targets ?? []) {
      if (t.kind === "card") targets.push({ kind: "card", iid: String(t.id), name: t.name ?? null });
      else if (t.kind === "player") {
        const player = userOf(ctx.seats, t.id);
        if (player) targets.push({ kind: "player", player });
      } else targets.push({ kind: "stack", id: String(t.id), name: t.name ?? null, iid: t.cardId === undefined ? null : String(t.cardId) });
    }
    const item: StackItem = {
      id: String(si.id),
      controller: userOf(ctx.seats, si.activatingPlayer) ?? active,
      sourceIid: si.sourceCardId === undefined ? null : String(si.sourceCardId),
      description: cleanEngineText(si.description),
      kind: si.kind ?? "spell",
      name: si.sourceName ?? si.card?.name ?? null,
      printingId: printing?.id ?? null,
      targets,
    };
    return item;
  });
  let winner: PlayerId | null = null;
  if (s.gameOver && s.winner) {
    const w = ctx.seats.find((x) => x.name === s.winner);
    winner = w?.userId ?? null;
  }
  const view: PlayerView = {
    viewer: ctx.viewer,
    phase: s.gameOver ? "ended" : "playing",
    players,
    turnOrder,
    activePlayer: active,
    turn: s.turn,
    round: typeof s.round === "number" && s.round > 0 ? s.round : null,
    step: stepOf(s.phase),
    stack,
    priority: userOf(ctx.seats, s.priorityPlayer),
    log: ctx.log.slice(-200),
    seq: ctx.seq,
    winner,
    pendingTriggers: [],
    drewForTurn: true,
    combat: toCombat(s, ctx),
    winAdvisories: [],
    engine: { ...ctx.engine, phase: s.phase ?? null },
  };
  return { view, printings };
}

// ---------------------------------------------------------------- prompts

interface RawEntityRef {
  kind: "player" | "card";
  id: number;
  name?: string | null;
  life?: number;
  controller?: number | null;
}

function toEntityRef(r: RawEntityRef, ctx: ConvertContext): EngineEntityRef | null {
  if (r.kind === "player") {
    const player = userOf(ctx.seats, r.id);
    if (!player) return null;
    const out: EngineEntityRef = { kind: "player", player };
    if (r.name) out.name = r.name;
    if (r.life !== undefined) out.life = r.life;
    return out;
  }
  return { kind: "card", iid: String(r.id), name: r.name ?? null, controller: userOf(ctx.seats, r.controller) };
}

function toOptionCard(c: EngineCardJson, ctx: ConvertContext): EngineOptionCard {
  const printing = c.name ? ctx.printingOf(c) : null;
  const out: EngineOptionCard = {
    kind: "card",
    index: c.index ?? 0,
    iid: String(c.id),
    name: c.name ?? "Card",
    printingId: printing?.id ?? null,
    zone: optionZone(c.zone),
    controller: userOf(ctx.seats, c.controller),
    owner: userOf(ctx.seats, c.owner),
    tapped: Boolean(c.tapped),
    power: c.power ?? null,
    toughness: c.toughness ?? null,
  };
  if (c.canAttack) out.canAttack = c.canAttack.map((d) => toEntityRef(d, ctx)).filter((d): d is EngineEntityRef => d !== null);
  if (c.canBlock) out.canBlock = c.canBlock.map(String);
  if (c.attacking) {
    const ref = toEntityRef(c.attacking, ctx);
    if (ref) out.attacking = ref;
  }
  return out;
}

function toOption(o: Record<string, unknown>, ctx: ConvertContext): EngineOption | null {
  const kind = o.kind;
  const index = Number(o.index ?? 0);
  if (kind === "card") return toOptionCard(o as unknown as EngineCardJson, ctx);
  if (kind === "player") {
    const player = userOf(ctx.seats, Number(o.id));
    if (!player) return null;
    const out: EngineOptionPlayerOut = { kind: "player", index, player, name: String(o.name ?? "") };
    return out;
  }
  if (kind === "spell") {
    return { kind: "spell", index, label: String(o.name ?? o.label ?? ""), iid: o.cardId === undefined || o.cardId === null ? null : String(o.cardId), stackId: typeof o.stackId === "number" ? o.stackId : null };
  }
  return { kind: "text", index, label: String(o.name ?? o.label ?? "") };
}
type EngineOptionPlayerOut = Extract<EngineOption, { kind: "player" }>;

function options(raw: unknown, ctx: ConvertContext): EngineOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => toOption(o as Record<string, unknown>, ctx)).filter((o): o is EngineOption => o !== null);
}

function cardsOnly(raw: unknown, ctx: ConvertContext): EngineOptionCard[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => toOptionCard(c as EngineCardJson, ctx));
}

/** Engine `prompt` frame -> EnginePrompt for the browser. */
/** Forge's stack text names cards with their internal ids ("Shock (108) deals 2 damage"); players never see those ids. */
export function cleanEngineText(text: string): string {
  return String(text ?? "")
    .replace(/ \((\d+)\)/g, "")
    .replace(/\[([^\]]+)\]/g, "$1") // "targeting [Blair]"
    .trim();
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function toEnginePrompt(raw: Record<string, unknown>, ctx: ConvertContext): EnginePrompt | null {
  const promptId = Number(raw.promptId);
  const title = String(raw.title ?? "");
  switch (raw.prompt) {
    case "priority": {
      const opts: EnginePlayable[] = Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>).map((o) => ({
            index: Number(o.index),
            iid: String(o.cardId),
            cardName: String(o.cardName ?? ""),
            zone: zoneKind(o.zone as string),
            kind: (o.kind as EnginePlayable["kind"]) ?? "ability",
            description: String(o.description ?? ""),
            cost: o.cost === null || o.cost === undefined ? null : String(o.cost),
            targets: Boolean(o.targets),
          }))
        : [];
      return { kind: "priority", promptId, title, options: opts, phase: (raw.phase as EnginePhase) ?? null, myTurn: Boolean(raw.myTurn), stackEmpty: Boolean(raw.stackEmpty), stackTopMine: Boolean(raw.stackTopMine), holding: Boolean(raw.holding), threat: typeof raw.threat === "string" && raw.threat ? raw.threat : null };
    }
    case "targets":
      return { kind: "targets", promptId, title, ability: String(raw.ability ?? ""), source: str(raw.source), min: Number(raw.min ?? 1), max: Number(raw.max ?? 1), options: options(raw.options, ctx), cancelLabel: str(raw.cancelLabel) };
    case "attackers": {
      const defenders = Array.isArray(raw.defenders) ? (raw.defenders as RawEntityRef[]).map((d) => toEntityRef(d, ctx)).filter((d): d is EngineEntityRef => d !== null) : [];
      return { kind: "attackers", promptId, title, candidates: cardsOnly(raw.candidates, ctx), defenders };
    }
    case "blockers":
      return { kind: "blockers", promptId, title, attackers: cardsOnly(raw.attackers, ctx), blockers: cardsOnly(raw.blockers, ctx) };
    case "choose":
      return { kind: "choose", promptId, title, optional: Boolean(raw.optional), source: raw.source == null ? null : String(raw.source), options: options(raw.options, ctx) };
    case "chooseMany": {
      const out: Extract<EnginePrompt, { kind: "chooseMany" }> = { kind: "chooseMany", promptId, title, min: Number(raw.min ?? 0), max: Number(raw.max ?? 0), source: raw.source == null ? null : String(raw.source), options: options(raw.options, ctx) };
      if (typeof raw.reason === "string") out.reason = raw.reason;
      return out;
    }
    case "confirm":
      return {
        kind: "confirm",
        promptId,
        title,
        detail: str(raw.detail),
        mode: str(raw.mode),
        options: Array.isArray(raw.options) && (raw.options as unknown[]).length >= 2 ? (raw.options as unknown[]).slice(0, 2).map(String) : ["Yes", "No"],
        source: str(raw.source),
        card: raw.card && typeof raw.card === "object" ? toOptionCard(raw.card as EngineCardJson, ctx) : null,
      };
    case "mulligan":
      return {
        kind: "mulligan",
        promptId,
        title,
        cardsToReturn: Number(raw.cardsToReturn ?? 0),
        hand: cardsOnly(raw.hand, ctx),
        ...(Array.isArray(raw.serumPowder) && raw.serumPowder.length ? { serumPowder: raw.serumPowder.map((id) => String(id)) } : {}),
        ...(typeof raw.mulligans === "number" ? { mulligans: raw.mulligans } : {}),
        ...(typeof raw.freeMulligans === "number" ? { freeMulligans: raw.freeMulligans } : {}),
        ...(typeof raw.nextBottom === "number" ? { nextBottom: raw.nextBottom } : {}),
      };
    case "number":
      return { kind: "number", promptId, title, source: str(raw.source), min: Number(raw.min ?? 0), max: Number(raw.max ?? 0), values: Array.isArray(raw.values) ? (raw.values as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : null };
    case "order":
      return {
        kind: "order",
        promptId,
        title,
        source: str(raw.source),
        note: str(raw.note),
        items: options(raw.items, ctx),
        buckets: Array.isArray(raw.buckets) ? (raw.buckets as unknown[]).map(String) : null,
        defaultBucket: str(raw.defaultBucket),
      };
    case "assign": {
      const lethal: Record<number, number> = {};
      if (Array.isArray(raw.targets)) {
        for (const t of raw.targets as Array<Record<string, unknown>>) if (typeof t.lethal === "number") lethal[Number(t.index ?? 0)] = t.lethal;
      }
      return {
        kind: "assign",
        promptId,
        title,
        source: str(raw.source),
        total: Number(raw.total ?? 0),
        card: raw.card && typeof raw.card === "object" ? toOptionCard(raw.card as EngineCardJson, ctx) : null,
        targets: options(raw.targets, ctx),
        lethal,
      };
    }
    case "mode":
      return {
        kind: "mode",
        promptId,
        title,
        source: str(raw.source),
        min: Number(raw.min ?? 1),
        max: Number(raw.max ?? 1),
        allowRepeat: Boolean(raw.allowRepeat),
        modes: Array.isArray(raw.modes) ? (raw.modes as Array<Record<string, unknown>>).map((m, i) => ({ index: Number(m.index ?? i), text: String(m.text ?? "") })) : [],
      };
    case "text":
      return { kind: "text", promptId, title, source: str(raw.source), freeText: Boolean(raw.freeText), hint: str(raw.hint) };
    default:
      return null;
  }
}

/** Browser answer -> engine answer (iids back to Forge card ids, user ids back to Forge player ids). */
export function toEngineAnswer(answer: EngineAnswer, ctx: ConvertContext): Record<string, unknown> {
  const forgeIdOf = (userId: PlayerId): number | null => ctx.seats.find((s) => s.userId === userId)?.playerId ?? null;
  const ref = (r: EngineEntityRef) => (r.kind === "player" ? { kind: "player", id: forgeIdOf(r.player) } : { kind: "card", id: Number(r.iid) });
  const out: Record<string, unknown> = { promptId: answer.promptId };
  if ("attacks" in answer) {
    out.attacks = answer.attacks.map((a) => ({ cardId: Number(a.iid), defender: ref(a.defender) }));
  } else if ("blocks" in answer) {
    out.blocks = answer.blocks.map((b) => ({ blockerId: Number(b.blockerIid), attackerId: Number(b.attackerIid) }));
  } else if ("options" in answer) {
    out.options = answer.options.map((n) => Number(n));
    if (answer.cancel) out.cancel = true;
  } else if ("confirm" in answer) {
    out.confirm = Boolean(answer.confirm);
  } else if ("serumPowder" in answer) {
    out.serumPowder = Number(answer.serumPowder);
  } else if ("keep" in answer) {
    out.keep = Boolean(answer.keep);
  } else if ("value" in answer) {
    out.value = Number(answer.value);
  } else if ("order" in answer) {
    out.order = answer.order.map((n) => Number(n));
    out.buckets = answer.buckets ?? {};
  } else if ("amounts" in answer) {
    out.amounts = answer.amounts.map((n) => Number(n));
  } else if ("modes" in answer) {
    out.modes = answer.modes.map((n) => Number(n));
  } else if ("text" in answer) {
    out.text = String(answer.text).slice(0, 200);
  } else if ("option" in answer) {
    out.option = answer.option === null ? null : Number(answer.option);
    if (answer.passUntilTurn !== undefined) out.passUntilTurn = Number(answer.passUntilTurn);
    if (answer.concede) out.concede = true;
    if (Array.isArray(answer.paySources) && answer.paySources.length) out.paySources = answer.paySources.map((iid) => Number(iid)).filter((n) => Number.isFinite(n)).slice(0, 40);
  }
  return out;
}

/** Shape check for what a browser may send as an engine answer. */
export function isEngineAnswer(v: unknown): v is EngineAnswer {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (typeof a.promptId !== "number") return false;
  if ("attacks" in a) return Array.isArray(a.attacks);
  if ("blocks" in a) return Array.isArray(a.blocks);
  if ("options" in a) return Array.isArray(a.options) && (a.options as unknown[]).every((n) => typeof n === "number");
  if ("confirm" in a) return typeof a.confirm === "boolean";
  if ("keep" in a) return typeof a.keep === "boolean";
  if ("serumPowder" in a) return typeof a.serumPowder === "string" && /^\d+$/.test(a.serumPowder);
  if ("value" in a) return typeof a.value === "number" && Number.isFinite(a.value);
  if ("order" in a) return Array.isArray(a.order) && (a.order as unknown[]).every((n) => typeof n === "number") && (a.buckets === undefined || (typeof a.buckets === "object" && a.buckets !== null && Object.values(a.buckets as object).every((v) => typeof v === "string")));
  if ("amounts" in a) return Array.isArray(a.amounts) && (a.amounts as unknown[]).every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);
  if ("modes" in a) return Array.isArray(a.modes) && (a.modes as unknown[]).every((n) => typeof n === "number");
  if ("text" in a) return typeof a.text === "string" && a.text.length <= 200;
  if ("option" in a) return (a.option === null || typeof a.option === "number") && (a.paySources === undefined || (Array.isArray(a.paySources) && (a.paySources as unknown[]).every((x) => typeof x === "string")));
  return false;
}
