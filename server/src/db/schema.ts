import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * Players. Every visitor starts as a device-only profile (name + avatar, no
 * password). Adding an email + password turns it into an account that can sign
 * in from other devices. Credentials live here; the tokens that identify a
 * device live in `sessions`. `is_owner` is granted only through the one-time
 * claim code (never by email alone).
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** One of the preset avatar keys (see shared AVATARS). */
    avatar: text("avatar").notNull(),
    /** One of the preset colour keys (see shared AVATAR_COLORS). */
    color: text("color").notNull(),
    /** Lower-cased; null for a device-only profile. */
    email: text("email"),
    /** scrypt record (see auth/password.ts); null for a device-only profile. */
    passwordHash: text("password_hash"),
    isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/**
 * One row per signed-in device. The client holds the random token; we store
 * only its SHA-256 hash. Deleting a row signs that device out.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Human label derived from the User-Agent ("iPhone / Safari"). */
    device: text("device").notNull().default(""),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const decks = sqliteTable(
  "decks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** "commander" only in v1; kept as a column for later formats. */
    format: text("format").notNull().default("commander"),
    /** The pasted list, kept so an import can be re-run or inspected. */
    sourceText: text("source_text"),
    sourceUrl: text("source_url"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("decks_user_idx").on(t.userId)],
);

export const deckCards = sqliteTable(
  "deck_cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deckId: text("deck_id")
      .notNull()
      .references(() => decks.id, { onDelete: "cascade" }),
    /** Scryfall printing id. */
    cardId: text("card_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** "main" | "commander" | "sideboard" | "maybeboard" | "companion". */
    board: text("board").notNull().default("main"),
    /** User's category tag from the import ("Ramp", "Removal"), if any. */
    category: text("category"),
    /** Order within the list, for stable display. */
    position: integer("position").notNull().default(0),
  },
  (t) => [index("deck_cards_deck_idx").on(t.deckId), index("deck_cards_card_idx").on(t.cardId)],
);

/**
 * A room is one game table: a join code, a host, seats and (once started) an
 * append-only event log. The RNG seed never leaves the server.
 */
export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    hostUserId: text("host_user_id")
      .notNull()
      .references(() => users.id),
    /** "lobby" | "playing" | "ended" */
    status: text("status").notNull().default("lobby"),
    format: text("format").notNull().default("commander"),
    seed: text("seed").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
    /** Set when the host starts a rematch: the room everyone should move to. */
    nextRoomId: text("next_room_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("rooms_code_idx").on(t.code), index("rooms_updated_idx").on(t.updatedAt)],
);

export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "player" | "spectator" */
    role: text("role").notNull().default("spectator"),
    seat: integer("seat"),
    deckId: text("deck_id"),
    joinedAt: text("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index("room_members_user_idx").on(t.userId)],
);

/** Append-only game log. seq is 1-based and contiguous per room. */
export const roomEvents = sqliteTable(
  "room_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** User id, or "system". */
    actor: text("actor").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    ts: integer("ts").notNull(),
  },
  (t) => [uniqueIndex("room_events_seq_idx").on(t.roomId, t.seq)],
);

/**
 * Per-user personalization (playmat, sleeves, theme, layout) as one JSON blob,
 * validated by shared `sanitizeSettings` on every read and write. Applied
 * client-side only; the server never renders.
 */
export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  settings: text("settings", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Player-uploaded images (playmats, sleeve backs). Files live under
 * DATA_DIR/uploads/<id>.<ext>; the id is 16 random bytes in hex. Served only
 * to the owner and to players who share a room with the owner.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "playmat" | "sleeve" */
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("uploads_user_idx").on(t.userId)],
);

export type CardRow = typeof cards.$inferSelect;
export type NewCardRow = typeof cards.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DeckRow = typeof decks.$inferSelect;
export type DeckCardRow = typeof deckCards.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
export type RoomEventRow = typeof roomEvents.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;
