/** AI Coach (owner only): API shapes shared by server and client. */

export interface CoachTurningPoint {
  round: number;
  turn: number;
  title: string;
  had: string;
  chose: string;
  betterLine: string;
  why: string;
  theme: string;
  cards: string[];
}

export interface CoachReportBody {
  summary: string;
  turningPoints: CoachTurningPoint[];
  habits: string[];
  hiddenInfoNote: string;
}

export interface CoachFollowup {
  id: number;
  question: string;
  answer: string | null;
  status: "running" | "done" | "error";
  costUsd: number;
  createdAt: string;
}

export interface CoachReportRow {
  id: string;
  roomCode: string;
  kind: "full" | "light";
  status: "running" | "done" | "error" | "capped";
  model: string;
  report: CoachReportBody | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  calls: number;
  createdAt: string;
  updatedAt: string;
  followups: CoachFollowup[];
}

export interface CoachRoomResponse {
  game: { code: string; won: boolean; place: number | null; playerCount: number; turns: number | null; endReason: string | null; deckName: string; kind: "full" | "light"; test: boolean };
  report: CoachReportRow | null;
}

export interface CoachGameRow {
  code: string;
  endedAt: string | null;
  won: boolean;
  place: number | null;
  playerCount: number;
  deckName: string;
  test: boolean;
  report: { status: string; costUsd: number } | null;
}

export interface CoachAdminResponse {
  enabled: boolean;
  model: string | null;
  spentTodayUsd: number;
  limits: { maxUsdPerReport: number; maxUsdPerDay: number; maxTokensPerReport: number };
  reports: Array<{ code: string; kind: string; status: string; model: string; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number; followups: number; followupUsd: number; createdAt: string }>;
}
