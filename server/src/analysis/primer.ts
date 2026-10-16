import { ARCHETYPE_LABELS, BRACKET_NAMES, type DeckAnalysis } from "@cgwf/shared";
import { isCreature, isLand, type AnalysisCard } from "./cards.js";

/**
 * Primer skeleton: a Markdown outline the owner fills in by hand. Everything
 * in it comes from the analysis (no model call).
 *
 * Phase 7 hook: a model-written draft should replace the "(fill in)" lines and
 * keep these section headings, because the agent pilot reads them by name.
 */
export const PRIMER_SECTIONS = ["Archetype", "Game plan", "Win conditions", "Key synergies", "Game Changers", "Combos", "Early turns", "Weaknesses", "Agent notes"] as const;

function winConditions(a: DeckAnalysis, cards: AnalysisCard[]): string[] {
  const out: string[] = [];
  for (const c of a.combos) {
    const ending = c.produces.filter((p) => /win the game|infinite|lose the game/i.test(p));
    if (ending.length) out.push(`${c.cards.join(" + ")} -> ${ending.join(", ")}`);
  }
  const tags = new Set(a.archetypes.map((t) => t.tag));
  const commander = cards.filter((c) => c.board === "commander").map((c) => c.name);
  if (tags.has("voltron")) out.push(`Commander damage with ${commander.join(" / ") || "the commander"} suited up`);
  if (tags.has("tokens")) out.push("Go wide with tokens, then an anthem or overrun effect");
  if (tags.has("counters")) out.push("A few large +1/+1-counter creatures, ideally with trample or evasion");
  if (tags.has("aristocrats")) out.push("Drain the table with sacrifice triggers");
  if (tags.has("spellslinger") || tags.has("storm")) out.push("A big spell turn: copies, storm count or damage per spell");
  if (tags.has("reanimator")) out.push("Cheat a huge creature into play early");
  if (tags.has("lands")) out.push("Landfall triggers and lands as threats");
  if (tags.has("mill")) out.push("Empty an opponent's library");
  if (tags.has("lifegain")) out.push("Life as a resource: payoffs for gaining life");
  if (tags.has("aggro") || tags.has("tribal")) out.push("Combat damage from a wide, pumped board");
  if (tags.has("big_mana")) out.push("Giant X spells or threats once mana is doubled");
  if (out.length === 0) out.push("(fill in: how does this deck actually win?)");
  return [...new Set(out)];
}

export function primerSkeleton(name: string, a: DeckAnalysis, cards: AnalysisCard[]): string {
  const commanders = cards.filter((c) => c.board === "commander").map((c) => c.name);
  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push("");
  lines.push(`Commander: ${commanders.join(" / ") || "(none)"}. Bracket ${a.suggested} (${BRACKET_NAMES[a.suggested]}), floor ${a.floor}.`);
  lines.push("");
  lines.push("## Archetype");
  lines.push(a.archetypes.length ? a.archetypes.map((t) => `- ${ARCHETYPE_LABELS[t.tag]} (${Math.round(t.confidence * 100)}%): ${t.evidence.slice(0, 4).join(", ")}`).join("\n") : "- (fill in)");
  lines.push("");
  lines.push("## Game plan");
  lines.push(a.summary);
  lines.push("");
  lines.push("(fill in: the first three turns, what to protect, when to go for it)");
  lines.push("");
  lines.push("## Win conditions");
  lines.push(winConditions(a, cards).map((w) => `- ${w}`).join("\n"));
  lines.push("");
  lines.push("## Key synergies");
  const syn = a.archetypes
    .flatMap((t) => t.evidence.slice(0, 3))
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 8);
  lines.push(syn.length ? syn.map((s) => `- ${s}: (fill in why it matters)`).join("\n") : "- (fill in)");
  lines.push("");
  lines.push("## Game Changers");
  lines.push(a.gameChangers.length ? a.gameChangers.map((g) => `- ${g}`).join("\n") : "- none");
  lines.push("");
  lines.push("## Combos");
  lines.push(
    a.combos.length
      ? a.combos
          .slice(0, 8)
          .map((c) => `- ${c.cards.join(" + ")} -> ${c.produces.join(", ")}${c.twoCard ? " (two-card)" : ""}`)
          .join("\n")
      : a.combosStatus === "ok"
        ? "- none found on Commander Spellbook"
        : "- (combo lookup unavailable)",
  );
  lines.push("");
  lines.push("## Early turns");
  const ramp = cards
    .filter((c) => !isLand(c) && c.cmc <= 2 && /\badd \{/i.test(c.oracleText))
    .map((c) => c.name)
    .slice(0, 8);
  lines.push(`- Lands: ${a.stats.landCount}. Ramp: ${a.stats.rampCount}. Fast mana: ${a.fastMana.join(", ") || "none"}.`);
  lines.push(ramp.length ? `- Cheap mana: ${ramp.join(", ")}` : "- Cheap mana: (fill in)");
  lines.push("- Mulligan for: (fill in: lands + one ramp piece + one engine?)");
  lines.push("");
  lines.push("## Weaknesses");
  lines.push("- (fill in: what wrecks this deck - graveyard hate, board wipes, stax?)");
  lines.push("");
  lines.push("## Agent notes");
  lines.push(`- Creatures: ${cards.filter((c) => isCreature(c) && c.board === "main").length}. Interaction: ${a.stats.interactionCount}. Draw: ${a.stats.cardDrawCount}.`);
  lines.push("- (fill in: anything a bot pilot should know - hold counters for X, never cast Y into open mana)");
  lines.push("");
  return lines.join("\n");
}
