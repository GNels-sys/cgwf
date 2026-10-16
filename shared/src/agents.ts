import type { ArchetypeTag, Bracket } from "./analysis.js";

/**
 * Phase 7: computer opponents ("agents"). Owner-only everywhere. Shapes the
 * client renders; the runtime lives in server/src/agents.
 */

export interface AgentsStatus {
  /** AGENTS_ENABLED=1 on the server. */
  enabled: boolean;
  /** No API key: agents play a scripted dry run (no model, no cost). */
  dryRun: boolean;
  model: string;
  maxUsdPerGame: number;
  maxUsdPerDay: number;
  /** Spend so far today (UTC), all games. */
  todayUsd: number;
}

export interface AgentPick {
  userId: string;
  seat: number;
  name: string;
  libraryDeckId: string;
  deckName: string;
  commanders: string[];
  bracket: Bracket;
  tags: ArchetypeTag[];
}

export interface AddAgentsRequest {
  count: number;
  bracket: Bracket;
}

export interface AddAgentsResponse {
  agents: AgentPick[];
  /** Decks that were eligible for the bracket, for the "re-roll" hint. */
  eligible: number;
}

export interface AgentDecisionInfo {
  id: number;
  userId: string;
  name: string;
  turn: number;
  step: string;
  kind: string;
  outcome: string;
  rationale: string;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; error?: string }>;
  costUsd: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface AgentRunInfo {
  id: string;
  userId: string;
  name: string;
  seat: number;
  deckName: string;
  model: string;
  mode: "live" | "dry_run";
  status: string;
  decisions: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  stoppedReason: string | null;
  thinking: boolean;
}

/** GET /api/rooms/:code/agents */
export interface RoomAgentsResponse {
  runs: AgentRunInfo[];
  decisions: AgentDecisionInfo[];
  totalUsd: number;
  maxUsdPerGame: number;
}

export interface AgentGameSummary {
  roomId: string;
  code: string;
  status: string;
  startedAt: string;
  agents: number;
  decisions: number;
  costUsd: number;
  deckNames: string[];
}

export interface AgentGamesResponse {
  games: AgentGameSummary[];
  status: AgentsStatus;
}

export interface DraftPrimerResponse {
  primer: string;
  model: string;
  costUsd: number;
  cached: boolean;
}
