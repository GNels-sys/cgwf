import type { Section } from "./types.js";

/**
 * Default battlefield section from a type line. Creatures of any kind go to
 * Creatures (artifact and enchantment creatures included); unattached
 * Equipment and Vehicles to Artifacts; Auras to Enchantments; planeswalkers,
 * battles and anything odd to Other. Players can override by moving the card.
 */
export function defaultSection(typeLine: string): Section {
  const front = (typeLine.split(" // ")[0] ?? typeLine).toLowerCase();
  if (/\bcreature\b/.test(front)) return "creatures";
  if (/\bland\b/.test(front)) return "lands";
  if (/\b(planeswalker|battle)\b/.test(front)) return "other";
  if (/\bartifact\b/.test(front)) return "artifacts";
  if (/\benchantment\b/.test(front)) return "enchantments";
  return "other";
}

export const SECTION_LABELS: Record<Section, string> = {
  other: "Other",
  creatures: "Creatures",
  enchantments: "Enchantments",
  lands: "Lands",
  artifacts: "Artifacts",
};
