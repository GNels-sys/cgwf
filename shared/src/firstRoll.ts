/**
 * "Roll to see who goes first" on rules-engine tables (2026-10-19). After the host starts and before
 * mulligans, every seated player rolls a D20 (the server rolls, never the client); the highest roll
 * goes first; a tie re-rolls among the tied players only. The winner is handed to Forge as the
 * starting player. Lobby setting: "Roll a D20" (default) or "Random" (the server picks, no ceremony).
 */

export type FirstPlayerMethod = "roll" | "random";
export const FIRST_PLAYER_METHODS: readonly FirstPlayerMethod[] = [
  "roll",
  "random",
];
export const DEFAULT_FIRST_PLAYER: FirstPlayerMethod = "roll";
export const D20_SIDES = 20;

export function isFirstPlayerMethod(v: unknown): v is FirstPlayerMethod {
  return v === "roll" || v === "random";
}

export interface FirstRollSeat {
  seat: number;
  userId: string;
  name: string;
  /** This round's roll, or null while the seat has not rolled (or sits this round out). */
  value: number | null;
  /** Still in the running this round (everyone in round 1; only the tied players after a tie). */
  contending: boolean;
  /** Every roll this seat made, round by round. */
  history: number[];
  /** A bot seat or a player with no connection: the server rolls for them after a short delay. */
  auto: boolean;
}

/** RoomInfo.firstRoll: what every member of the table sees (rolls are public). */
export interface FirstRollInfo {
  method: FirstPlayerMethod;
  status: "rolling" | "done";
  round: number;
  seats: FirstRollSeat[];
  winnerSeat: number | null;
  /** When the roll finished (ms since epoch), so a reload right after still shows the result briefly. */
  doneAt: number | null;
}

/** One finished round: the single highest roll wins, else the seats tied at the top roll again. */
export function resolveRound(
  rolls: ReadonlyArray<{ seat: number; value: number }>,
): { winner: number } | { tied: number[]; value: number } {
  if (rolls.length === 0) throw new Error("no rolls");
  const top = Math.max(...rolls.map((r) => r.value));
  const best = rolls.filter((r) => r.value === top).map((r) => r.seat);
  return best.length === 1
    ? { winner: best[0] as number }
    : { tied: best.sort((a, b) => a - b), value: top };
}

/** "Alex and Blair", "Alex, Blair and Casey". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Log lines, shared so the relay, its tests and the client agree on the wording. */
export const firstRollText = {
  rolled: (name: string, value: number) => `${name} rolled ${value}`,
  tied: (names: readonly string[], value: number) =>
    `${joinNames(names)} tied with ${value}: they roll again`,
  goesFirst: (name: string) => `${name} goes first`,
  randomPick: (name: string) => `Random pick: ${name} goes first`,
};
