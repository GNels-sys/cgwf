/**
 * The lobby's deck picker: a player sits down with one of their own decks OR a deck from the shared
 * deck library (the precons plus decks the owner approved). Both lists are filtered by one bracket
 * filter and sorted alphabetically by deck name.
 */

/** Seat deck ids for library decks: `library:<library_decks.id>` (own decks use their plain id). */
export const LIBRARY_DECK_PREFIX = "library:";

export interface DeckOption {
  /** What goes into the seat message: the own deck id, or `library:<id>`. */
  id: string;
  name: string;
  commanders: string[];
  /** Library: the stored bracket. Own decks: the analysis engine's suggestion; null = not known. */
  bracket: number | null;
  /** Archetype tags (library decks; empty for own decks). */
  tags: string[];
}

export interface DeckOptionsResponse {
  mine: DeckOption[];
  library: DeckOption[];
}

/** "Any bracket" (null) keeps everything, decks of unknown bracket included; a bracket keeps only its decks. */
export function filterDeckOptions(list: DeckOption[], bracket: number | null): DeckOption[] {
  const kept = bracket === null ? list : list.filter((d) => d.bracket === bracket);
  return [...kept].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** One option's label: name, bracket, commander(s). */
export function deckOptionLabel(d: DeckOption): string {
  const b = d.bracket === null ? "bracket unknown" : `B${d.bracket}`;
  return `${d.name} · ${b}${d.commanders.length ? ` · ${d.commanders.join(" / ")}` : ""}`;
}
