/** Stable scenery follows a deck through sorting, navigation, and direct links. */
export function deckScenery(id: string): "forest" | "moon" | "ember" {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return (["forest", "moon", "ember"] as const)[hash % 3]!;
}
