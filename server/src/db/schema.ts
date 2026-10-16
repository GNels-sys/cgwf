import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per Scryfall printing (English only). JSON columns hold the
 * structured bits; everything a rules engine might need later is kept.
 */
export const cards = sqliteTable(
  "cards",
  {
    id: text("id").primaryKey(),
    oracleId: text("oracle_id"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    set: text("set").notNull(),
    setName: text("set_name").notNull(),
    collectorNumber: text("collector_number").notNull(),
    releasedAt: text("released_at").notNull(),
    rarity: text("rarity").notNull(),
    layout: text("layout").notNull(),
    manaCost: text("mana_cost").notNull().default(""),
    cmc: real("cmc").notNull().default(0),
    typeLine: text("type_line").notNull().default(""),
    oracleText: text("oracle_text").notNull().default(""),
    power: text("power"),
    toughness: text("toughness"),
    loyalty: text("loyalty"),
    defense: text("defense"),
    colors: text("colors", { mode: "json" }).$type<string[]>().notNull(),
    colorIdentity: text("color_identity", { mode: "json" }).$type<string[]>().notNull(),
    keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
    legalities: text("legalities", { mode: "json" }).$type<Record<string, string>>().notNull(),
    faces: text("faces", { mode: "json" }).$type<unknown[]>().notNull(),
    /** {small, normal, large} Scryfall URLs for the front face. */
    imageFront: text("image_front", { mode: "json" }).$type<Record<string, string> | null>(),
    /** Same for the back face of two-faced layouts. */
    imageBack: text("image_back", { mode: "json" }).$type<Record<string, string> | null>(),
    imageStatus: text("image_status").notNull().default(""),
    isToken: integer("is_token", { mode: "boolean" }).notNull().default(false),
    isPromo: integer("is_promo", { mode: "boolean" }).notNull().default(false),
    isDigital: integer("is_digital", { mode: "boolean" }).notNull().default(false),
    inBooster: integer("in_booster", { mode: "boolean" }).notNull().default(false),
    artist: text("artist"),
    scryfallUri: text("scryfall_uri").notNull().default(""),
    /** Ingest run that last saw this printing; rows from older runs are pruned. */
    seenRun: integer("seen_run").notNull().default(0),
  },
  (t) => [
    index("cards_normalized_name_idx").on(t.normalizedName),
    index("cards_oracle_id_idx").on(t.oracleId),
    index("cards_set_number_idx").on(t.set, t.collectorNumber),
  ],
);

/** Small key/value store for ingest bookkeeping. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type CardRow = typeof cards.$inferSelect;
export type NewCardRow = typeof cards.$inferInsert;
