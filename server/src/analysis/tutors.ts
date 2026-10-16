import type { TutorHit, TutorKind } from "@cgwf/shared";
import { expanded, text, type AnalysisCard } from "./cards.js";

/**
 * Tutors: "search your library for a ... card". Land-only searches are ramp,
 * not tutors, and "a card named X" (Squadron Hawk) is too narrow to count.
 * Since October 2025 tutors are NOT a bracket restriction; the count feeds the
 * power signals and the summary only.
 */
const SEARCH = /\bsearch your library (?:and\/or graveyard )?for (?:a|an|up to \w+|any number of|two|three|four|x) ([^.;,]*?)cards?\b( named\b)?/g;

export function classifyTutor(phrase: string): TutorKind | "land" | "named" | null {
  const p = phrase.toLowerCase().trim();
  if (/\bnamed\b/.test(p)) return "named";
  const mentionsLand = /\b(?:land|plains|island|swamp|mountain|forest|gate)\b/.test(p);
  const mentionsOther = /\b(creature|artifact|enchantment|instant|sorcery|planeswalker|equipment|aura|legendary|permanent|spell|nonland)\b/.test(p);
  if (mentionsLand && !mentionsOther) return "land";
  if (/\bcreature\b/.test(p)) return "creature";
  if (/\b(artifact|equipment)\b/.test(p)) return "artifact";
  if (/\b(enchantment|aura)\b/.test(p)) return "enchantment";
  if (/\b(instant|sorcery)\b/.test(p)) return "instant_sorcery";
  if (/\bplaneswalker\b/.test(p)) return "planeswalker";
  if (p === "" || /^(?:nonland |permanent |legendary )?$/.test(p) || /\bmana value\b/.test(p) || /\bwith\b/.test(p)) return "any";
  return "other";
}

export function detectTutors(cards: AnalysisCard[]): { count: number; cards: TutorHit[]; landTutors: string[] } {
  const hits: TutorHit[] = [];
  const landTutors: string[] = [];
  for (const c of expanded(cards)) {
    const t = text(c);
    let best: TutorKind | null = null;
    let land = false;
    for (const m of t.matchAll(SEARCH)) {
      const kind = classifyTutor((m[1] ?? "") + (m[2] ?? ""));
      if (kind === "land") land = true;
      else if (kind === "named" || kind === null) continue;
      else if (best === null || kind === "any") best = kind;
    }
    // Transmute: "search your library for a card with the same mana value".
    if (!best && c.keywords.some((k) => /^transmute$/i.test(k))) best = "any";
    if (best) hits.push({ name: c.name, kind: best });
    else if (land) landTutors.push(c.name);
  }
  return { count: hits.length, cards: hits, landTutors };
}
