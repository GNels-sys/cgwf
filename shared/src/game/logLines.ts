import type { LogEntry } from "./types.js";

/**
 * What a log line is about (2026-10-29, owner request: the table's notifications showed every player's untap,
 * upkeep and draw steps; they should only show what happened). Engine tables tag each line by Forge's own log
 * entry type on the server (`LogEntry.kind`); older lines and classic tables fall back to the wording.
 */
export type LogKind = "turn" | "step" | "round" | "event";

/** Forge's `GameLogEntryType` name (TURN, PHASE, LAND, ...) or the relay's own ROUND / FIRST_PLAYER -> kind. */
export function kindFromEngineLogType(logType: string): LogKind {
  switch (logType) {
    case "TURN":
      return "turn";
    case "PHASE":
      return "step";
    case "ROUND":
      return "round";
    default:
      return "event";
  }
}

/**
 * Fallback by wording: "Turn 3 (Blair)", "Round 2 begins", "Blair's Upkeep step", "Chris' Draw step" (Forge
 * writes a bare apostrophe after a name ending in s), "Alex's Main phase, precombat". Anything else happened.
 * Word boundaries keep "Blair's Sol Ring phased out" an event.
 */
export function classifyLogLine(text: string): LogKind {
  if (/^Turn \d+/.test(text)) return "turn";
  if (/^Round \d+ begins$/.test(text)) return "round";
  if (/^.+(?:'s|') .*\b(?:step|phase)\b/i.test(text)) return "step";
  return "event";
}

export function logKind(entry: Pick<LogEntry, "text" | "kind">): LogKind {
  return entry.kind ?? classifyLogLine(entry.text);
}

/** Something happened (a play, a spell, damage, a result): what notifications and "Latest:" show. */
export function isEventEntry(entry: Pick<LogEntry, "text" | "kind">): boolean {
  return logKind(entry) === "event";
}

/** A line that only announces a step or a turn, by wording (kept for callers that have text alone). */
export function isStepLine(text: string): boolean {
  const k = classifyLogLine(text);
  return k === "step" || k === "turn";
}
