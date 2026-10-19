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

/**
 * Which library decks bots are dealt from: one bracket, or "near" = the host's deck bracket and one
 * either side (2026-10-19). Without a host deck "near" means Brackets 1-3 around Bracket 2.
 */
export type AgentBracketChoice = Bracket | "near";

export function isAgentBracketChoice(v: unknown): v is AgentBracketChoice {
  return v === "near" || (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5);
}

/** The brackets "near" covers around the host's bracket (null = unknown: assume Bracket 2). */
export function nearBrackets(host: Bracket | null): Bracket[] {
  const b = host ?? 2;
  return ([b - 1, b, b + 1] as number[]).filter((x): x is Bracket => x >= 1 && x <= 5);
}

/** The bot box warns when a pool is smaller than this many decks per bot seat (re-rolls repeat). */
export const AGENT_POOL_PER_SEAT = 5;

/** "B1-B3" for the brackets "near" covers. */
export function nearLabel(host: Bracket | null): string {
  const b = nearBrackets(host);
  return b.length === 1 ? `B${b[0]}` : `B${b[0]}-B${b[b.length - 1]}`;
}

/** Bot-eligible decks a bracket option deals from ("near" = the host's bracket and one either side). */
export function agentPoolSize(pool: Pick<AgentPoolCounts, "eligible" | "hostBracket">, choice: AgentBracketChoice): number {
  const brackets = choice === "near" ? nearBrackets(pool.hostBracket) : [choice];
  return brackets.reduce((n, b) => n + (pool.eligible[b] ?? 0), 0);
}

/** Should the bot box warn that re-rolls will repeat? Fewer than AGENT_POOL_PER_SEAT decks per bot seat. */
export function agentPoolIsSmall(size: number, seats: number): boolean {
  return size < Math.max(1, seats) * AGENT_POOL_PER_SEAT;
}

export interface AddAgentsRequest {
  count: number;
  bracket: AgentBracketChoice;
}

export interface AgentPoolInfo {
  /** Brackets the bots were actually dealt from. */
  brackets: Bracket[];
  /** Eligible decks in those brackets. */
  size: number;
  /** True when the chosen bracket(s) had no eligible deck and every bracket was used instead. */
  fallback: boolean;
  /** One sentence for the lobby, e.g. "No Bracket 1 decks; dealt from all brackets." */
  note: string | null;
}

export interface AddAgentsResponse {
  agents: AgentPick[];
  /** Decks that were eligible for the chosen bracket(s), for the "re-roll" hint. */
  eligible: number;
  pool: AgentPoolInfo;
}

/** GET /api/agents/pool: bot-eligible library decks per bracket (owner; for the lobby's bot box). */
export interface AgentPoolCounts {
  eligible: Record<Bracket, number>;
  /** The host's deck bracket in that room, when asked with ?room=CODE (null = unknown). */
  hostBracket: Bracket | null;
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
  /** API / timeout / refusal detail when the outcome is not ok. */
  error: string | null;
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
