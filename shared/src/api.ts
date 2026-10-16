import type { CardPrinting, CardSummary } from "./cards.js";

/** Shapes returned by the REST API, shared so the client never guesses. */
export interface SearchResponse {
  query: string;
  results: CardSummary[];
}

export interface CardResponse {
  card: CardPrinting;
}

export interface StatusResponse {
  ok: boolean;
  cardCount: number;
  lastIngestAt: string | null;
  bulkUpdatedAt: string | null;
  ingestRunning: boolean;
  ingestProgress: number;
  ingestError: string | null;
  version: string;
}
