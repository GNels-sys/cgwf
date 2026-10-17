import { and, eq } from "drizzle-orm";
import { normalizeName, type CardPrinting } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";
import { rowToPrinting } from "../scryfall/map.js";
import type { NameIndex } from "../search/index.js";

/**
 * Forge identifies a card by name + edition code + collector number; CGwF by Scryfall printing
 * id. Forge's edition files carry Scryfall's set code (the engine sends it as `scryfallSet`), so
 * most cards resolve by (set, number) to the exact printing the player owns; the rest by name
 * through the NameIndex (best printing), tokens through the token printings by name + P/T.
 * Results are cached per mapper (one mapper per table), keyed by the engine's card id.
 */

export interface EngineCardRef {
  name: string;
  scryfallSet?: string | null | undefined;
  set?: string | null | undefined;
  number?: string | null | undefined;
  token?: boolean | undefined;
  power?: number | null | undefined;
  toughness?: number | null | undefined;
}

export class PrintingMapper {
  private readonly byCardId = new Map<number, CardPrinting | null>();
  private readonly byKey = new Map<string, CardPrinting | null>();

  constructor(
    private readonly handle: DbHandle,
    private readonly index: NameIndex,
  ) {}

  /** Printing for an engine card id, resolving (and caching) from the reference on first sight. */
  forCard(cardId: number, ref: EngineCardRef | null): CardPrinting | null {
    const hit = this.byCardId.get(cardId);
    if (hit !== undefined) return hit;
    if (!ref) return null;
    const printing = this.resolve(ref);
    this.byCardId.set(cardId, printing);
    return printing;
  }

  known(cardId: number): CardPrinting | null | undefined {
    return this.byCardId.get(cardId);
  }

  /** Pre-populate from the engine's `cards` frame (every card at the start of the game). */
  learn(cardId: number, ref: EngineCardRef): CardPrinting | null {
    const printing = this.resolve(ref);
    this.byCardId.set(cardId, printing);
    return printing;
  }

  /** Restore from a persisted map (room engine_state) without hitting the resolver again. */
  restore(entries: Array<{ cardId: number; printingId: string | null }>): void {
    for (const e of entries) {
      if (!e.printingId) {
        this.byCardId.set(e.cardId, null);
        continue;
      }
      const row = this.handle.db.select().from(cards).where(eq(cards.id, e.printingId)).get();
      this.byCardId.set(e.cardId, row ? rowToPrinting(row) : null);
    }
  }

  entries(): Array<{ cardId: number; printingId: string | null }> {
    return [...this.byCardId].map(([cardId, p]) => ({ cardId, printingId: p?.id ?? null }));
  }

  resolve(ref: EngineCardRef): CardPrinting | null {
    const set = (ref.scryfallSet ?? ref.set ?? "").toLowerCase();
    const number = ref.number ?? "";
    const key = `${ref.token ? "t" : "c"}|${normalizeName(ref.name)}|${set}|${number}|${ref.power ?? ""}|${ref.toughness ?? ""}`;
    const cached = this.byKey.get(key);
    if (cached !== undefined) return cached;
    const printing = this.lookup(ref, set, number);
    this.byKey.set(key, printing);
    return printing;
  }

  private lookup(ref: EngineCardRef, set: string, number: string): CardPrinting | null {
    const norm = normalizeName(ref.name);
    if (set && number) {
      const row = this.handle.db
        .select()
        .from(cards)
        .where(and(eq(cards.set, set), eq(cards.collectorNumber, number)))
        .get();
      // The number must belong to the same card (Forge numbers can drift from Scryfall's for a few sets).
      if (row && (row.normalizedName === norm || normalizeName(row.name.split(" // ")[0] ?? row.name) === norm)) return rowToPrinting(row);
    }
    if (ref.token) {
      const rows = this.handle.db.select().from(cards).where(and(eq(cards.isToken, true), eq(cards.normalizedName, norm))).all();
      if (rows.length) {
        const p = ref.power == null ? null : String(ref.power);
        const t = ref.toughness == null ? null : String(ref.toughness);
        const exact = rows.find((r) => (p === null || r.power === p) && (t === null || r.toughness === t));
        return rowToPrinting(exact ?? rows[0]!);
      }
    }
    const entry = this.index.exact(norm) ?? this.index.exact(normalizeName(ref.name.split(" // ")[0] ?? ref.name));
    if (entry) {
      const row = this.handle.db.select().from(cards).where(eq(cards.id, entry.id)).get();
      if (row) return rowToPrinting(row);
    }
    if (set) {
      const row = this.handle.db
        .select()
        .from(cards)
        .where(and(eq(cards.set, set), eq(cards.normalizedName, norm)))
        .get();
      if (row) return rowToPrinting(row);
    }
    return null;
  }
}
