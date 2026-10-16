import type { CardPrinting, CardSummary, Color } from "./cards.js";

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

/** One distinct token (name + P/T + colours + text), as the token finder lists it. */
export interface TokenSummary {
  /** Printing id of the best image for this token. */
  id: string;
  name: string;
  typeLine: string;
  power: string | null;
  toughness: string | null;
  colors: Color[];
  oracleText: string;
  faceCount: number;
}

export interface TokenSearchResponse {
  query: string;
  tokens: TokenSummary[];
}
