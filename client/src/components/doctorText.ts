/** "In stock at 2 local stores (from $1.25)"; null when no local store has it or stock is unknown. */
export function stockText(stores: number | null, cheapest: number | null): string | null {
  if (!stores) return null;
  return `In stock at ${stores} local ${stores === 1 ? "store" : "stores"}${cheapest !== null ? ` (from $${cheapest.toFixed(2)})` : ""}`;
}
