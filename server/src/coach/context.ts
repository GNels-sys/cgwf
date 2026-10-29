import { classifyLogLine, kindFromEngineLogType } from "@cgwf/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbHandle } from "../db/index.js";
import { gameResultSeats, gameResults, libraryDecks, roomEvents, rooms, users } from "../db/schema.js";
import { libraryDeckIdOf, seatDeckRows } from "../rooms/deck.js";
import type { DecisionRecorder, DecisionSnapshot, SnapshotPlayer } from "./snapshots.js";

/** Caps that keep one report's prompt bounded (characters; ~4 characters per token). */
export const LOG_CHAR_CAP = 60_000;
export const DECISIONS_CHAR_CAP = 160_000;

export interface CoachGame {
  roomId: string;
  code: string;
  userId: string;
  playerName: string;
  seat: number;
  won: boolean;
  place: number | null;
  endReason: string | null;
  tableBracket: number | null;
  playerCount: number;
  turns: number | null;
  /** "full" = decision snapshots exist; "light" = only the public log and recorded answers. */
  kind: "full" | "light";
  /** The prompt's big, cacheable context block. */
  text: string;
}

/** Step and turn announcements add nothing to the review; the shared classifier knows Forge's wording. */
const isStepLine = (t: string, logType?: string) => {
  const k = logType ? kindFromEngineLogType(logType) : classifyLogLine(t);
  return k === "step" || k === "turn";
};

function cardLine(c: { n: string; t?: 1; s?: 1; pt?: string; c?: Record<string, number>; d?: number; cmd?: 1; token?: 1; on?: string }): string {
  const bits: string[] = [];
  if (c.pt) bits.push(c.pt);
  if (c.t) bits.push("tapped");
  if (c.s) bits.push("summoning sick");
  if (c.d) bits.push(`${c.d} damage`);
  if (c.c) for (const [k, v] of Object.entries(c.c)) bits.push(`${v} ${k}`);
  if (c.cmd) bits.push("commander");
  if (c.token) bits.push("token");
  if (c.on) bits.push(`on ${c.on}`);
  return bits.length ? `${c.n} (${bits.join(", ")})` : c.n;
}

function boardOf(p: SnapshotPlayer): string {
  const lines = [`  ${p.name}${p.you ? " (you)" : ""}: life ${p.life}${p.poison ? `, poison ${p.poison}` : ""}, hand ${p.handCount}, library ${p.libraryCount}${p.lost ? ", OUT" : ""}`];
  const cmdDmg = Object.entries(p.commanderDamage ?? {}).filter(([, v]) => v > 0);
  if (cmdDmg.length) lines.push(`    commander damage taken: ${cmdDmg.map(([k, v]) => `${v} from ${k}`).join(", ")}`);
  lines.push(`    battlefield: ${p.battlefield.length ? p.battlefield.map(cardLine).join("; ") : "(empty)"}`);
  if (p.command.length) lines.push(`    command zone: ${p.command.join(", ")}`);
  if (p.graveyard.length) lines.push(`    graveyard (${p.graveyard.length}): ${p.graveyard.slice(-12).join(", ")}`);
  if (p.exile.length) lines.push(`    exile (${p.exile.length}): ${p.exile.slice(-8).join(", ")}`);
  return lines.join("\n");
}

/** The player's decisions as compact text: full boards once per turn, hand and choice every time. */
export function renderDecisions(snaps: DecisionSnapshot[], nameOfSeat: (seat: number | null) => string): string {
  const out: string[] = [];
  let lastTurn: number | null = -1;
  snaps.forEach((s, i) => {
    const head = `#${i + 1} Round ${s.round ?? "?"} · Turn ${s.turn ?? "?"} · ${s.phase ?? "?"} · ${nameOfSeat(s.activeSeat)}'s turn`;
    const lines = [head];
    if (s.turn !== lastTurn) {
      lastTurn = s.turn;
      lines.push(" Board:");
      for (const p of s.players) lines.push(boardOf(p));
    }
    if (s.stack.length) lines.push(` Stack (top first): ${s.stack.map((x) => `${x.text}${x.by !== null ? ` [${nameOfSeat(x.by)}]` : ""}`).join(" | ")}`);
    lines.push(` Your hand: ${s.me.hand.length ? s.me.hand.join(", ") : "(empty)"}`);
    const pool = Object.entries(s.me.manaPool ?? {}).filter(([, v]) => v > 0);
    if (pool.length) lines.push(` Floating mana: ${pool.map(([k, v]) => `${v}${k}`).join(" ")}`);
    const lives = s.players.map((p) => `${p.name} ${p.life}`).join(", ");
    lines.push(` Life: ${lives}`);
    lines.push(` Decision (${s.prompt.kind}): ${s.prompt.title}`);
    if (s.prompt.options.length) lines.push(`  Offered: ${s.prompt.options.slice(0, 15).join(" | ")}${s.prompt.options.length > 15 ? ` | ... (${s.prompt.options.length} options)` : ""}`);
    lines.push(`  Chose: ${s.answer.chosen.join("; ") || JSON.stringify(s.answer.raw)}`);
    out.push(lines.join("\n"));
  });
  let text = out.join("\n\n");
  if (text.length > DECISIONS_CHAR_CAP) {
    // keep the end of the game (where it was decided) and the start
    text = `${text.slice(0, DECISIONS_CHAR_CAP * 0.3)}\n\n[... middle of the game trimmed to fit ...]\n\n${text.slice(-DECISIONS_CHAR_CAP * 0.7)}`;
  }
  return text;
}

/** Oracle text of the player's deck, one line per distinct card. */
function decklist(handle: DbHandle, userId: string, deckRef: string | null): { text: string; primer: string } {
  if (!deckRef) return { text: "(deck unknown)", primer: "" };
  const src = seatDeckRows(handle, userId, deckRef);
  let primer = "";
  const lib = libraryDeckIdOf(deckRef);
  if (lib) primer = handle.db.select({ p: libraryDecks.primer }).from(libraryDecks).where(eq(libraryDecks.id, lib)).get()?.p ?? "";
  else primer = handle.db.select({ p: libraryDecks.primer }).from(libraryDecks).where(eq(libraryDecks.sourceKey, `deck:${deckRef}`)).get()?.p ?? "";
  if (!src) return { text: "(the deck was deleted after the game; only the cards seen in the record are known)", primer };
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const board of ["commander", "main", "companion"]) {
    for (const r of src.rows.filter((x) => x.board === board)) {
      if (seen.has(r.card.name)) continue;
      seen.add(r.card.name);
      const qty = src.rows.filter((x) => x.card.name === r.card.name && x.board === board).reduce((n, x) => n + x.quantity, 0);
      lines.push(`${board === "commander" ? "[Commander] " : board === "companion" ? "[Companion] " : ""}${qty}x ${r.card.name} ${r.card.manaCost} — ${r.card.typeLine} — ${r.card.oracleText.replace(/\n/g, " / ")}`);
    }
  }
  return { text: lines.join("\n"), primer };
}

/** Everything the coach may know about one finished game, from the player's side. Null when not coachable. */
export function buildCoachGame(handle: DbHandle, decisions: DecisionRecorder | null, roomId: string, userId: string): CoachGame | null {
  const room = handle.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
  const result = handle.db.select().from(gameResults).where(eq(gameResults.id, roomId)).get();
  if (!room || !result) return null;
  const seats = handle.db.select().from(gameResultSeats).where(eq(gameResultSeats.gameId, roomId)).all().sort((a, b) => a.seat - b.seat);
  const mine = seats.find((s) => s.userId === userId && !s.isBot);
  if (!mine) return null;
  const names = new Map(
    handle.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, seats.map((s) => s.userId).filter((x): x is string => Boolean(x))))
      .all()
      .map((u) => [u.id, u.name]),
  );
  const nameOfSeat = (seat: number | null) => {
    const s = seats.find((x) => x.seat === seat);
    return s ? (names.get(s.userId ?? "") ?? `Seat ${seat}`) : "?";
  };
  const snaps = decisions ? decisions.forUser(roomId, userId).map((d) => d.snapshot) : [];
  const kind: "full" | "light" = snaps.length ? "full" : "light";

  // the public game log (step lines dropped: they carry no information here)
  const logRows = handle.db
    .select({ type: roomEvents.type, payload: roomEvents.payload, seq: roomEvents.seq })
    .from(roomEvents)
    .where(and(eq(roomEvents.roomId, roomId), inArray(roomEvents.type, ["EngineLog", "EngineAnswer"])))
    .orderBy(asc(roomEvents.seq))
    .all();
  const log: string[] = [];
  const answers: string[] = [];
  for (const r of logRows) {
    const p = JSON.parse(r.payload) as { text?: string; logType?: string; seat?: number; prompt?: string; answer?: unknown };
    if (r.type === "EngineLog" && p.text && !isStepLine(p.text, p.logType)) log.push(p.text);
    if (r.type === "EngineAnswer" && p.seat === mine.seat) answers.push(`${p.prompt}: ${JSON.stringify(p.answer)}`);
  }
  let logText = log.join("\n");
  if (logText.length > LOG_CHAR_CAP) logText = `${logText.slice(0, LOG_CHAR_CAP * 0.3)}\n[... trimmed ...]\n${logText.slice(-LOG_CHAR_CAP * 0.7)}`;

  // opponents' cards as they became public (snapshots only see public zones of others)
  const publicCards = new Map<number, Set<string>>();
  for (const s of snaps) {
    for (const p of s.players) {
      if (p.you) continue;
      const set = publicCards.get(p.seat) ?? new Set<string>();
      for (const c of p.battlefield) if (c.n !== "face-down card" && c.n !== "a card") set.add(c.n);
      for (const n of [...p.graveyard, ...p.exile, ...p.command]) if (n !== "face-down card" && n !== "a card") set.add(n);
      publicCards.set(p.seat, set);
    }
  }

  const deck = decklist(handle, userId, mine.deckRef);
  const winner = seats.find((s) => s.won);
  const parts: string[] = [];
  parts.push(`GAME ${room.code} · ${result.playerCount} players · table bracket ${result.tableBracket ?? "?"} · ${result.turns ?? "?"} turns · ended: ${result.endReason ?? "?"}${result.detail ? ` (${result.detail})` : ""}`);
  parts.push(`Winner: ${winner ? `${nameOfSeat(winner.seat)} (${winner.deckName})` : result.endReason === "draw" ? "draw" : "none recorded"}`);
  parts.push("Seats:");
  for (const s of seats) {
    parts.push(`  Seat ${s.seat}: ${nameOfSeat(s.seat)}${s.userId === userId && !s.isBot ? " (THE PLAYER YOU COACH)" : ""}${s.isBot ? " (Forge AI bot)" : ""} — deck "${s.deckName}" (bracket ${s.deckBracket ?? "?"}), commander ${s.commanders.join(" / ") || "?"} — place ${s.place ?? "?"}${s.won ? ", won" : ""}${s.conceded ? ", conceded" : ""}`);
  }
  parts.push(`\nTHE PLAYER'S DECKLIST (name, mana cost, type, rules text):\n${deck.text}`);
  if (deck.primer.trim()) parts.push(`\nTHE DECK'S PRIMER (the deck's game plan as written by its owner):\n${deck.primer.trim()}`);
  parts.push("\nOPPONENTS' CARDS SEEN IN PUBLIC ZONES DURING THE GAME (everything else about their decks is unknown):");
  for (const s of seats.filter((x) => x.seat !== mine.seat)) parts.push(`  ${nameOfSeat(s.seat)}: ${[...(publicCards.get(s.seat) ?? [])].join(", ") || "(see the log)"}`);
  parts.push(`\nPUBLIC GAME LOG (what every player saw):\n${logText || "(empty)"}`);
  if (kind === "full") {
    parts.push(`\nTHE PLAYER'S DECISIONS (each one with what they could see at that moment: their own hand, all public zones, the options offered and what they chose):\n${renderDecisions(snaps, nameOfSeat)}`);
  } else {
    parts.push(`\nNO DECISION RECORD for this game (it was played before decisions were recorded). Only the player's raw answers to the engine are known, without their hand or the options offered:\n${answers.slice(0, 600).join("\n") || "(none)"}`);
  }
  return {
    roomId,
    code: room.code,
    userId,
    playerName: names.get(userId) ?? "the player",
    seat: mine.seat,
    won: mine.won,
    place: mine.place,
    endReason: result.endReason,
    tableBracket: result.tableBracket,
    playerCount: result.playerCount,
    turns: result.turns,
    kind,
    text: parts.join("\n"),
  };
}
