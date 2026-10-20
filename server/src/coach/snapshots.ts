import { gunzipSync, gzip } from "node:zlib";
import { and, asc, eq, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { DbHandle } from "../db/index.js";
import { decisionSnapshots } from "../db/schema.js";
import type { EngineCardJson, EnginePlayerJson, EngineStateJson } from "../engine/view.js";

/**
 * AI Coach M1: a compact record of one decision a human seat made, built ONLY from the view that seat was
 * sent with the prompt (already audited for hidden information by the engine) and then trimmed again here:
 * the seat's own hand is the only hand with names; libraries are counts; another player's face-down
 * cards stay unnamed. Size budget: ~1-3 KB of JSON per decision before gzip (~0.5-1 KB stored); a
 * four-player game of a few hundred decisions stays well under 1 MB; at most MAX_PER_SEAT per seat.
 */
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_RETENTION_DAYS = 90;
export const MAX_PER_SEAT = 2000;

export interface SnapshotCard {
  n: string;
  /** tapped */
  t?: 1;
  /** summoning sick */
  s?: 1;
  pt?: string;
  c?: Record<string, number>;
  d?: number;
  /** a commander */
  cmd?: 1;
  token?: 1;
  /** attached to (card name or player name) */
  on?: string;
}

export interface SnapshotPlayer {
  seat: number;
  name: string;
  you: boolean;
  life: number;
  poison: number;
  lost: boolean;
  handCount: number;
  libraryCount: number;
  commanderDamage: Record<string, number>;
  battlefield: SnapshotCard[];
  graveyard: string[];
  exile: string[];
  command: string[];
}

export interface DecisionSnapshot {
  v: number;
  round: number | null;
  turn: number | null;
  phase: string | null;
  activeSeat: number | null;
  /** The decision: prompt kind, title, the options offered (labels), what was chosen. */
  prompt: { kind: string; title: string; options: string[]; min?: number; max?: number };
  answer: { raw: unknown; chosen: string[] };
  /** The seat's own private information: hand, mana pool, lands played this turn. */
  me: { seat: number; hand: string[]; manaPool: Record<string, number>; landsPlayedThisTurn: number };
  players: SnapshotPlayer[];
  stack: Array<{ text: string; by: number | null }>;
  combat: unknown;
}

function cardName(c: EngineCardJson): string {
  return c.name ?? (c.faceDown ? "face-down card" : "a card");
}

function compactCard(c: EngineCardJson, nameOf: (kind: "player" | "card", id: number) => string | null): SnapshotCard {
  const out: SnapshotCard = { n: cardName(c) };
  if (c.tapped) out.t = 1;
  if (c.sick) out.s = 1;
  if (typeof c.power === "number" && typeof c.toughness === "number") out.pt = `${c.power}/${c.toughness}`;
  if (c.counters && Object.keys(c.counters).length) out.c = c.counters;
  if (c.damage) out.d = c.damage;
  if (c.commander) out.cmd = 1;
  if (c.token) out.token = 1;
  const on = c.attachedTo ? nameOf(c.attachedTo.kind, c.attachedTo.id) : null;
  if (on) out.on = on;
  return out;
}

/** A readable label for one prompt option, whatever the prompt kind. */
function optionLabel(o: Record<string, unknown>): string {
  const pick = (k: string) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : null);
  return pick("description") ?? pick("label") ?? pick("text") ?? pick("cardName") ?? pick("name") ?? (typeof o.index === "number" ? `option ${o.index}` : JSON.stringify(o).slice(0, 80));
}

/**
 * Build the snapshot from the prompt frame the engine sent THIS seat (`raw`, with its `view`) and the
 * answer as sent to the engine (`out`, Forge ids/indices). Pure; no I/O.
 */
export function buildSnapshot(raw: Record<string, unknown>, out: Record<string, unknown>): DecisionSnapshot | null {
  const view = raw.view as EngineStateJson | undefined;
  if (!view || !Array.isArray(view.players)) return null;
  const meP = view.players.find((p) => p.isYou);
  if (!meP) return null;
  const seatOfPlayer = new Map(view.players.map((p) => [p.id, p.seat]));
  const cardById = new Map<number, EngineCardJson>();
  for (const p of view.players) for (const z of [p.battlefield, p.graveyard, p.exile, p.command, p.isYou ? (p.hand ?? []) : []]) for (const c of z ?? []) cardById.set(c.id, c);
  const nameOf = (kind: "player" | "card", id: number): string | null =>
    kind === "player" ? (view.players.find((p) => p.id === id)?.name ?? null) : cardById.has(id) ? cardName(cardById.get(id)!) : null;

  const rawOptions = Array.isArray(raw.options) ? (raw.options as Array<Record<string, unknown>>) : Array.isArray(raw.items) ? (raw.items as Array<Record<string, unknown>>) : Array.isArray(raw.modes) ? (raw.modes as Array<Record<string, unknown>>) : Array.isArray(raw.targets) ? (raw.targets as Array<Record<string, unknown>>) : [];
  const options = rawOptions.slice(0, 60).map(optionLabel);
  const chosen: string[] = [];
  const at = (i: unknown) => (typeof i === "number" && rawOptions[i] ? optionLabel(rawOptions[i]!) : null);
  if ("option" in out) chosen.push(out.option === null ? "pass" : (at(out.option) ?? `option ${String(out.option)}`));
  if (Array.isArray(out.options)) for (const i of out.options) chosen.push(at(i) ?? `option ${String(i)}`);
  if (Array.isArray(out.modes)) for (const i of out.modes) chosen.push(at(i) ?? `mode ${String(i)}`);
  if (Array.isArray(out.order)) for (const i of out.order) chosen.push(at(i) ?? `item ${String(i)}`);
  if (typeof out.confirm === "boolean") chosen.push(Array.isArray(raw.options) && typeof raw.options[out.confirm ? 0 : 1] === "string" ? String(raw.options[out.confirm ? 0 : 1]) : out.confirm ? "yes" : "no");
  if (typeof out.keep === "boolean") chosen.push(out.keep ? "keep" : "mulligan");
  if (typeof out.value === "number") chosen.push(String(out.value));
  if (typeof out.text === "string") chosen.push(out.text);
  if (Array.isArray(out.amounts)) chosen.push(`amounts ${(out.amounts as number[]).join("/")}`);
  if (Array.isArray(out.attacks)) {
    for (const a of out.attacks as Array<{ cardId?: number; defender?: { kind: "player" | "card"; id: number } }>) {
      chosen.push(`${a.cardId !== undefined ? (nameOf("card", a.cardId) ?? "a creature") : "a creature"} attacks ${a.defender ? (nameOf(a.defender.kind, a.defender.id) ?? "?") : "?"}`);
    }
    if (!(out.attacks as unknown[]).length) chosen.push("no attack");
  }
  if (Array.isArray(out.blocks)) {
    for (const b of out.blocks as Array<{ blockerId?: number; attackerId?: number }>) chosen.push(`${nameOf("card", b.blockerId ?? -1) ?? "a creature"} blocks ${nameOf("card", b.attackerId ?? -1) ?? "?"}`);
    if (!(out.blocks as unknown[]).length) chosen.push("no blocks");
  }

  const players: SnapshotPlayer[] = view.players.map((p: EnginePlayerJson) => ({
    seat: p.seat,
    name: p.name,
    you: Boolean(p.isYou),
    life: p.life,
    poison: p.poison,
    lost: p.lost,
    handCount: p.handCount,
    libraryCount: p.libraryCount,
    commanderDamage: p.commanderDamage ?? {},
    battlefield: (p.battlefield ?? []).map((c) => compactCard(c, nameOf)),
    graveyard: (p.graveyard ?? []).map(cardName),
    // another player's face-down exile stays unnamed even if a name slipped through
    exile: (p.exile ?? []).map((c) => (!p.isYou && c.faceDown ? "face-down card" : cardName(c))),
    command: (p.command ?? []).map(cardName),
  }));
  return {
    v: SNAPSHOT_VERSION,
    round: typeof view.round === "number" ? view.round : null,
    turn: typeof view.turn === "number" ? view.turn : null,
    phase: view.phase ?? null,
    activeSeat: view.activePlayer !== null ? (seatOfPlayer.get(view.activePlayer) ?? null) : null,
    prompt: {
      kind: String(raw.prompt ?? "?"),
      title: String(raw.title ?? ""),
      options,
      ...(typeof raw.min === "number" ? { min: raw.min } : {}),
      ...(typeof raw.max === "number" ? { max: raw.max } : {}),
    },
    answer: { raw: out, chosen },
    me: { seat: meP.seat, hand: (meP.hand ?? []).map(cardName), manaPool: meP.manaPool ?? {}, landsPlayedThisTurn: meP.landsPlayedThisTurn },
    players,
    stack: (view.stack ?? []).map((s) => ({ text: s.description, by: s.activatingPlayer !== null ? (seatOfPlayer.get(s.activatingPlayer) ?? null) : null })),
    combat: view.combat ?? null,
  };
}

/** A pass at a priority stop is worth keeping once; the same pass again (same turn, step, options, stack) is noise. */
function passKey(s: DecisionSnapshot): string | null {
  if (s.prompt.kind !== "priority" || s.answer.chosen[0] !== "pass") return null;
  return JSON.stringify([s.turn, s.phase, s.prompt.options, s.stack.length]);
}

/**
 * Records snapshots asynchronously (gzip off the event loop, one insert per decision); never throws into
 * the game. Reading is limited to the seat's own user by the caller.
 */
export class DecisionRecorder {
  private lastPass = new Map<string, string>();
  private counts = new Map<string, number>();
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
  ) {}

  record(ctx: { roomId: string; seat: number; userId: string; seq: number }, raw: Record<string, unknown>, out: Record<string, unknown>): void {
    let snap: DecisionSnapshot | null;
    try {
      snap = buildSnapshot(raw, out);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "decision snapshot failed");
      return;
    }
    if (!snap) return;
    // trivial: a pass when nothing at all was offered
    if (snap.prompt.kind === "priority" && snap.prompt.options.length === 0 && snap.answer.chosen[0] === "pass") return;
    const key = `${ctx.roomId}:${ctx.seat}`;
    const pk = passKey(snap);
    if (pk !== null && this.lastPass.get(key) === pk) return;
    if (pk !== null) this.lastPass.set(key, pk);
    else this.lastPass.delete(key);
    const n = (this.counts.get(key) ?? 0) + 1;
    if (n > MAX_PER_SEAT) return;
    this.counts.set(key, n);
    const json = JSON.stringify(snap);
    const job = new Promise<void>((resolve) => {
      gzip(json, (err, buf) => {
        try {
          if (err) throw err;
          this.handle.db
            .insert(decisionSnapshots)
            .values({ roomId: ctx.roomId, seat: ctx.seat, userId: ctx.userId, seq: ctx.seq, turn: snap!.turn, promptKind: snap!.prompt.kind, createdAt: new Date().toISOString(), data: buf })
            .run();
        } catch (e) {
          this.log.warn({ err: (e as Error).message }, "storing a decision snapshot failed");
        }
        resolve();
      });
    });
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  /** For tests and shutdown: wait for queued writes. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** One user's snapshots for one game, oldest first. Never another user's. */
  forUser(roomId: string, userId: string): Array<{ seq: number; seat: number; snapshot: DecisionSnapshot }> {
    return this.handle.db
      .select()
      .from(decisionSnapshots)
      .where(and(eq(decisionSnapshots.roomId, roomId), eq(decisionSnapshots.userId, userId)))
      .orderBy(asc(decisionSnapshots.seq), asc(decisionSnapshots.id))
      .all()
      .map((r) => ({ seq: r.seq, seat: r.seat, snapshot: JSON.parse(gunzipSync(r.data).toString("utf8")) as DecisionSnapshot }));
  }

  /** Retention: delete snapshots older than SNAPSHOT_RETENTION_DAYS. Returns how many were removed. */
  cleanup(now = Date.now(), days = SNAPSHOT_RETENTION_DAYS): number {
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    return this.handle.db.delete(decisionSnapshots).where(lt(decisionSnapshots.createdAt, cutoff)).run().changes;
  }
}
