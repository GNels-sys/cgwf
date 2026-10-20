import type { Bracket } from "./analysis.js";

/**
 * Deck Doctor (2026-10-19): suggested swaps ("Add X / Cut Y") for a deck, from EDHREC's synergy data for
 * its commander, Commander Spellbook's one-card-away combos and the deck's role gaps. No model spend.
 * Scoring lives in server/src/analysis/doctor; GET /api/decks/:id/doctor and /api/library-decks/:id/doctor.
 */

export type DoctorRole = "ramp" | "draw" | "removal" | "wipe" | "protection" | "land";

export const DOCTOR_ROLES: readonly DoctorRole[] = ["ramp", "draw", "removal", "wipe", "protection", "land"];

export const DOCTOR_ROLE_LABELS: Record<DoctorRole, string> = {
  ramp: "Ramp",
  draw: "Card draw",
  removal: "Removal",
  wipe: "Board wipes",
  protection: "Protection",
  land: "Lands",
};

/** Rules of thumb for a 100-card Commander deck (community baselines, not rules). */
export const DOCTOR_ROLE_TARGETS: Record<DoctorRole, number> = {
  ramp: 10,
  draw: 10,
  removal: 8,
  wipe: 2,
  protection: 3,
  land: 35,
};

export interface DoctorRoleCount {
  role: DoctorRole;
  have: number;
  want: number;
}

export interface DoctorCardRef {
  /** Printing id (for an add: the default printing of the card). */
  cardId: string;
  oracleId: string | null;
  name: string;
  typeLine: string;
  manaCost: string;
  faceCount: number;
  roles: DoctorRole[];
  /** EDHREC synergy for this commander (-1..1), null when the card is not on EDHREC's list. */
  synergy: number | null;
  /** Share of this commander's decks that play it (0..1), null when not on the list. */
  inclusion: number | null;
}

export interface DoctorSwap {
  add: DoctorCardRef & {
    /** Where the suggestion came from. */
    sources: Array<"edhrec" | "combo" | "role">;
    /** In stock at local stores (Singles bridge), when known. */
    localStores: number | null;
    cheapestLocal: number | null;
  };
  cut: DoctorCardRef & { entryId: number | null; quantity: number };
  /** The role this swap is about (shared by add and cut when possible). */
  role: DoctorRole | null;
  /** One or two plain sentences built from the data. */
  reason: string;
  /** Combos the add completes (Spellbook), as "A + B: infinite mana". */
  combos: string[];
  bracket: { floorBefore: number; floorAfter: number; raises: boolean; note: string | null };
  score: number;
}

export interface DoctorResponse {
  deckRef: string;
  commanders: string[];
  /** The bracket swaps must stay inside (deck's suggested bracket unless the user picked one). */
  targetBracket: Bracket;
  suggestedBracket: Bracket;
  allowHigher: boolean;
  roles: DoctorRoleCount[];
  swaps: DoctorSwap[];
  edhrec: { status: "ok" | "missing" | "unavailable"; slug: string | null; url: string | null; page: string | null; message: string | null };
  combosStatus: "ok" | "unavailable" | "skipped";
  keep: Array<{ oracleId: string; name: string }>;
  dismissed: Array<{ oracleId: string; name: string }>;
  /** Only the deck's owner may apply swaps (own decks); library decks are read-only. */
  canApply: boolean;
}

export interface DoctorPrefRequest {
  deckRef: string;
  oracleId: string;
  name: string;
  kind: "keep" | "dismiss";
}

export interface DoctorApplyRequest {
  /** deck_cards.id of the line to cut. */
  cutEntryId: number;
  /** Oracle id of the card to add (its default printing goes in). */
  addOracleId: string;
}
