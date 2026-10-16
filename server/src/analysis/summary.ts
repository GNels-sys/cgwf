import { ARCHETYPE_LABELS, BRACKET_NAMES, type DeckAnalysis } from "@cgwf/shared";

function list(names: string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** One paragraph a player can read aloud at the table. */
export function summarize(a: Omit<DeckAnalysis, "summary">, commanders: string[]): string {
  const parts: string[] = [];
  const tags = a.archetypes.slice(0, 3).map((t) => ARCHETYPE_LABELS[t.tag].toLowerCase());
  const lead = commanders.length ? ` led by ${commanders.join(" and ")}` : "";
  parts.push(tags.length ? `A ${tags.join(" / ")} deck${lead}.` : `A deck${lead} with no single dominant strategy.`);
  parts.push(
    `${a.stats.cards} cards, ${a.stats.landCount} lands, average mana value ${a.stats.averageManaValue.toFixed(2)} off the lands; ${a.stats.rampCount} ramp, ${a.stats.cardDrawCount} draw, ${a.stats.interactionCount} interaction.`,
  );
  if (a.gameChangers.length) parts.push(`Game Changers: ${list(a.gameChangers)}.`);
  else parts.push("No Game Changers.");
  const bits: string[] = [];
  if (a.tutors.count) bits.push(`${a.tutors.count} tutor${a.tutors.count > 1 ? "s" : ""} (${list(a.tutors.cards.map((t) => t.name), 3)})`);
  if (a.fastMana.length) bits.push(`${a.fastMana.length} fast-mana piece${a.fastMana.length > 1 ? "s" : ""} (${list(a.fastMana, 3)})`);
  if (a.extraTurns.cards.length) bits.push(`${a.extraTurns.cards.length} extra-turn card${a.extraTurns.cards.length > 1 ? "s" : ""}${a.extraTurns.chaining ? " that can chain" : ""}`);
  if (a.massLandDenial.length) bits.push(`mass land denial (${list(a.massLandDenial, 3)})`);
  if (bits.length) parts.push(`Also: ${bits.join("; ")}.`);
  if (a.combosStatus === "ok") {
    const two = a.combos.filter((c) => c.twoCard);
    if (a.combos.length === 0) parts.push("Commander Spellbook finds no combos in the list.");
    else parts.push(`Commander Spellbook finds ${a.combos.length} combo${a.combos.length > 1 ? "s" : ""}, ${two.length} of them two-card${two.some((c) => c.early) ? " and cheap enough for the early game" : ""}.`);
  } else if (a.combosStatus === "unavailable") parts.push("Combo lookup was unavailable; the floor ignores combos for now.");
  parts.push(`Floor: Bracket ${a.floor} (${BRACKET_NAMES[a.floor]}). Suggested: Bracket ${a.suggested} (${BRACKET_NAMES[a.suggested]}).`);
  return parts.join(" ");
}
