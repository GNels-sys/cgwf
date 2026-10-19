import type { ArchetypeTag, DeckAnalysis } from "@cgwf/shared";
import type { AnalysisCard } from "../../analysis/index.js";

/**
 * One win-condition class per deck, so a bracket's selection can mix them. Derived from the
 * analysis engine's output and the cards' rules text; a heuristic, labelled as such in the report.
 * Priority when several apply: combo > alternate win > drain/burn > control/value > combat.
 */
export type WinCondition = "combo" | "alternate" | "drain" | "control" | "combat";

export const WIN_CONDITIONS: readonly WinCondition[] = ["combat", "combo", "drain", "alternate", "control"];

export const WIN_CONDITION_LABELS: Record<WinCondition, string> = {
  combat: "combat",
  combo: "combo",
  drain: "drain/burn",
  alternate: "alternate win",
  control: "control/value",
};

const CONTROL_TAGS: ReadonlySet<ArchetypeTag> = new Set<ArchetypeTag>(["control", "stax", "group_hug", "theft", "big_mana", "blink", "politics"]);
const DRAIN_TAGS: ReadonlySet<ArchetypeTag> = new Set<ArchetypeTag>(["aristocrats", "lifegain", "wheels", "storm"]);

const ALT_WIN = /\byou win the game\b|\b(?:each opponent|target player|that player|all opponents) loses? the game\b/i;
const DRAIN = /\beach opponent loses (?:\d+|x|that much) life\b|\bdeals? (?:\d+|x|that much) damage to each opponent\b|\btarget (?:player|opponent) loses (?:\d+|x|that much) life\b/i;

export function primaryArchetype(a: DeckAnalysis): ArchetypeTag | null {
  return a.archetypes[0]?.tag ?? null;
}

export function classifyWinCondition(a: DeckAnalysis, cards: AnalysisCard[]): WinCondition {
  const primary = primaryArchetype(a);
  const tags = new Set(a.archetypes.filter((t) => t.confidence >= 0.5).map((t) => t.tag));
  const gameEndingCombo = a.combos.some((c) => c.twoCard);
  if (gameEndingCombo || primary === "combo") return "combo";
  if (primary === "mill" || cards.some((c) => c.board === "main" && ALT_WIN.test(c.oracleText))) return "alternate";
  const drainCards = cards.filter((c) => DRAIN.test(c.oracleText)).length;
  if ((primary && DRAIN_TAGS.has(primary)) || drainCards >= 6 || (tags.has("aristocrats") && drainCards >= 3)) return "drain";
  if (primary && CONTROL_TAGS.has(primary)) return "control";
  return "combat";
}
