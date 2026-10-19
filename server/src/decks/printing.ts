import { eq } from "drizzle-orm";
import type { DbHandle } from "../db/index.js";
import { cards, type CardRow } from "../db/schema.js";

/**
 * Changing the printing of one deck line (own decks and library decks). The new printing must be the
 * SAME card: same oracle id (or, for the rare row without one, the same name), paper, not a token.
 * Returns the new card row, or why it cannot be used.
 */
export function checkPrintingSwap(handle: DbHandle, current: CardRow | undefined, cardId: unknown): { ok: true; row: CardRow } | { ok: false; status: number; error: string } {
  if (typeof cardId !== "string" || !cardId) return { ok: false, status: 400, error: "pick a printing" };
  if (!current) return { ok: false, status: 404, error: "deck entry not found" };
  const next = handle.db.select().from(cards).where(eq(cards.id, cardId)).get();
  if (!next) return { ok: false, status: 400, error: "unknown printing" };
  if (next.isDigital || next.isToken) return { ok: false, status: 400, error: "that printing cannot be used in a paper deck" };
  const same = current.oracleId && next.oracleId ? current.oracleId === next.oracleId : current.normalizedName === next.normalizedName;
  if (!same) return { ok: false, status: 400, error: `that printing is a different card (${next.name}), not ${current.name}` };
  return { ok: true, row: next };
}
