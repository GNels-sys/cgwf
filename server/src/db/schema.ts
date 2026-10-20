import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /** Scryfall purchase_uris (tcgplayer, cardmarket, cardhoarder), Phase 10; null when Scryfall lists none. */
    purchaseUris: text("purchase_uris", { mode: "json" }).$type<Record<string, string> | null>(),
    /**
     * How the printing looks (2026-10-19, migration 0014): Scryfall's set_type, frame, frame_effects,
     * border_color, full_art, textless, promo_types, finishes, oversized. `isRegular` = none of the
     * special treatments in shared/src/printing.ts; `treatmentCount` = how many (0 = regular). The name
     * index prefers the lowest count, then the newest. Rows ingested before 0014 keep the defaults until
     * the next ingest (`node server/dist/cli.js ingest --force`).
     */
    setType: text("set_type").notNull().default(""),
    frame: text("frame").notNull().default(""),
    frameEffects: text("frame_effects", { mode: "json" }).$type<string[]>().notNull().default([]),
    borderColor: text("border_color").notNull().default(""),
    fullArt: integer("full_art", { mode: "boolean" }).notNull().default(false),
    textless: integer("textless", { mode: "boolean" }).notNull().default(false),
    promoTypes: text("promo_types", { mode: "json" }).$type<string[]>().notNull().default([]),
    finishes: text("finishes", { mode: "json" }).$type<string[]>().notNull().default([]),
    oversized: integer("oversized", { mode: "boolean" }).notNull().default(false),
    isRegular: integer("is_regular", { mode: "boolean" }).notNull().default(false),
    treatmentCount: integer("treatment_count").notNull().default(0),
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
    /** Computer opponent (Phase 7): no sessions, no sign-in, seated by the owner. */
    isAgent: integer("is_agent", { mode: "boolean" }).notNull().default(false),
    /** Phase 8: short unique code friends type to add each other (assigned lazily, see social/codes.ts). */
    friendCode: text("friend_code"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email), uniqueIndex("users_friend_code_idx").on(t.friendCode)],
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
    /** Rules-engine table: the Forge service runs the game; the event log holds EngineLog/EngineAnswer rows. */
    engine: integer("engine", { mode: "boolean" }).notNull().default(false),
    /** JSON (seats with Forge player ids, card id -> printing id map) so a restart can still render the table. */
    engineState: text("engine_state"),
    /** Lobby setting "Test game": the game is played normally but never counted in deck statistics. */
    testGame: integer("test_game", { mode: "boolean" }).notNull().default(false),
    /** Lobby setting "Table bracket" chosen by the host (null = the highest suggested bracket among seated decks). */
    tableBracket: integer("table_bracket"),
    /** Discord voice (2026-10-19): the bot's temporary voice channel for this table and its invite URL. */
    voiceChannelId: text("voice_channel_id"),
    voiceInviteUrl: text("voice_invite_url"),
    /** Manual fallback: a Discord invite the host pasted (or their saved default), when the bot is off. */
    voiceManualUrl: text("voice_manual_url"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("rooms_code_idx").on(t.code), index("rooms_updated_idx").on(t.updatedAt)],
);

/**
 * One rules-engine game (one per room), frozen at game start and finished at game over. COUNTED in deck
 * statistics only when it is an engine game, not a test game, and Forge reported a result (a winner or a
 * draw). Tables closed without a finish are "abandoned" and never counted. Never written by the classic table.
 */
export const gameResults = sqliteTable(
  "game_results",
  {
    /** = rooms.id */
    id: text("id").primaryKey(),
    roomCode: text("room_code").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    /** The table bracket agreed in the lobby, frozen at start (1-5). */
    tableBracket: integer("table_bracket"),
    playerCount: integer("player_count").notNull(),
    test: integer("test", { mode: "boolean" }).notNull().default(false),
    counted: integer("counted", { mode: "boolean" }).notNull().default(false),
    /** "win" | "draw" | "abandoned"; null while the game runs. */
    endReason: text("end_reason"),
    /** Forge's own end reason (AllOpponentsLost, Draw, ...) or why the table was closed. */
    detail: text("detail"),
    turns: integer("turns"),
  },
  (t) => [index("game_results_counted_idx").on(t.counted)],
);

/**
 * AI Coach M1: one decision a HUMAN seat made on a rules-engine table (a prompt it answered), with that
 * seat's OWN view at that moment (own hand, public zones, stack, mana, what was playable; never another
 * hand or any library). gzip-compressed JSON. Readable only by that seat's user. Kept 90 days.
 */
export const decisionSnapshots = sqliteTable(
  "decision_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** = rooms.id = game_results.id (no FK: a snapshot may be written before the result row exists) */
    roomId: text("room_id").notNull(),
    seat: integer("seat").notNull(),
    userId: text("user_id").notNull(),
    /** Order within the room (the relay's event sequence when the answer was recorded). */
    seq: integer("seq").notNull(),
    turn: integer("turn"),
    promptKind: text("prompt_kind").notNull(),
    createdAt: text("created_at").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
  },
  (t) => [index("decision_snapshots_room_user_idx").on(t.roomId, t.userId), index("decision_snapshots_created_idx").on(t.createdAt)],
);

/** AI Coach M2 (owner only): one cached coach report per game and player, with its model spend. */
export const coachReports = sqliteTable(
  "coach_reports",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    roomCode: text("room_code").notNull(),
    userId: text("user_id").notNull(),
    /** "full" (decision snapshots) | "light" (public log + recorded answers only) */
    kind: text("kind").notNull(),
    /** "running" | "done" | "error" | "capped" */
    status: text("status").notNull(),
    model: text("model").notNull(),
    /** The report (JSON: summary, turning points, habits), null until done. */
    report: text("report", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    calls: integer("calls").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("coach_reports_room_user_idx").on(t.roomId, t.userId), index("coach_reports_created_idx").on(t.createdAt)],
);

/** One follow-up question on a coach report (one at a time), counted in spend. */
export const coachFollowups = sqliteTable(
  "coach_followups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reportId: text("report_id")
      .notNull()
      .references(() => coachReports.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    answer: text("answer"),
    /** "running" | "done" | "error" */
    status: text("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("coach_followups_report_idx").on(t.reportId)],
);

/** One seat of a recorded game: who, with which deck (snapshot survives deletions), and how it went. */
export const gameResultSeats = sqliteTable(
  "game_result_seats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id")
      .notNull()
      .references(() => gameResults.id, { onDelete: "cascade" }),
    seat: integer("seat").notNull(),
    /** users.id of the player (or of the bot user); no FK so history survives a deleted profile. */
    userId: text("user_id"),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
    /** The deck: a user deck id, or "library:<library_decks.id>" (bots' library copies map to their library deck). */
    deckRef: text("deck_ref"),
    /** Owner of a personal deck (null for library decks): personal-deck stats are visible only to them. */
    deckOwnerId: text("deck_owner_id"),
    deckName: text("deck_name").notNull(),
    commanders: text("commanders", { mode: "json" }).$type<string[]>().notNull(),
    /** The deck's bracket at game start (library: stored; own deck: the analysis suggestion). */
    deckBracket: integer("deck_bracket"),
    place: integer("place"),
    won: integer("won", { mode: "boolean" }).notNull().default(false),
    conceded: integer("conceded", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("game_result_seats_game_idx").on(t.gameId), index("game_result_seats_deck_idx").on(t.deckRef)],
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

/**
 * Commander Spellbook "find my combos" answers, cached per exact card list
 * (SHA-256 of the sorted names) so re-opening a deck page costs no request.
 */
export const comboCache = sqliteTable("combo_cache", {
  listHash: text("list_hash").primaryKey(),
  /** Raw results object from Spellbook (included / almostIncluded ...). */
  results: text("results", { mode: "json" }).$type<unknown>().notNull(),
  fetchedAt: text("fetched_at").notNull(),
});

/**
 * The owner's deck library: imported precons plus hand-picked decks, each with
 * a bracket, archetype tags and a primer. Phase 7's agent opponents pick from
 * the rows with agent_eligible = 1.
 */
export const libraryDecks = sqliteTable(
  "library_decks",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** "precon" (MTGJSON import) | "user" (added from a player's deck) | "edhrec" (EDHREC average deck). */
    source: text("source").notNull(),
    /** Where the list came from (EDHREC average-deck page), shown with the attribution. */
    sourceUrl: text("source_url"),
    /** Importer details (EDHREC: slug, bracket, deck count, mismatch, Forge coverage), JSON. */
    importMeta: text("import_meta", { mode: "json" }).$type<unknown>(),
    /** Idempotency key: MTGJSON fileName for precons, the source deck id for user decks. */
    sourceKey: text("source_key"),
    setCode: text("set_code"),
    setName: text("set_name"),
    releaseDate: text("release_date"),
    /** Commander names, JSON array. */
    commanders: text("commanders", { mode: "json" }).$type<string[]>().notNull(),
    /** Owner-assigned bracket (precons default to 2). */
    bracket: integer("bracket").notNull().default(2),
    bracketFloor: integer("bracket_floor"),
    bracketSuggested: integer("bracket_suggested"),
    /** Archetype tags, JSON array (engine output, editable). */
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    primer: text("primer").notNull().default(""),
    /** When a model last drafted the primer (Phase 7); null = hand-written or skeleton only. */
    primerDraftedAt: text("primer_drafted_at"),
    primerModel: text("primer_model"),
    agentEligible: integer("agent_eligible", { mode: "boolean" }).notNull().default(false),
    /** Last full DeckAnalysis, JSON. */
    analysis: text("analysis", { mode: "json" }).$type<unknown>(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("library_decks_source_key_idx").on(t.sourceKey), index("library_decks_bracket_idx").on(t.bracket)],
);

export const libraryDeckCards = sqliteTable(
  "library_deck_cards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    libraryDeckId: text("library_deck_id")
      .notNull()
      .references(() => libraryDecks.id, { onDelete: "cascade" }),
    /** Scryfall printing id. */
    cardId: text("card_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    /** "main" | "commander" | "sideboard". */
    board: text("board").notNull().default("main"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("library_deck_cards_deck_idx").on(t.libraryDeckId)],
);

/**
 * One computer opponent in one game (Phase 7). Spend is summed from its
 * decisions; the per-game and per-day caps read these tables.
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    /** The agent's user row (users.is_agent = 1). */
    userId: text("user_id").notNull(),
    seat: integer("seat").notNull(),
    libraryDeckId: text("library_deck_id"),
    deckName: text("deck_name").notNull(),
    model: text("model").notNull(),
    /** "live" | "dry_run" (no API key). */
    mode: text("mode").notNull().default("live"),
    /** "running" | "ended" | "capped" | "error" | "stopped" */
    status: text("status").notNull().default("running"),
    decisions: integer("decisions").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    stoppedReason: text("stopped_reason"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [index("agent_runs_room_idx").on(t.roomId), index("agent_runs_started_idx").on(t.startedAt)],
);

export const agentDecisions = sqliteTable(
  "agent_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    roomId: text("room_id").notNull(),
    turn: integer("turn").notNull(),
    step: text("step").notNull(),
    /** "turn" | "trigger" | "mulligan" | "bottom" */
    kind: text("kind").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    /** "ok" | "invalid" | "timeout" | "error" | "capped" | "dry_run" | "refusal" */
    outcome: text("outcome").notNull(),
    /** The model's one-sentence rationale (text before its tool calls). */
    rationale: text("rationale").notNull().default(""),
    /** JSON: [{name, input, ok, error?}] */
    toolCalls: text("tool_calls", { mode: "json" }).$type<unknown>().notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("agent_decisions_run_idx").on(t.runId), index("agent_decisions_created_idx").on(t.createdAt)],
);

/**
 * Phase 8 social layer. A friendship is stored twice (one row per direction)
 * so "my friends" is a single equality query; both rows are written and
 * removed together.
 */
export const friendships = sqliteTable(
  "friendships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    friendId: text("friend_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] })],
);

export const friendRequests = sqliteTable(
  "friend_requests",
  {
    id: text("id").primaryKey(),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "pending" | "accepted" | "declined" */
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    respondedAt: text("responded_at"),
  },
  (t) => [index("friend_requests_to_idx").on(t.toUserId), index("friend_requests_from_idx").on(t.fromUserId)],
);

/** An invitation to a table. Dead once the room has ended (computed on read, never swept). */
export const roomInvites = sqliteTable(
  "room_invites",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    fromUserId: text("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toUserId: text("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "pending" | "accepted" | "declined" */
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull(),
    respondedAt: text("responded_at"),
  },
  (t) => [index("room_invites_to_idx").on(t.toUserId), uniqueIndex("room_invites_room_to_idx").on(t.roomId, t.toUserId)],
);

/**
 * In-app notifications (the bell). `payload` is JSON specific to `kind`:
 * friend_request {requestId, fromName}, friend_accepted {userId, name},
 * room_invite {inviteId, code, fromName}, submission_reviewed {submissionId, deckName, status, reason}.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/**
 * Agent deck queue: a player offers one of their decks for the owner's library.
 * The card list is frozen at submission time so later edits do not change what
 * was reviewed. Approval copies the frozen list into library_decks.
 */
export const librarySubmissions = sqliteTable(
  "library_submissions",
  {
    id: text("id").primaryKey(),
    deckId: text("deck_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deckName: text("deck_name").notNull(),
    note: text("note").notNull().default(""),
    /** Frozen [{cardId, quantity, board}] at submission time. */
    cards: text("cards", { mode: "json" }).$type<Array<{ cardId: string; quantity: number; board: string }>>().notNull(),
    commanders: text("commanders", { mode: "json" }).$type<string[]>().notNull(),
    /** "pending" | "approved" | "rejected" */
    status: text("status").notNull().default("pending"),
    reason: text("reason"),
    libraryDeckId: text("library_deck_id"),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [index("library_submissions_user_idx").on(t.userId), index("library_submissions_status_idx").on(t.status, t.createdAt)],
);

export type CardRow = typeof cards.$inferSelect;
export type FriendRequestRow = typeof friendRequests.$inferSelect;
export type RoomInviteRow = typeof roomInvites.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type LibrarySubmissionRow = typeof librarySubmissions.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentDecisionRow = typeof agentDecisions.$inferSelect;
export type LibraryDeckRow = typeof libraryDecks.$inferSelect;
export type LibraryDeckCardRow = typeof libraryDeckCards.$inferSelect;
export type NewCardRow = typeof cards.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type DeckRow = typeof decks.$inferSelect;
export type DeckCardRow = typeof deckCards.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type RoomMemberRow = typeof roomMembers.$inferSelect;
export type RoomEventRow = typeof roomEvents.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;

/**
 * Deck Doctor choices (2026-10-19): per player and deck, cards pinned as "keep" (never suggested as a
 * cut) and suggestions dismissed as "not interested" (never suggested again). `deck_ref` = an own deck
 * id or `library:<id>`; keyed by oracle id so a printing change does not lose the choice.
 */
export const deckDoctorPrefs = sqliteTable(
  "deck_doctor_prefs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deckRef: text("deck_ref").notNull(),
    oracleId: text("oracle_id").notNull(),
    name: text("name").notNull(),
    /** "keep" | "dismiss" */
    kind: text("kind").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("deck_doctor_prefs_unique").on(t.userId, t.deckRef, t.oracleId, t.kind)],
);

/**
 * Deck Doctor AI upgrade runs (2026-10-19, owner only): one row per run with its usage and cost, the
 * result (read of the deck + up to 5 swaps) and the deck version it was made for (cache key: re-opening
 * the same version costs nothing; "Run again" forces a new row).
 */
export const doctorAiRuns = sqliteTable(
  "doctor_ai_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    deckRef: text("deck_ref").notNull(),
    deckName: text("deck_name").notNull(),
    /** The deck's updatedAt when the run started. */
    deckVersion: text("deck_version").notNull(),
    targetBracket: integer("target_bracket").notNull(),
    allowHigher: integer("allow_higher", { mode: "boolean" }).notNull().default(false),
    model: text("model").notNull(),
    /** running | done | capped | refused | error */
    status: text("status").notNull(),
    calls: integer("calls").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    invalidSubmissions: integer("invalid_submissions").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    /** Which model actually answered (a refusal fallback can switch it). */
    servedBy: text("served_by"),
    result: text("result", { mode: "json" }),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("doctor_ai_runs_deck_idx").on(t.deckRef, t.deckVersion), index("doctor_ai_runs_started_idx").on(t.startedAt)],
);
