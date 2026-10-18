# CGwF - Card Games with Friends

Private virtual card table for four friends (think SpellTable, not Arena). Players enforce the
rules themselves in v1; the architecture must leave room for a rules engine later.
The owner is a non-developer directing the build: explain decisions briefly, prefer boring tech,
keep the repo readable.

## Non-negotiables

1. **Licensing.** Unofficial Fan Content under Wizards of the Coast's Fan Content Policy. Free, no
   payments, no WotC logos/trademarks in the UI or the app name. Every page shows the footer notice
   in `client/src/components/Footer.tsx` plus "Card data and images courtesy of Scryfall."
   Mana symbols are drawn as plain coloured dots (`ManaCost.tsx`), never Scryfall/WotC symbol art.
2. **Scryfall rules.** Bulk data only (`default_cards`), never per-card API calls at scale. Every
   request goes through `server/src/scryfall/client.ts` (User-Agent + Accept headers, 100 ms gap).
   Card data cached 24 h+. Images proxied and cached on the volume (`server/src/images.ts`),
   served byte-for-byte: never cropped, resized, recoloured or watermarked.
3. **Hidden information is server-enforced.** The server holds the only true state; each client
   gets a per-player view (`shared/src/game/view.ts`) that never contains identities of cards in
   libraries, other hands, or face-down cards. Proved by `shared/src/game/game.test.ts` (view
   serialisation) and `server/src/rooms/rooms.test.ts` (every frame on the wire).
4. **Server-authoritative, event-sourced.** Every action is an event appended to `room_events`;
   state is a pure reducer over the log plus a stored RNG seed (seeded shuffle, dice, ids). Reducer
   and event types live in `/shared` so client and server never disagree.

## Locked decisions (owner, 2026-10-15)

- Name: CGwF. Open web app; a 6-character join code gates each game. Rate-limit room creation and
  deck import.
- No voice/video. Light animations only, respecting `prefers-reduced-motion`.
- **SQLite** on the Fly volume via Drizzle (not Fly Postgres): one machine, one file. Drizzle keeps
  the schema portable.
- Commander only in v1 (keep `format` in the model). Partner commanders from day one. Track
  commander tax, life, poison, commander damage, every counter type.
- Battlefield = structured sections per player, three rows: Other on top, then Creatures |
  Enchantments, then Lands | Artifacts; tap an opponent to view their field. Phone landscape is
  the primary device.
- **No rules engine in v1, but assisted bookkeeping (owner, 2026-10-16):** the app may SUGGEST
  from card text (equipment/aura grants, anthems, triggers) and the player confirms or edits with
  a tap. Nothing is enforced or blocked; every confirmation is an event in the log.
- Interaction: tap-to-select + action sheet is primary; `@dnd-kit` drag is secondary.
- Stop after each phase's deploy so the owner can check it on their phone.

## Layout

```
shared/   types shared by both sides: card types, mana parser, API shapes, game model + reducer + view
server/   Fastify + better-sqlite3 + Drizzle; Scryfall ingest; image proxy; REST + WebSocket rooms
client/   React + Vite PWA (vite-plugin-pwa); plain CSS, mobile-first; the table under client/src/game
scripts/  bots.mjs: dev harness that seats three scripted players (see "Testing alone")
```

Scripts (root): `npm run dev` (server :8080 + client :5173 with proxy), `npm test`,
`npm run typecheck`, `npm run build`, `npm run ingest` (built CLI), `npm run db:generate`.

## Conventions

- TypeScript strict everywhere, ESM (`"type": "module"`, `.js` suffixes on relative imports in
  server/shared). Node 24, npm workspaces.
- `shared` must be built (`npm run build -w shared`) before server typecheck; Vite and Vitest alias
  `@cgwf/shared` to `shared/src` so dev and tests need no build.
- Schema changes: edit `server/src/db/schema.ts`, run `npm run db:generate`, commit the SQL under
  `server/drizzle/`. The server applies migrations on boot.
- Tests are Vitest. Server API tests ingest `server/src/scryfall/fixtures/cards.sample.json` into
  a temp SQLite file and hit routes with `app.inject`.
- Files are LF. Windows editors may write CRLF; `.gitattributes` normalises on commit.
- Images: `/img/{small|normal|large}/{scryfallId}.jpg` and `/img/{size}/{id}/back.jpg`.
- Config via env (`.env.example`). Secrets only in Fly secrets, never in the repo.

## Data flow (Phase 1)

Boot -> apply migrations -> build in-memory name index -> listen. 3 s later, if card data is
older than `CARD_DATA_MAX_AGE_HOURS`, download Scryfall's `default_cards` (gzipped JSON Lines,
~80 MB) to the volume and stream it into `cards` (upsert, then prune rows not seen this run).
The machine scales to zero, so there is no cron: staleness is checked on boot and hourly while
awake. A finished download survives an interrupted import.

Search: `NameIndex` keeps one best printing per oracle id (paper > promo-free > in boosters >
hi-res scan > newest) plus aliases for each face name; tiers exact > prefix > word > substring >
bounded edit distance.

## Identity and decks (Phase 2)

- Identity: `POST /api/me/register` creates a user and returns a device token once; the client
  keeps it in localStorage (`cgwf.token`) and sends `Authorization: Bearer`. The server stores only
  the SHA-256 hash (since Phase 5 in `sessions.token_hash`, one row per device). `requireUser` in
  `server/src/auth.ts` guards routes; rate limits key on the user when signed in, else the IP.
- Tables: `users`, `sessions`, `decks`, `deck_cards` (printing id + quantity + board + category +
  position); Phase 6 adds `combo_cache`, `library_decks`, `library_deck_cards`; Phase 7 adds
  `users.is_agent`, `agent_runs`, `agent_decisions`.
  Boards: main | commander | sideboard | maybeboard | companion. Format column kept, "commander" only.
- Parser: `shared/src/deck/parse.ts` (pure text -> lines/boards/tags/markers); fixtures for the
  five sites in `shared/src/deck/fixtures.ts`. Resolution against card data lives in
  `server/src/decks/resolve.ts`: exact set+number, then exact name (preferring the named set),
  then fuzzy -> "ambiguous" with candidates. Unlabelled lists (Moxfield/Goldfish) get the
  "first small block of legendary creatures = commander" heuristic.
- Routes: `POST /api/decks/parse`, `GET /api/decks/import-url?url=`, `GET/POST /api/decks`,
  `GET/PATCH/DELETE /api/decks/:id`, `PUT /api/decks/:id/cards`. Warnings (size, singleton,
  colour identity, commander count/partners) are computed on read, never block saving.
  Phase 8 adds `users.friend_code`, `friendships`, `friend_requests`, `room_invites`,
  `notifications`, `library_submissions`.
- URL import finding (2026-10-15): Archidekt's `https://archidekt.com/api/decks/{id}/` is public
  JSON (cards carry Scryfall `uid`, set code, collector number, categories; "Commander" category =
  commander; categories with `includedInDeck=false` = maybeboard). Moxfield's API returns 403 to
  non-browser clients, so Moxfield users paste the text export.
- Client routes: `/` decks (welcome screen when signed out, Phase 8), `/decks/new` import (paste or
  Archidekt link -> review/fix -> save), `/decks/:id`, `/cards` search, `/me` profile, `/signup`,
  `/signin`, `/start`, `/welcome`, `/friends`. `RequireUser` shows the first-run profile form.

## The game (Phase 3)

### Model (`shared/src/game/`)

- `types.ts`: `GameState` = players (life, counters, commanderDamage, commanderTax, mulligans, kept,
  toBottom, conceded, zones) + `cards` (one `CardInstance` per physical card or token: full
  `CardPrinting`, owner, zone {kind, owner, row}, tapped, faceDown, face, counters, attachedTo,
  revealedTo, effect, modifier, anthemDismissed) + turnOrder / activePlayer / turn / step +
  `rng` + `log` + `seq` + `pendingTriggers`. Zones: library (index 0 = top), hand, graveyard,
  exile, command, battlefield sections other | creatures | enchantments | lands | artifacts
  (`zone.row`; `sections.ts` picks the default from the type line: any creature -> creatures,
  land -> lands, planeswalker/battle -> other, artifact (equipment, vehicles) -> artifacts,
  enchantment (auras) -> enchantments; players can move a card to any section). Players also
  carry `mana` (W/U/B/R/G/C pool), `keepMana` and `manualAnthems`.
  `stack` and `priority` exist but are never used (reserved for a rules engine).
- Events (`EventPayloads`): GameStarted, Mulligan, HandKept, CardsDrawn, CardMoved, CardTapped,
  UntapAll, CardFlipped, CardTurned, CardRevealed, CounterChanged, LifeChanged,
  PlayerCounterChanged, CommanderDamage, CommanderTaxChanged, LibraryShuffled, LibraryRevealed,
  LibraryLooked, LibrarySearched, Milled, TokenCreated, CardCopied, Attached, TurnAdvanced,
  StepAdvanced, StepSet, DiceRolled, CoinFlipped, RandomOpponent, PlayerConceded, Revert, plus
  the bookkeeping events AttachmentEffectSet, CardModifierSet, AnthemDismissed,
  ManualAnthemAdded/Removed, TriggerResolved, TriggersDismissed, ManaChanged, ManaConverted,
  ManaEmptied, KeepManaToggled, and the table-hygiene events ControlTaken, AttackersDeclared,
  BlockersDeclared, CombatDamageDealt, WinClaimed, WinAdvisoryDismissed (see "Table hygiene").
  `Attached` carries the confirmed `effect` {power, toughness, keywords}. Clients send `{type,
  payload}`; the server stamps `seq` (1-based, contiguous), `actor`, `ts`. `GameState` also
  carries `drewForTurn`, `combat`, `winAdvisories`, `dismissedWins`; players carry `eliminated`.
- `reducer.ts`: `applyEvent(state, event, seed)` is pure and throws `GameError` for illegal
  actions (nobody touches another player's hand or library; only the controller of a permanent
  acts on it; spectators act on nothing; only the host starts). `replay(events, seed)` rebuilds
  state; a `Revert {toSeq}` replays the prefix up to `toSeq` and later events continue from there.
  Log lines name a card only when its identity is public.
- `rng.ts`: mulberry32 seeded from the room's secret seed (FNV-1a). Shuffles, dice, coins, random
  opponent and instance ids all come from the stream, so replays agree. The seed never leaves the
  server.
- Visibility (`revealedTo`): library cards are hidden from everyone until LibraryLooked/Searched
  (owner only) or LibraryRevealed (all); a shuffle forgets. Hand cards are visible to their owner
  only unless CardRevealed. Face-down battlefield/exile cards are visible to owner/controller.
  Any move resets reveals.
- `view.ts`: `viewFor(state, viewerId | null)` -> `PlayerView` + the printings it references.
  Hidden cards have `printingId: null` and are not listed at all when in a library or another
  hand (counts only). Spectators get `viewer: null`.

### Assisted bookkeeping (`shared/src/game/effects.ts`, `triggers.ts`)

- Attachments: on "Attach to...", the client runs `parseAttachmentEffect` on the attachment's
  oracle text and prefills a confirm sheet (P/T + editable keyword chips); the confirmed effect
  travels in the `Attached` event (editable later via AttachmentEffectSet). Parser catches
  "Equipped/Enchanted creature gets +X/+Y", "... and has <kw>, <kw> and <kw>", "has <kw>" alone,
  "protection from X and from Y". It does NOT evaluate conditionals ("+1/+1 for each", "as long
  as"): it reports the base numbers and the player edits. Attachments sit in the host's section,
  render under the host, move with it, and are re-sectioned (equipment -> artifacts, auras ->
  enchantments) with their effect cleared when unattached or when the host leaves.
- Anthems: `parseAnthem` detects "Creatures you control get +X/+Y [and have kw]" and the "Other
  creatures you control" form (source excluded). Temporary ("until end of turn"), conditional
  ("as long as", "for each") and subset anthems ("Creature tokens you control") are ignored; the
  player adds those manually (ManualAnthemAdded, with a note) from the Creatures header badge.
  Detected anthems can be hidden per source (AnthemDismissed).
- `deriveBattlefield(cards, getPrinting, manualAnthems)` is the single derivation used by server
  tests and every client: displayed P/T = printed + (+1/+1) - (-1/-1) + attachment effects +
  active anthems + manual modifier; keywords = printed + granted + manual - removed. Tiles show
  the P/T badge (gold when modified) and one chevron per keyword; the zoom view lists every
  granted effect and attachment.
- Triggers: `detectTriggers(stateAfter, event)` runs inside the reducer after every event and
  appends advisory `pendingTriggers` (cleared on TurnAdvanced). Families: Landfall (keyword or
  "whenever a land [you control] enters"), own-permanent ETB ("whenever a/another creature |
  artifact | enchantment (constellation) | permanent enters [under your control]"), the entering
  card's own "When ~ enters", and "at the beginning of your/each upkeep | draw step | precombat
  main phase | combat | end step" (yours = active player only, each = everyone). Not covered:
  opponent-side triggers, dies/attacks/damage triggers, "whenever you cast". The Triggers panel
  lists mine (tap = TriggerResolved, logged), matching tiles glow green for everyone.
- Mana bank: ManaChanged/ManaConverted/ManaEmptied/KeepManaToggled; the reducer empties every
  player's pool on StepAdvanced/StepSet/TurnAdvanced unless `keepMana`, logging it. Pools are
  public (pill in the turn bar, summary in opponent chips).

### Server (`server/src/rooms/`)

- Tables: `rooms` (code, host, status lobby|playing|ended, seed, last_seq), `room_members`
  (role player|spectator, seat 0-3, deck_id), `room_events` (append-only, unique room_id+seq).
- `live.ts`: `RoomManager` creates/loads rooms; `LiveRoom` caches events + reduced state while
  anyone is connected (evicted after 30 min idle), validates every client event with the reducer
  before persisting (one SQLite transaction: insert event + bump rooms.last_seq/status), then
  fans out per-connection views. `TokenCreated.printing` is replaced by the real printing from
  `cards` (clients cannot forge card data); custom tokens are length-capped.
- Undo = a `Revert {reason: "undo"}` to `last.seq - 1`, allowed only when the requester made the
  last event; it is silent (the undone log line simply disappears). Explicit revert from the log is
  open to any seated player and is announced ("Blair reverted the game to #12").
- REST: `POST /api/rooms` (10/hour per user), `GET /api/rooms/mine`, `GET /api/rooms/decks`,
  `GET /api/rooms/:code`, `POST /api/rooms/:code/join`.
- WebSocket `GET /api/rooms/:code/ws?token=<device token>` (`@fastify/websocket`, 256 KB frames,
  25 msgs/s per socket). Client -> server: `seat {seat, deckId}`, `unseat`, `start` (host),
  `event {event, cid?}`, `undo`, `revert {toSeq}`, `leave`, `ping`. Server -> client:
  `room {room}` (members, seats, decks, online flags, `you`), `state {view, printings}` where
  `printings` holds only printings not yet sent on this connection (the client keeps a
  catalogue keyed by printing id), `error {message, cid?}`, `pong`.
- Reconnect: a new socket gets `room` + a full `state` (and its printings again). Nothing is
  kept client-side, so a phone that force-quits simply rejoins.
- Leaving during a game concedes first; the host role passes to the next player.
- Rematch (`rematch` message, host only, status ended): `RoomManager.rematch` creates a new room
  with a fresh seed, copies every member with their seat and deck, starts it at once (or leaves it
  as a lobby if a deck vanished) and stores `rooms.next_room_id` on the old room, which goes out as
  `RoomInfo.nextCode` so every client can follow.

### Client (`client/src/game/`)

- `/play` create/join/recent, `/room/:code` = `Lobby` (seats, own-deck picker, share link, host
  start) or `Table` once playing. `socket.ts` reconnects with backoff and on tab wake.
- Table: opponents across the top (tap -> `OpponentPanel`, same `Battlefield` layout as mine),
  the phase strip (`PhaseStrip.tsx`: turn + active player, every step as a dot with the current
  one lit and labelled, Next step / Pass turn always reachable, Attack on my turn, the combat and
  win prompts, and the combat picking bar as its child), my battlefield (`Battlefield.tsx`:
  sections, stacked attachments, anthem badge, combat marks), hand drawer, zone buttons, life
  widget, mana pill, triggers panel. Tap a card -> `ActionSheet`
  (`actions.ts` builds the list per zone); press-and-hold -> `CardZoom`. `@dnd-kit` drag onto
  rows/zone buttons is the secondary path. Menu: log (tap a line to revert), dice, tokens
  (Scryfall token search or custom text token), undo, untap all, concede, leave.
- Mulligan overlay handles London mulligans; `toBottom` in the state drives the "put N on the
  bottom" step. Pass turn untaps the new active player's permanents automatically (re-tap what
  should stay tapped) and the reducer draws for the turn once the draw step is reached or passed.
- Hidden cards draw the owner's sleeve (a CSS preset or their upload), never the official card back.
- Table-to-table navigation (rematch) reuses `useRoomSocket` with a new code; the hook ignores
  events from a socket it has already replaced (`wsRef.current !== ws`).

## Polish (Phase 4)

- **Log** (`reducer.ts`): every line is a past-tense sentence naming the actor ("Alex played Sol
  Ring", "Blair lost 3 life (now 37)", "Alex put a +1/+1 counter on X (now 2)"); hidden cards are
  "a card". `LogPanel` draws turn lines as separators with the actor's avatar colour.
- **Token finder** (`GET /api/tokens?q=`, `client/src/game/TokenFinder.tsx`): searches `is_token`
  printings, collapses them to one entry per name + P/T + colours + text (`distinctTokens`),
  understands "2/2 zombie", lists popular tokens with no query, remembers recent ones in
  localStorage, and keeps the text-only custom token. The Token button sits with the zone buttons.
  Tokens cease to exist when they leave the battlefield (reducer `moveCard`).
- **Personalization** (`shared/src/settings.ts`): `UserSettings` = playmat + sleeve (`Texture`:
  preset id or upload id), table theme, accent, light/dark UI, ambient loop, layout (card scale,
  hand top/bottom, opponent panel size, opponents in a strip or around the table, compact).
  `sanitizeSettings` coerces anything into valid settings; stored as JSON in `user_settings`
  (`GET/PUT /api/me/settings`). The client `SettingsProvider` applies UI + accent on
  `<html>` and caches a copy in localStorage (`cgwf.settings`); `Table` applies the rest as CSS
  classes/variables (`theme-*`, `is-compact`, `hand-top`, `opp-around`, `--card-scale`).
  `RoomMember.look` carries each player's playmat + sleeve to the whole table and is rebroadcast
  when settings change (`RoomManager.userChanged`). Presets are pure CSS (`mat-*`, `sleeve-*`
  in game.css); no image files.
- **Uploads** (`server/src/uploads.ts`, `routes/settings.ts`): `POST /api/uploads?kind=playmat|sleeve`
  takes the raw image body (JPEG/PNG/WebP/GIF, 2 MB, validated by magic bytes, 12 per user),
  stores it under `DATA_DIR/uploads/<id>.<ext>` with a row in `uploads`. `GET /api/uploads/:id`
  needs the device token and serves only to the owner or someone sharing a room with them
  (`canSeeUploadsOf`), with `Cache-Control: private, immutable`; the client fetches with the
  token and shows a `blob:` URL (`look.ts`). `DELETE` removes the file and settings fall back.
- **Ambient sound** (`ambient.ts`): rain and fireplace are synthesised with the Web Audio API
  (filtered noise), so nothing is downloaded or licensed. Off by default.
- **Animations**: card arrival fade, flip on face/face-down change, tap rotation, floating life
  ticks (`useLifeTicks`). All disabled under `prefers-reduced-motion` (game.css, styles.css).
- **Game over**: overlay with winner, Rematch (host), Look at the table, Leave; non-hosts get a
  "Join the rematch" button / toast when `nextCode` arrives.
- Touch targets are 44 px (chips, life buttons, close buttons, log lines, turn buttons); the table
  hides the site header/footer via `body.in-table`; `body { overflow-x: clip }`.

## Accounts and the owner flag (Phase 5)

- **Model.** Every visitor is still a device-only profile first (name + avatar, ten seconds, no
  password). An account is the same `users` row with `email` (lower-cased, unique) and
  `password_hash` filled in; nothing moves. Tokens live in `sessions` (id, user_id, token_hash,
  device label from the User-Agent, created_at, last_seen_at), so one account can be signed in on
  several devices and each one can be signed out on its own. `req.user` and `req.session` are set
  by `requireUser`; the WebSocket uses `userFromToken`.
- **Passwords** (`server/src/password.ts`): Node's built-in `crypto.scrypt` (N=16384, r=8, p=1,
  16-byte salt, 64-byte key) in a self-describing record `scrypt$N$r$p$salt$hash`, verified with
  `timingSafeEqual`; 8-128 characters. Sign-in verifies against a dummy record when the email is
  unknown and always answers "email or password is wrong". **No email verification and no password
  reset in this phase** (no email provider): the sign-up form says so.
- **Routes:** `POST /api/auth/signup` {email, password} (needs the device token; 409 if the
  profile already has an account or the email is taken), `POST /api/auth/signin` -> {token, user}
  (new session; 20 per 15 min per IP), `POST /api/auth/password` {currentPassword, newPassword}
  (drops every other session), `GET /api/me/sessions`, `DELETE /api/me/sessions/:id` (one device),
  `DELETE /api/me/sessions` (everywhere), `POST /api/me/owner-claim` {code}. `GET /api/me` now
  returns `email` (null for device-only) and `isOwner`.
- **Collisions, kept simple:** signing in on a device that already has a device-only profile
  REPLACES that identity on the device after a confirm dialog; the orphaned profile and its decks
  stay on the server under it (reachable again only by its old token, which the client has
  discarded). The sign-in page points the visitor to "add an email and password" instead when
  that is what they want. A device-only profile cannot sign up with an email that is in use.
- **Owner flag:** `users.is_owner`, granted ONLY by `POST /api/me/owner-claim` with a code that
  matches the `OWNER_CLAIM_CODE` Fly secret (`secretsEqual`, constant time). Needs an account (not
  a device-only profile), 5 attempts per hour per client plus 30 per hour globally, every attempt
  logged at warn with user id, email, ip and result. A successful claim moves the flag (one
  owner). The owner's email (`OWNER_EMAIL`, nelson.george.edward@gmail.com) is recorded in config
  for the record only and never grants anything. `requireOwner(handle)` in `server/src/auth.ts` is
  the preHandler for owner-only routes (401 signed out, 403 otherwise); Phase 7 builds on it.
- **Migration** (0004 + 0005): 0004 creates `sessions`, adds `is_owner` and copies every
  `users.device_token_hash` into a session row labelled "Earlier device"; 0005 drops the column.
  `server/src/routes/auth.test.ts` builds a pre-Phase-5 database from migrations 0000-0003 and
  proves the old token still works.
- **Client:** `/signup` (wrapped in `RequireUser`, so a brand-new visitor does name + avatar
  first), `/signin`, and the Account section of `/me` (prompt to create an account, signed-in
  devices with Sign out, Sign out everywhere, Change password, owner code field + Owner badge).
  `useUser()` exposes `signUp`, `signIn`, `signOut` (deletes this device's session),
  `signOutEverywhere`, `refresh`.
- **Later upgrades, where they plug in:** email verification = add `users.email_verified_at` +
  a `verification_tokens` table and a mail sender behind an env flag, send on signup, and gate
  nothing until the owner decides what verification should unlock. Password reset = the same
  token table + a `/reset/:token` page. Passkeys = a `webauthn_credentials` table (user_id,
  credential_id, public_key, counter) and two route pairs (register options/verify, login
  options/verify) that end in `createSession`; `@simplewebauthn/server` is the boring choice.
  Nothing else changes because every sign-in path only ever produces a session.

## Deck analysis, brackets and the deck library (Phase 6)

### Commander Brackets: the rules we apply (official, checked 2026-10-15)

Sources: Wizards' announcements of 2025-02-11 ("Introducing Commander Brackets Beta"),
2025-04-22, 2025-10-21 and 2026-02-09 (all under
`https://magic.wizards.com/en/news/announcements/`, see `server/data/brackets/game_changers.json`
for the exact URLs). The system is still labelled beta. Summary of the deck-building rules:

| Bracket        | Game Changers | Mass land denial | Extra turns                     | Two-card infinite combos          |
| -------------- | ------------- | ---------------- | ------------------------------- | --------------------------------- |
| 1 Exhibition   | none          | none             | none                            | none                              |
| 2 Core         | none          | none             | few, not chained or looped      | none                              |
| 3 Upgraded     | up to three   | none             | few, not chained or looped      | none that are early-game (~T6)    |
| 4 Optimized    | any           | allowed          | allowed                         | allowed                           |
| 5 cEDH         | any           | allowed          | allowed                         | allowed; built for the cEDH meta  |

- Turn expectations (added 2025-10-21): at least nine turns before anyone wins (B1), eight (B2),
  six (B3), four (B4); B5 games "could end on any turn".
- Tutor limits were REMOVED on 2025-10-21 ("rely on Game Changers to catch the most efficient
  tutors"); Bracket 2 was decoupled from precons at the same time. Precons are still a fine
  Bracket 2 default, which is what the importer uses.
- Mass land denial, official definition: cards that "destroy, exile, and bounce other lands, keep
  lands tapped, or change what mana is produced by four or more lands per player without
  replacing them" (Armageddon, Ruination, Sunder, Winter Orb, Blood Moon). Strip Mine is not.
- Game Changers: 53 cards as of 2026-02-09 (Farewell and Biorhythm added; ten removed on
  2025-10-21 incl. Food Chain, Expropriate, Kinnan, Urza, Winota, Yuriko, Deflecting Swat).
  `server/data/brackets/game_changers.json` is the list, dated, with `source` + `history`; edit it
  by hand when Wizards changes it (names must match Scryfall front-face names). The file ships
  inside the image (`Dockerfile` copies `server/data`); `.gitignore` un-ignores `server/data/`.
- Intent beats card counts: the engine reports a **floor** (what the written rules allow) and a
  **suggestion** (a heuristic), and always says that 3 vs 4 is a judgment call.

### Engine (`server/src/analysis/`, pure, no model spend)

`analyzeDeck(cards, {gameChangers, combos})` -> `DeckAnalysis` (shared `analysis.ts`).
`AnalysisCard` = name, type line, oracle text, mana cost, cmc, keywords, colour identity,
quantity, board (main | commander). `text()` lower-cases, replaces the card's own name with `~`
and strips reminder text in parentheses. Detectors, all regex over Scryfall wording, each
unit-tested in `analysis.test.ts` with real Oracle text (`fixtures.ts`):

- `gameChangers.ts`: name / front-face match against the JSON list (cached by mtime).
- `landDenial.ts`: "destroy|exile|return|sacrifice all ... lands", "all permanents" (not
  "nonland permanents"), "each player sacrifices four+ lands", Cataclysm, "lands don't untap",
  "can't untap more than one land/permanent", "players skip their untap steps", "nonbasic lands are
  Mountains", Contamination-style "produces {B} instead". Not caught: Price of Progress-style
  punishment, single-target land destruction (by design), Stasis-like cards with unusual wording.
- `extraTurns.ts`: "take(s) an/two extra turn(s)" (Time Warp's "target player takes" counts;
  "target opponent takes" does not). Chaining = three or more extra-turn cards, or a self-returning
  one (Nexus of Fate, Beacon of Tomorrows), or any extra turn plus spell recursion / copying
  (Regrowth, Past in Flames, Snapcaster, Mizzix's Mastery, Twincast). It cannot know whether the
  pilot intends to chain; the reason text says why it flagged.
- `tutors.ts`: "search your library for a/an/up to N ... card"; land-only searches are ramp, not
  tutors; "cards named X" (Squadron Hawk) is ignored; kinds any | creature | artifact |
  enchantment | instant_sorcery | planeswalker | other. Transmute counts as "any". Not caught:
  "reveal cards from the top until" (Demonic Consultation is a combo piece, not a tutor here),
  Birthing Pod-style sacrifice chains beyond their search clause.
- `fastMana.ts`: curated names (Sol Ring, Mana Crypt, Vault, Monoliths, Moxen, Petal, Jeweled
  Lotus, LED, Ancient Tomb, City of Traitors, Cradle, Workshop, Sanctum, rituals, Jeska's Will,
  spirit guides, Dockside) + heuristics (0-cost artifact that adds mana, 1-2 mana instant/sorcery
  adding 3+ mana, "exile ~ from your hand: add"). Signets, Talismans and dorks are ramp, not fast
  mana. Also `detectFreeInteraction` (pitch spells, "if you control a commander" spells),
  `countRamp`, `countInteraction`, `countCardDraw` for the stats line.
- `combos.ts`: classifies Commander Spellbook variants: `twoCard` = at most two pieces (cards +
  template requirements) AND a game-ending/infinite/lock feature; `early` = twoCard and
  `manaValueNeeded <= 6` (our proxy for "the first six or so turns"). Value engines with two cards
  (draw a card) are listed but not treated as two-card infinites.
- `archetypes.ts`: 24 tags (`ARCHETYPE_TAGS`), weighted regex signals + density signals (25+
  instants/sorceries -> spellslinger, 25+ artifacts, 20+ enchantments, 42+ lands, creature count +
  curve -> aggro, 7+ seven-drops -> big mana, Spellbook combo count -> combo, most common creature
  subtype with 10+ members -> tribal). Commanders count double. confidence = score / threshold,
  shown with evidence cards; tags under 35% are dropped, at most six returned.
- `bracket.ts`: floor = max over reasons (GC 1-3 -> 3, GC 4+ -> 4, MLD -> 4, extra turn -> 2,
  chaining -> 4, two-card combo -> 3, early two-card combo -> 4). Suggested = max(floor, score
  band) where the power score sums signal weights (fast mana, tutors, free interaction, low curve,
  Game Changers, combo density, extra turns, stax): >= 7 -> 3, >= 14 -> 4; never 5 (self-declared),
  never below 2 (Bracket 1 is for showcase decks). `judgmentNote` always carries the "3 vs 4"
  sentence when either is suggested.
- `summary.ts` (one paragraph), `primer.ts` (`primerSkeleton`: Markdown with fixed headings
  Archetype, Game plan, Win conditions, Key synergies, Game Changers, Combos, Early turns,
  Weaknesses, Agent notes; "(fill in ...)" placeholders).
- `spellbook.ts` + `service.ts`: `SpellbookClient.findCombos` POSTs `{commanders, main}` (card
  names + quantities) to `https://backend.commanderspellbook.com/find-my-combos`, one request per
  distinct list, named User-Agent, 1.5 s minimum spacing, 20 s timeout, 429 -> back off for
  Retry-After; the answer (slimmed, no image URLs) is cached in `combo_cache` keyed by the SHA-256
  of the sorted names (14 days). When Spellbook fails the analysis still returns with
  `combosStatus: "unavailable"` (or a stale cached answer). Their API notes (verified 2026-10-15 in
  the OpenAPI document's info text) ask for sparse unauthenticated requests, a named User-Agent,
  ~80 requests/minute at most, handling 429s, and credit with a link back: the panel says "Combos
  by Commander Spellbook" and links each combo to its page. Never use the API for bulk export;
  `https://json.commanderspellbook.com/variants.json.gz` exists if a local copy is ever wanted.
  `DeckAnalyzer.analyze(cards, {combos: "cached" | "refresh" | "skip"})`.

### Routes and UI

- `GET /api/decks/:id/analysis[?refresh=1]` (signed in, own deck, 30/min) ->
  `{analysis, combosCached}`. Recomputed on every call (the engine is milliseconds); only the
  Spellbook answer is cached. The deck page's **Bracket** panel (`client/src/components/
  BracketPanel.tsx`) shows floor + suggested badges, the summary, the judgment note, the reasons,
  strategy chips (hover = evidence), combos with Spellbook links, a Details toggle (Game Changers
  with the list date, tutors by kind, fast mana, extra turns, MLD, power signals, stats) and a
  Recompute button; it re-runs whenever the deck's `updatedAt` or card count changes.

### Deck library (owner only; Phase 7 reads it)

- Tables (migration 0006): `library_decks` (name, source precon|user, source_key unique =
  `mtgjson:<fileName>` or `deck:<deckId>`, set_code, set_name, release_date, commanders JSON,
  bracket (owner's call, precons default 2, user decks default to the suggestion), bracket_floor,
  bracket_suggested, tags JSON, primer text, agent_eligible, analysis JSON, created_by, timestamps),
  `library_deck_cards` (printing id, quantity, board main|commander|sideboard, position),
  `combo_cache`.
- Routes (`server/src/routes/library.ts`, preHandler `[requireUser, requireOwner]`):
  `GET /api/library?bracket=&tag=&q=&source=&agent=` -> `{decks, importState}`,
  `POST /api/library/import-precons {force?, combos?}` (202, background),
  `GET /api/library/import-status`, `POST /api/library/from-deck/:deckId` (409 if already added),
  `GET/PATCH/DELETE /api/library/:id` (PATCH: name, bracket, tags, primer, agentEligible),
  `POST /api/library/:id/analyze` (re-run engine + Spellbook, keeps the owner's edits),
  `GET /api/library/:id/primer-skeleton`. `POST /api/admin/import-precons` + `GET /api/admin/import-status`
  are the same import for the machine itself (loopback) or `ADMIN_TOKEN`, like `/api/admin/ingest`;
  `node server/dist/cli.js import-precons [--force] [--no-combos]` drives them and prints progress
  (what the owner runs through `fly ssh console` after a deploy).
- Precon import (`server/src/library/precons.ts`): MTGJSON (MIT licence, data courtesy of
  MTGJSON; verified 2026-10-15) `https://mtgjson.com/api/v5/DeckList.json` lists every product
  deck (3113 rows; 197 with `type: "Commander Deck"`); each deck is
  `https://mtgjson.com/api/v5/decks/<fileName>.json` with `commander[]`, `mainBoard[]`,
  `sideBoard[]`, each card carrying `count` and `identifiers.scryfallId`. Cards resolve by
  Scryfall id first (our `cards.id`), then exact name through `NameIndex`; a deck with more than
  10% unresolved cards is reported, not imported. 250 ms between MTGJSON requests; Spellbook is
  asked per deck through the cache (so a full run is ~200 Spellbook calls spaced 1.5 s = about
  five minutes). Idempotent by fileName; `force` only re-checks, it never duplicates. State
  (`LibraryImportState`: phase list|decks|done|error, total/done/imported/skipped, errors[]) is
  in-memory like the Scryfall ingest.
- Client: `/admin/library` (filters by bracket, archetype, source, agent-eligible, text search;
  "Import precons" with a progress bar polled every 2 s; problems list) and `/admin/library/:id`
  (name, bracket select, agent-eligible toggle, tag chips, primer textarea with "Fill in a
  skeleton", Save, Re-analyse, Remove, the engine analysis, the card list). Deck pages show
  "Add to library" for the owner (`isOwner(user)` in `client/src/user.tsx`; the server enforces).
- **Phase 7 hook:** a model may draft the primer; keep `PRIMER_SECTIONS` headings (the agent will
  read them by name), write the draft into `library_decks.primer` through the same PATCH, and add
  the model call behind an owner-only route. Agent opponents should pick from
  `library.list({agentEligible: true})`.

## Computer opponents (Phase 7, owner only)

"Agents" are Claude-driven seats. Everything lives in `server/src/agents/`; nothing here runs unless
`AGENTS_ENABLED=1` (a Fly secret; off = every agent route answers 404 and the lobby control is hidden),
except on rules-engine tables, where the same box seats Forge-AI bots with no model involved (see
"Rules engine tables").
`ANTHROPIC_API_KEY` must be a workspace-scoped key, or set `ANTHROPIC_WORKSPACE_ID` (wrkspc_...) as well:
an organisation-level key without it is rejected with "must include the anthropic-workspace-id header"
(found on the first prod smoke run, 2026-10-16). Model errors show in the Agent reasoning drawer.

### Non-negotiables, enforced in code

- **Agents are ordinary seats.** An agent is a `users` row with `is_agent = 1` (no sessions, no
  sign-in) and a `decks` copy of a library deck (`decks.source_url = library:<id>`), seated in the
  lobby like anyone else. `AgentRunner` subscribes to `LiveRoom.onState` (the true state), builds its
  OWN view with `viewFor(state, me)` - the same filter a human client gets - and acts only through
  `room.submit(me, event)`, the same validation + reducer path as a WebSocket client. The prompt
  builder (`prompt.ts`) takes a `PlayerView` + printings and nothing else; `prompt.test.ts` proves
  that other hands and every library never appear in the text (own hand does).
- **Owner only.** All of `routes/agents.ts` runs behind `[requireUser, requireOwner]` plus the flag;
  the lobby control, the reasoning drawer, `/admin/agents` and "Draft with Claude" are hidden for
  non-owners and refused server-side.
- **Spend control.** `AGENT_MAX_USD_PER_GAME` (default 6) and `AGENT_MAX_USD_PER_DAY` (default 25)
  are checked before every model call (`AgentManager.mayCall`) from the usage the API returned
  (`pricing.ts`: $2 / $10 per MTok on Sonnet, cache write 1.25x, cache read 0.1x); when a cap is hit
  the agent posts "stops playing: <reason>" in the log and concedes, the run is marked `capped`.
  `AGENT_MAX_TOKENS_PER_DECISION` (1500), `AGENT_DECISION_TIMEOUT_MS` (60 s) and
  `AGENT_MAX_CALLS_PER_TURN` (8) bound each decision and turn. Primer drafts count toward the daily
  cap through `meta.agent_draft_spend:<date>`.

### Runtime (`server/src/agents/`)

- `manager.ts` (`AgentManager`): `addAgents(room, host, {count, bracket})` removes existing agents,
  takes `library.list({agentEligible: true, bracket})` (falls back to any eligible deck), shuffles,
  then greedily picks decks sharing the fewest archetype tags with the host's deck (analysed with
  combos skipped) and with each other; creates the bot user ("Krenko bot", random avatar), the deck
  copy, joins + seats it on the next free seat. `onGameStarted(room)` / `ensureRunning(room)` start
  one runner per seated agent (also called on every WebSocket attach, so a game resumes after the
  machine restarts); `agent_runs` rows track mode (`live` | `dry_run`), status and totals.
  `record()` writes `agent_decisions` (tokens, cost, latency, outcome, rationale, tool calls).
- `runner.ts` (`AgentRunner`): per state change it decides whether to act. Mulligans are a RULE,
  not a model call (keep with 2-5 lands in seven, one mulligan at most; bottoms the priciest
  spells). On its turn it jumps to `main1` (the reducer untapped and draws for it), then loops: one
  model call -> execute every `tool_use` in order (`tools.ts` `mapToolCall` validates against the
  view, `room.submit` validates with the reducer; errors go back as `tool_result is_error`) ->
  feed results + a compact re-render -> until `pass_turn`, `concede`, the call limit (then it
  passes with a note), three invalid calls in a row, a timeout, an API error or a refusal (all pass
  the turn with a log note). On an opponent's turn it only acts when the table lists pending
  triggers on ITS permanents (one call, then dismisses what is left). The runner never blocks for
  other players and never looks at `state.cards` directly.
- `tools.ts`: the vocabulary, one tool per event: play_land, cast_permanent, cast_spell (reveals,
  moves to graveyard), tap_cards, move_card, attach, change_counters, change_life, player_counter,
  commander_damage, create_token (custom tokens), draw_cards, shuffle_library, search_library
  (result lists the library), adjust_mana, set_step (main1 | combat | main2 | end), attack (one
  `AttackersDeclared` against a player; the reducer taps, logs and later applies damage), resolve_trigger,
  dismiss_triggers, flip_card, untap_all, say (`NoteAdded`), pass_turn, concede. Player references
  accept "me" or a display name. **Adding an action:** add the event to shared types + reducer,
  a tool definition and a `case` in `mapToolCall`, a line in `server/data/agents/rules-primer.md`
  telling the model when to use it, and a case in `tools.test.ts`.
- `prompt.ts`: `systemPrompt` = behaviour line + rules primer + effects primer + deck primer (cache
  breakpoint, identical for every decision of a game); `renderState` = players (life, counters,
  commander damage, hand/library counts, command zone, battlefield by section with ids, graveyard
  tail), own hand with full oracle text, known library cards, mana pool, pending triggers, log
  tail; `renderDelta` is the shorter re-render between tool batches.
- `llm.ts`: `AnthropicLlm` (`@anthropic-ai/sdk`, `messages.create`, `claude-sonnet-5-5` by default
  via `AGENT_MODEL`, `output_config.effort: "low"` with the model's adaptive thinking, no forced
  tool choice - Sonnet 5.5 rejects it - system block with `cache_control`); `ScriptedLlm` for tests.
  Refusals (`stop_reason: "refusal"`) are recorded with their category and pass the turn.
- `policy.ts`: the dry run (no `ANTHROPIC_API_KEY`): land, cheapest affordable permanent, attack
  with last turn's creatures when the defender has no untapped creatures or we outpower them 3:1,
  pass. Also the mulligan rules.
- `server/data/agents/rules-primer.md` + `effects-primer.md`: what the model is told about this
  table (stack-less, humans enforce rules, tool semantics, combat as tracked here). Edit freely;
  loaded once per process.
- `NoteAdded` event (shared): `{player, text}` -> log line "Name: text" (200 chars). Humans may use
  it later as chat.

### Routes and UI

- `GET /api/agents/status`, `GET /api/agents/games`, `POST /api/rooms/:code/agents {count,
  bracket}` (host + owner, lobby only; returns the picks), `DELETE /api/rooms/:code/agents`,
  `GET /api/rooms/:code/agents` (runs + last 60 decisions + spend), `POST /api/library/:id/draft-primer
  {force?}` (Claude fills the Phase 6 skeleton; cached per deck via `library_decks.primer_drafted_at`
  / `primer_model`, `force` redrafts).
- Lobby: "Computer opponents" box for the owner-host (bracket, how many, Add / Re-roll / Remove,
  the picks with tags). `RoomMember.isAgent` / `.thinking` (from `LiveRoom.setAgentPresence`) drive
  the BOT chip, the pulsing "…" while a decision is in flight, and "online" for agents.
  Table menu -> "Agent reasoning" (owner): runs, rationale per decision, tool calls with errors,
  cost and latency, polled every 4 s. `/admin/agents`: flags, caps, today's spend, recent games.
- Tables (migration 0007): `users.is_agent`, `library_decks.primer_drafted_at` + `primer_model`,
  `agent_runs`, `agent_decisions`.

### Cost expectations (Sonnet 5.5, effort low)

A decision sends the cached system prompt (~6-8k tokens, read at $0.20/MTok after the first call)
plus 2-4k uncached tokens of state and returns a few hundred tokens: roughly $0.01-0.02 per call. A
turn is one to four calls; a three-agent, ten-turn game lands around $1-3, inside the $6 cap.
Measured numbers from real games are in the Phase 7 hand-over note.

### What agents do badly (known)

- They never declare blockers, so every attack on an agent is unblocked; the table applies the
  damage when the attacker moves past combat (see "Table hygiene"). They cannot respond on the stack.
- They apply spell effects by hand with the bookkeeping tools, so complicated cards are often
  under-applied; the primer tells them to say what they are doing.
- Summoning sickness and mana are not enforced by the table; the primer and the dry run respect
  them, the model usually does. Humans should undo (log -> revert) anything illegal.

### Testing alone

`node scripts/seed-field.mjs <base-url> <code> <token> "Lotus Cobra" "Rancor" ...` pulls named
cards from that player's library straight onto their battlefield (for testing bookkeeping).
`node scripts/bots.mjs http://localhost:8080` registers "Georgie" + three bots with small decks,
creates a room, seats the bots and prints a device token: put it in localStorage as `cgwf.token`
and open `/room/<code>` to play seat 1. Bots keep, play a land and pass on their turns; press
Enter in that terminal to force-drop and rejoin Blair (reconnect drill). Works against
https://cgwf.fly.dev too. The Vite proxy needs `ws: true` for `/api` (already set).

## Onboarding and social (Phase 8)

No model spend anywhere in this phase. Tables (migration 0008): `users.friend_code`, `friendships`
(two rows per friendship, one per direction), `friend_requests`, `room_invites`, `notifications`,
`library_submissions`. Server code under `server/src/social/`; routes in `server/src/routes/social.ts`;
tests in `server/src/routes/social.test.ts` and `shared/src/onboarding.test.ts`.

- **Welcome screen.** `/` renders `Landing` (`client/src/pages/WelcomePage.tsx`): signed-out visitors
  get the welcome page (what CGwF is, how a game works, Fan Content notice, "Start playing" ->
  `/start` = the name + avatar form, "I have an account" -> `/signin`); a stored token that turns out
  dead also lands there. The decision is the pure `landingFor()` in `shared/src/onboarding.ts`.
  `RequireUser` still shows the inline profile form on deep links (a shared room link keeps working).
- **Tour.** `register()` sets `localStorage cgwf.tour = "pending"`; `Tour.tsx` on the decks page shows
  three steps (`TOUR_STEPS`: import / join or host / personalize); Skip, Done or any step's button
  writes "done" and it never returns on that device. Per device, like the token.
- **Sign-up** (`SignUpForm` in `AccountPages.tsx`): email, password, confirm, a "why" box, step
  ticks; a 409 "already in use" shows a notice with "Sign in instead" / "Use a different email"
  rather than an error line. The profile page's account box links here. **Password reset is not
  built**: it needs an email provider (see Phase 5 "Later upgrades"); the form says to keep the
  password safe.
- **Friend codes** (`social/codes.ts`): six characters from the join-code alphabet, assigned lazily
  the first time `/api/friends` or `/api/me/friend-code` is called (no backfill), unique index on
  `users.friend_code`. Shown on `/me` and `/friends`.
- **Friends** (`SocialService`): `POST /api/friends/requests {code}` sends a request (a crossed
  request the other way is accepted instead); accept / decline / cancel; `DELETE /api/friends/:userId`
  removes both rows. `GET /api/friends` -> own code, friends with `online` and `table`, incoming and
  outgoing requests. Agents (`users.is_agent`) can neither send nor receive. 200 friends max.
- **Presence** (`social/presence.ts`): an in-memory last-seen map touched by `sessionFromToken` on
  every authenticated request (REST and the WebSocket handshake); online = heard from within
  `PRESENCE_ONLINE_MS` (2 min). The bell's 30 s poll is the heartbeat. "At a table" comes from
  `RoomManager.tablesOf()`, which scans live rooms' open sockets (lobby or playing only). Nothing is
  persisted; a restart just means everyone is offline until their next request.
- **Invites.** `POST /api/rooms/:code/invites {userIds}` by any member of a room that has not ended,
  friends only, one row per (room, invitee) (re-sending a pending invite is a no-op; a declined one is
  replaced). The invitee gets a `room_invite` notification; `POST /api/invites/:id/accept` joins the
  room and, in the lobby, seats them on the first free seat with no deck (they pick one there), then
  returns the code; the client navigates to `/room/:code`. Invites **expire with the room**: nothing
  is swept, `status` is computed as "expired" when `rooms.status = ended`, and `notificationsFor`
  reports a dead invite as read with `payload.live = false` so the badge never sticks. The share link
  is unchanged.
- **Notifications** (the bell, `client/src/components/Bell.tsx`): `NotificationsProvider` polls
  `GET /api/notifications` every 30 s while signed in and the tab is visible, and on tab wake. Kinds:
  `friend_request` (Accept / Decline inline), `friend_accepted`, `room_invite` (Join / No thanks),
  `submission_reviewed`. Closing the panel marks everything read (`POST /api/notifications/read`);
  answering a request or invite marks its own notification read server-side (`markKind`). Not pushed.
  **Browser push later:** add a `push_subscriptions` table (user_id, endpoint, p256dh, auth), a
  `POST /api/me/push` route that stores `PushManager.subscribe()` output, VAPID keys as Fly secrets
  (`web-push` is the boring library), and call `webpush.sendNotification` from `SocialService.notify`
  behind an env flag; the service worker (vite-plugin-pwa `injectManifest` instead of `generateSW`)
  handles `push` and `notificationclick`. Safari on iOS needs the app installed to the home screen.
- **Agent deck queue** (`social/submissions.ts`): `POST /api/decks/:id/submit {note?}` freezes the
  deck's main / commander / sideboard rows into `library_submissions.cards` (later edits do not
  change what is reviewed); one pending submission per deck, an approved deck cannot be re-queued,
  `SUBMISSIONS_PER_DAY` (3) per player, note 500 chars; `DELETE /api/submissions/:id` withdraws while
  pending. Owner (`[requireUser, requireOwner]`): `GET /api/library/submissions` (pending first, with
  the engine's suggested bracket and tags computed on the fly via `DeckAnalyzer.analyzeSync`, no
  Spellbook request), `POST .../:id/approve` -> `LibraryService.create` from the frozen list
  (`source: "user"`, `sourceKey: deck:<deckId>`, `createdBy` = submitter, name suffixed with the
  submitter's name) + `agentEligible: true`, `POST .../:id/reject {reason}` (reason required, 300
  chars). Both notify the submitter. `LibraryDeckSummary.createdBy/createdByName` credit the player
  in the library list. UI: the deck page's "Agent deck queue" panel (submit with a note, status,
  withdraw, the owner's reason), the queue box at the top of `/admin/library`.
- Client routes added: `/welcome`, `/start`, `/friends`. Header: Friends link + bell for signed-in
  players; "Start" instead of "Sign in" for visitors. `pages.css` had an unclosed
  `@media (max-width: 600px)` block since Phase 6 that swallowed every later rule on wide screens;
  fixed here.

## Deck statistics (Phase 9)

The **Stats** panel sits beside **Bracket** on every deck page and library deck page
(`client/src/components/StatsPanel.tsx`, `client/src/stats.css`; `.analysis-row` puts the two side
by side from 900 px). Everything is computed by `server/src/analysis/stats.ts` (`computeStats`,
pure, no model, no network) over the deck's main + commander cards; shapes in `shared/src/stats.ts`.
Routes: `GET /api/decks/:id/stats` (own deck, 60/min) and `GET /api/library/:id/stats` (owner) ->
`{stats, cached}`. `StatsCache` (`server/src/routes/stats.ts`) keeps up to 300 results in memory
keyed by deck id + `updatedAt` (every card change bumps it), so a repeat view is a map lookup; no
table was added (Phase 8 owned migrations). Tests: `server/src/analysis/stats.test.ts` (a 29-card
hand-checked fixture deck, every number worked out by hand in the comments) and
`server/src/routes/stats.test.ts` (real card rows, cache, ownership, library).

**AnalysisCard** gained `colors`, `power`, `toughness` (front face for two-faced cards); the
fixture helper `card()` defaults `colors` to the colours in the mana cost.

What each statistic means. "Exact" = counted from card data; "heuristic" = regex over Oracle text
(reminder text stripped, own name = `~`), which can miss unusual wordings; every heuristic result
lists the card names it matched (tap the row), so the reader can disagree.

- **Mana value** (exact): parsed from the FRONT half of the mana cost (`frontCost`, so Fire // Ice is
  2 and an MDFC is its front), numbers add, X/Y/Z are 0, {2/W} is 2, every other symbol is 1; a card
  with no cost uses Scryfall's `cmc` (0 for lands and suspend-only cards). Not Scryfall's `cmc` for
  split cards (which sums both halves).
- **Mana curve** (exact): buckets 0..6 and 7+ of nonland cards; the toggle adds lands (always
  bucket 0). Totals: sum over all cards, mean over nonland cards, mean over every card.
- **Pips** (exact by definition): per colour from the front cost. Hybrid `{G/W}` adds 0.5 to each
  colour; `{2/W}` and Phyrexian `{W/P}` count one pip of the colour; `{C}` is its own column; `{S}`
  is generic; X counts 0 and the card is listed as an X spell. Generic is shown apart.
- **Mana sources** (heuristic, `manaSource`): permanents only (instants/sorceries such as rituals
  and one-shot Treasure makers are not sources). Lands produce by basic land type in the type line
  ("Land — Forest Island" -> G, U) and by "Add {G}" / "Add {G} or {W}" / "Add {C}" text; fetch lands
  by what they search for ("Forest or Island card" -> G, U; "a basic land card" -> any). Rocks
  (artifacts), dorks (creatures) and other permanents by "Add ..." text. "Add one mana of any
  color", "any one color", "in any combination of colors", "of the chosen color", Command Tower's
  "any color in your commander's color identity" -> `any`, which counts toward every colour of the
  deck's identity (commander colour identity; without a commander, the colours of the nonland
  cards). Lands keep their reminder text (a basic's only text is reminder text); other cards drop it
  so Treasure reminders do not count. Each card counts once per colour it can make, times quantity.
  Known misses: "adds an additional {G}" (Wild Growth), Exotic Orchard / Reflecting Pool count as
  any-colour even when the table would not allow it, Lotus Cobra's landfall counts as a dork,
  Treasure and other token producers are ignored, conditional producers are taken at face value.
- **Sources vs pips**: per colour, pips in costs against cards that make the colour, the ratio, the
  colour's share of coloured pips vs its share of colour-producing source slots, and a one-line
  note ("Light on green" when the source share trails the pip share by more than 8 points; "no way
  to make red mana"; "outside the commander's colour identity"). The guideline text credits Frank
  Karsten's 2022 colour-source article (link in `KARSTEN` in stats.ts) as a rule of thumb, never a
  rule; the exact per-turn source counts are left to his tables.
- **Breakdowns**: card types (exact, front face, a card counts once in each of its types, so an
  Artifact Creature is both); colours of nonland cards from Scryfall `colors` (a multicolour card
  counts in each colour; multicolour and colourless totals shown); lands basic/nonbasic (exact, by
  "Basic" in the type line); creature count with mean printed P/T over numeric P/T only ("*",
  "1+*" are reported as left out); X spells (exact); token makers (heuristic: "create(s) a/two/X/that
  many ... token(s)", excluding "would create" and "creates twice that many" doublers).
- **Functional counts** (`server/src/analysis/functional.ts`, heuristic; Phase 6's `countRamp` /
  `countCardDraw` / `countInteraction` now wrap the same finders so the bracket summary agrees):
  ramp (rocks/dorks of MV <= 3 that add mana incl. fast mana, land searches, "put a land card onto
  the battlefield", extra land drops), card draw/advantage ("draw a card/two cards/X cards" unless
  an opponent or each player draws, impulse draw "exile the top card ... you may play", investigate),
  targeted removal (destroy/exile target X incl. "noncreature permanent", damage to any target /
  target creature, bounce an opponent's permanent, -N/-N, edicts, fights, "exile ... until"), board
  wipes (destroy/exile all/each X, damage to each creature, each player sacrifices all, all creatures
  get -X/-X, bounce all, Cataclysm-style "chooses ... sacrifices the rest"; "destroy all lands" alone
  is land denial, not a wipe), counterspells ("counter target spell / ability / spell that targets"),
  tutors (Phase 6 `detectTutors`: land searches excluded, "cards named X" excluded), recursion
  (return/put ... from a graveyard to hand / battlefield / top of library, "return ~ from your
  graveyard", cast from graveyard, play lands from graveyard, unearth/escape/embalm/eternalize),
  protection (grant hexproof / indestructible / shroud / protection to targets or your permanents,
  regenerate, phase out, "counter target spell that targets", fogs, blink-to-save, bounce your own
  creature). A card can sit in several lists (Beast Within is removal and a token maker). Known
  misses: planeswalker loyalty text is matched like any other text (usually right), "Fire deals 2
  damage divided among one or two targets" is not removal, self-only protection ("~ has hexproof")
  is deliberately not counted, cantrips on permanents ("when ~ enters, draw a card") ARE counted as
  draw.

Charts follow the `dataviz` skill as far as the game's own colours allow: horizontal CSS bars
(16 px, rounded data end, square baseline, 2 px surface gaps), one series per chart in the accent
colour, mana colours only where the bar IS a colour, each bar labelled with its letter and count,
fixed WUBRG order, a text alternative (sr-only names + visible values) and `<details>` sections.
The mana palette fails the generic colour-blind validator by design (white, black and grey are
near-neutral, red/green are the game's colours); the letter on every mark is the secondary
encoding. `--mana-W/U/B/R/G/C` in `styles.css` match the mana-dot hues, with white and black
nudged per theme so bars stay visible on the panel surface. Bar width animates only under
`prefers-reduced-motion: no-preference`.

## Admin overview (owner only)

`/admin` (nav link only for the owner; others see "Owner only") shows who is on the platform and
who is using it. `GET /api/admin/stats?sort=lastSeen|created|decks|games&q=&limit=&refresh=1`
and `GET /api/admin/users/:id` sit behind `[requireUser, requireOwner]` (401 signed out, 403
otherwise) in `server/src/routes/admin.ts`; shapes in `shared/src/admin.ts`; page in
`client/src/pages/AdminPage.tsx` + `client/src/admin.css`; tests in `routes/admin.test.ts`.
Everything is computed on request from existing tables (no migration) into a 60 s in-memory
snapshot; `online` and "online now" are re-evaluated per request. Users with `is_agent = 1` are
excluded from every people count. No game state is read: nothing here can leak hidden cards.

What each number means and where it comes from:

- **Players**: `users` rows (agents excluded); "with email" = `email` set, "device only" = null;
  owners = `is_owner`.
- **Last seen / active 24 h, 7 d, 30 d**: the later of `users.last_seen_at` and the newest
  `sessions.last_seen_at` (bumped at most hourly by `sessionFromToken`).
- **Online now**: connected to a live table (`RoomManager.tablesOf`), or heard from in the last
  5 minutes (`Presence.seenWithin`, `ADMIN_ONLINE_MS`), or last seen within 5 minutes.
- **Decks** = `decks`; **in the library** = `library_decks`; **submissions** = `library_submissions`
  by status.
- **Tables created** = `rooms.created_at` in the window; **games started** = `room_events` rows of
  type `GameStarted` (`ts`) in the window.
- **Agent games / spend** = distinct `agent_runs.room_id` and `sum(cost_usd)` for runs with
  `started_at` in the last 30 days.
- **Sign-ups per week** = `users.created_at` by Monday-based UTC week, 12 weeks ending now.
  **Active players per week** = players with any stored timestamp in that week (created, last seen,
  session created/seen, deck created/updated, table created, submission created, a `room_events`
  row they authored). It is a lower bound: last-seen columns only keep the latest visit.
- **Per player**: devices = `sessions` rows; decks; submissions by status; games played = distinct
  rooms where they hold `room_members.role = 'player'` and the room has a `GameStarted` event;
  games hosted = such rooms with `rooms.host_user_id` = them (the host role moves when the host
  leaves); friends = `friendships` rows from them. Expanding a row loads that player's decks (with
  the library bracket when `library_decks.source_key = deck:<id>` exists) and submission history.
- Filter `q` matches the display name or email (case-insensitive); `limit` defaults to 100, max 500;
  the CSV is built client-side from the rows shown.

## Local stores bridge (Phase 10)

CGwF can show which **Las Vegas stores have a card in stock** (from the owner's Singles site,
vegas-mtg) and Scryfall's **marketplace links** for a printing. The rule that governs all of it:
**CGwF only links out and never sells anything.** No prices are charged here, no cart, no
affiliate programme of our own; every link leaves the app for the store's own site (or Scryfall's
TCGplayer / Cardmarket / Cardhoarder links, which Scryfall provides in its bulk data). The UI must
say where the data came from ("from local store data, updated X ago") and that stock is a
snapshot to confirm with the store.

- **Purchase links** (migration 0009, `cards.purchase_uris` JSON): `pickPurchaseUris` in
  `scryfall/map.ts` keeps only `tcgplayer`, `cardmarket`, `cardhoarder` and only https URLs;
  `rowToPrinting` / `rowToSummary` expose them as `purchaseUris: {tcgplayer, cardmarket,
  cardhoarder}` (each nullable; the field itself is optional on `CardPrinting` / `CardSummary`
  so existing literals compile). Existing rows get links on the next ingest; after the Phase 10
  deploy run `node server/dist/cli.js ingest --force` through `fly ssh console` once.
- **The Singles site's service API** (vegas-mtg `README.md` "Service API"): `POST
  /api/v1/availability {oracleIds[]}` (max 400) and `GET /api/v1/stores`, header
  `x-service-token`, read-only, keyed by Scryfall oracle id. Shapes mirrored in
  `shared/src/singles.ts` (`SinglesListing`, `SinglesStore`, `SinglesAvailabilityResponse`,
  `SinglesStoresResponse`).
- **Secrets**: `SINGLES_API_URL` (`https://vegas-mtg.fly.dev`) and `SINGLES_API_TOKEN` (the same
  value as `SERVICE_API_TOKEN` on the vegas-mtg app; kept only in
  `C:\Openclaw\cgwf-secrets\singles-service-token.txt`, never in a repo). Both unset = the bridge
  answers `status: "unconfigured"` and never calls out. `SINGLES_TIMEOUT_MS` (4000) bounds a call.
- **Client** (`server/src/singles/client.ts`, `SinglesClient`): hard timeout; **15-minute
  in-memory cache keyed by the sorted set of oracle ids** (a deck page is one key, a card page
  another; up to 1000 entries); concurrent callers for the same key share one request; id sets
  over 400 are chunked. **Circuit breaker**: three consecutive failures (timeout, network, 401/403,
  429, 5xx, bad JSON) open it for 60 s, during which every call answers `unavailable` at once
  with no request; after the cooldown one probe goes through (half-open) and a success closes it.
  While open or on a failed call, a cached answer up to 6x the TTL old is served instead, marked
  `stale`. `ctx.singles.status()` reports breaker state, cache size and counters. Nothing is
  written to the database and nothing is retried in a loop: a Singles outage costs CGwF at most
  one 4 s wait per key before the breaker opens.
- **Routes** (`server/src/routes/singles.ts`, all `requireUser`, read-only, per-user rate
  limits): `GET /api/cards/:id/availability` (60/min; the printing's oracle id -> every store that
  stocks any printing of the card, grouped by store, cheapest store first, listings cheapest
  first, plus `purchaseLinks`), `GET /api/decks/:id/shopping` (own deck, 30/min) and
  `GET /api/library/:id/shopping` (owner): main + commander entries -> per card the cheapest
  local listing anywhere and which store, every store's coverage (`cardsCovered`, `total` =
  sum of that store's cheapest price x quantity, `missing` names) sorted most coverage then
  cheapest, `bestStore`, and a summary with `cheapestAnywhereTotal` and the missing names;
  `GET /api/stores` (30/min) passes the store list through. Every answer carries
  `source: "local stores"`, `status` ok | unavailable | unconfigured (+ `reason`), `dataAsOf`
  (the Singles site's newest scrape), `fetchedAt` and `cached`. Stock counts are not enforced in
  totals (a store may list fewer copies than a deck needs); listings carry `quantity` for the UI.
  Aggregation is the pure `server/src/singles/shopping.ts`.
- **Tests**: `scryfall/map.test.ts` (link filtering), `singles/client.test.ts` (success, 401,
  timeout, breaker open / probe / recover, stale fallback, dedupe, chunking),
  `singles/shopping.test.ts` (hand-worked fixture deck), `routes/singles.test.ts` (routes against
  the fixture deck with a fake Singles site, including an outage and an unconfigured server).
- **UI** (`client/src/components/LocalStores.tsx`, wording helpers in `storeText.ts` with a test,
  styles at the end of `pages.css`, `client/src/pages/StoresPage.tsx`, `api.singles.*`):
  `AvailabilityPanel` ("Available in Las Vegas", signed-in only, hidden when the server is
  unconfigured; stores cheapest first, six listings per store then a "see them all" search link,
  "unavailable right now" when the breaker is open) and `PurchaseLinks` (TCGplayer / Cardmarket /
  Cardhoarder buttons, "Links go to those stores (via Scryfall). CGwF sells nothing.") sit at the
  bottom of `CardDetail`; `ShoppingPanel` ("Shop locally": three summary tiles, per-store coverage
  bars with the best single store marked, the missing list, an expandable per-card table that
  stacks on phones) sits under the Bracket/Stats row on deck and library deck pages and re-runs on
  the deck version; `/stores` lists the stores (nav link for signed-in players). Every panel ends
  with `SourceNote`: "Updated X ago, from local store data. Stock is a snapshot; confirm with the
  store before visiting." Every link is `target=_blank rel=noopener noreferrer`.

## Table hygiene (stopgap before the rules engine, 2026-10-17)

Real games showed players tapping and moving each other's permanents, browsing libraries, forgetting
untap/draw, and having no attack flow. The gameplay core will be replaced by the Forge rules engine
in a separate project; until then these guardrails live in the reducer (so the server enforces
them) with tests in `shared/src/game/hygiene.test.ts` and on the wire in `rooms.test.ts`.

- **Ownership.** A permanent belongs to its controller (`zone.owner`); only they tap, untap, move,
  flip, turn face down, counter, attach, modify or copy it (`requireController`). Cards in a
  graveyard, exile or command zone belong to that zone's owner. Mana pools, manual anthems and
  triggers are per player. Life and poison stay open to any seated player (logged "(by X)");
  commander damage is recorded by the victim or the commander's owner. Spectators (anyone not in
  `state.players`) are refused by the reducer, not only by the room. Two explicit exceptions:
  the controller moving a permanent onto another player's battlefield (`CardMoved`, logged "gave
  control of X to Y") and `ControlTaken {iid, row?}`, the ONLY way to move a card you do not
  control: it pulls a permanent (or a card in someone's graveyard/exile, for reanimation) onto the
  actor's battlefield, logged "Blair took control of X from Alex['s graveyard]".
- **Libraries.** Browsing is only ever `LibraryLooked` / `LibrarySearched` / `LibraryRevealed` by
  the owner, each logged; the view never lists another player's library or hand cards, and a
  shuffle forgets. `CardRevealed`, `CardTurned` face up and `CardFlipped` are owner/controller only,
  so nobody can expose another player's hidden card.
- **Turn automation.** `TurnAdvanced` (or `StepAdvanced` past cleanup) untaps the new active
  player's permanents ("Alex's permanents untapped (3)") and opens the turn on **upkeep**, so
  upkeep triggers surface at once; the game also starts on upkeep. The turn's draw happens once the
  step reaches or passes `draw` (`drewForTurn` guards against a second one; jumping straight to
  main1 draws too), logged "Alex drew for the turn" / "could not draw (library empty)". Everyone
  draws on turn one (Commander). A card that says to skip the draw: put it back on top by hand.
- **Combat as events.** `AttackersDeclared {attacks: [{iid, player, planeswalker?}]}` by the active
  player: attackers must be untapped permanents they control, defenders alive opponents (or one of
  their planeswalkers/battles); attackers tap unless their derived keywords include vigilance;
  re-declaring replaces the attack and untaps what the first declaration tapped; step -> attackers.
  `BlockersDeclared {player, blocks: [{iid, attacker}]}` by each defender (untapped creatures they
  control, one attacker each, only attackers aimed at them; empty = "declares no blocks"; replaces
  that player's earlier blocks); step -> blockers. `CombatDamageDealt {assignments?}` by the
  attacker applies damage; without `assignments` the default from `combat.ts`
  `proposeCombatDamage` is used: unblocked -> defender (or the planeswalker), blocked -> lethal to
  each blocker in order (1 with deathtouch), the rest to the last blocker or, with trample, to the
  defender; blockers deal their power to the attacker they block. Custom assignments may only move
  damage between what a creature attacks and what blocks it. Applying: life (or poison with
  infect, plus toxic), commander damage when the source is a commander, lifelink, planeswalker
  loyalty / battle defense counters; creature damage is logged ("Lethal damage on X, Y: move them
  to the graveyard unless something saves them") and the players move the dead. **Passing the
  step past blockers, jumping to main2/end, or passing the turn with attackers declared applies
  the default damage automatically** (logged "(default assignment)"); undo/revert to redo it.
  Not modelled: first strike, damage prevention, protection, menace/evasion checks, damage marked
  across events. `state.combat` is cleared once the step passes end of combat or the turn ends.
- **Eliminations.** After every event `checkEliminations` marks `player.eliminated` ("life" at
  <= 0, "poison" at >= 10, "commander damage" at >= 21 from one commander), logged "Blair is out
  of the game: 0 life (revert if that was a mistake)"; the flag is derived, so a corrected life
  total or a revert brings the player back ("back in the game"). `isOut(p)` (conceded or
  eliminated) is what turn order, attacks, random opponent and "last player standing" use;
  `checkEnded` runs after every event. Because an automatic ending can be a typo, `LiveRoom.undo`
  and `revert` are allowed while the room status is `ended` too (the replay sets it back to playing).
- **Win advisories.** `wincons.ts` reads "you win the game" permanents for the static patterns
  "~ has N or more <kind> counters" / "there are N or more ... counters on ~", "you have N or more
  life" / "exactly N life", "you control N or more <type>s", "you control a creature with power N
  or greater", "N or more [<type>] cards (are) in your graveyard", Barren Glory. Met conditions
  become `state.winAdvisories` (in the view for everyone); the controller confirms with
  `WinClaimed {iid}` (ends the game, logged with the condition) or hides it with
  `WinAdvisoryDismissed {iid}`. Thassa's Oracle, Lab Man, Approach etc. are not read: opponents
  concede as before.
- Agents: the `attack` tool now emits one `AttackersDeclared`; the runner no longer draws by hand.
- **Client** (`client/src/game/`): `PhaseStrip.tsx` owns the turn controls and prompts ("Harper
  attacks you with Krenko - Block... / No blocks", "Attacking Blair... Assign damage / Change
  attackers", "Win condition met: ... Claim the win / Not yet", "You are out of the game").
  `CombatBar.tsx` is the picking mode inside the strip: attack = pick a target chip (players and
  their planeswalkers/battles, avatar colours), tap my untapped creatures (`Table.tapCard`
  intercepts taps while a mode is open; each tile shows a `mark` like "-> Blair"), Declare ->
  `AttackersDeclared`; block = pick one of the attackers aimed at me, tap my untapped creatures,
  Declare -> `BlockersDeclared` (empty = no blocks). Everyone sees the marks of the declared
  attack. `DamageSheet.tsx` lists `proposeDamage(combatContextFromView(view, printings))` per
  source with editable amounts (plus a 0 row to the player for blocked attackers), previews
  lethal creatures, and sends `CombatDamageDealt` (`{}` when untouched so the log says default).
  `actions.ts` offers only Take control (`ControlTaken`), token copy and Zoom on permanents and
  graveyard/exile cards I do not control. Opponent chips, the life widget and the menu show
  `eliminated` as OUT. `CardZoom` fits the WHOLE card: `.zoom` is a grid, the image width is
  `min(100vw - 48px, (100dvh - 90px) * 63/88, 440px)` beside the text in landscape and
  `min(100vw - 48px, 56dvh * 63/88)` above a scrolling text pane in portrait (`game.css`).
  `scripts/bots.mjs` bots act whenever they are the active player (a turn now opens on upkeep).

## Rules engine tables (Forge, Stage 1)

An opt-in second kind of table: the open-source Forge rules engine runs the game (untap, draw,
mana, the stack, combat, win conditions) and humans answer its prompts. The classic manual table
is untouched; engine tables are per room ("Rules engine (beta)" on the Play page, shown only
when the server has an engine configured). Design and effort plan: `docs/FORGE-ENGINE.md`;
the engine service itself (Java, GPL-3.0, own LICENSE + NOTICE crediting Forge): `engine/README.md`.

- **Topology.** Browser -> CGwF server (same room socket as always) -> ONE control WebSocket ->
  the engine (Fly app `cgwf-engine`, `ws://cgwf-engine.internal:8081`, no public port,
  `Authorization: Bearer ENGINE_TOKEN` on the handshake, same secret on both apps; the token
  lives only in `C:\Openclaw\cgwf-secrets\engine-token.txt`). `ENGINE_URL` unset = engine
  tables unavailable (`GET /api/features` -> `{engine:false}`, `POST /api/rooms {engine:true}`
  -> 503). Games live in the engine's RAM only: the machine is always on
  (`engine/fly.toml`: no services, restart policy always); a restart loses games in progress
  and the relay ends such tables with an honest "the rules engine restarted" result.
- **Hidden information, twice.** The engine's `SeatView.java` is the only serialiser and never
  emits libraries or other hands (proved by `HiddenInformationTest`, which audits every seat's
  view at every event AND the view attached to every prompt of a scripted human seat; run with
  `-Dforge.assets=<forge-gui>`; the CI `engine` job does this). The relay (`server/src/rooms/
  engineTable.ts`) renders a frame the engine sent for seat N only to sockets of the user in
  seat N; spectators get the spectator frame; `server/src/engine/engine.test.ts` proves it over
  real sockets against a fake engine.
- **Server pieces** (`server/src/engine/`): `client.ts` (reconnecting control socket, `rid`
  correlation for `createGame`), `mapping.ts` (`PrintingMapper`: Forge name + Scryfall set code
  + collector number -> `cards.id`, then name through `NameIndex`, tokens by name + P/T; cached
  per table and persisted in `rooms.engine_state`), `view.ts` (pure: engine frame ->
  `PlayerView` with Forge player ids -> user ids, Forge steps -> `Step`, `ViewCard.engine`
  {power, toughness, damage, sick}, `PlayerView.engine` {phase, prompt, waitingOn, playable,
  stops, engineDown}; prompt/answer conversion with iids), `deck.ts` (deck -> engine JSON; the
  deck page's warnings become BLOCKING here: Forge would play an illegal deck). `LiveRoom`
  holds an `EngineTable` when `rooms.engine = 1` (migration 0010): no reducer runs, the event
  log holds `GameStarted` (players only), `EngineLog` (one row per engine log line),
  `EngineAnswer` (every human answer, replayable later) and `EngineGameOver`; the classic
  reducer refuses those types. `submit`/`undo`/`revert` are refused on engine tables.
- **Protocol to the engine** (one frame = one JSON object; `gameId` = room id; `seat` = table
  seat, -1 = spectator): `createGame`, `answer`, `setStops`, `resync`, `attachSeat`/`detachSeat`,
  `concede`, `endGame`, `health`, `ping` in; `hello`, `gameCreated`, `cards` (every card at the
  start, for printing mapping), `state`, `prompt`, `log`, `gameOver`, `error`, `pong` out. Prompt
  kinds: priority (play a land / cast / activate, mana paid automatically), targets (cards,
  players and spells on the stack), attackers, blockers, choose, chooseMany, confirm, mulligan
  (+ bottom as chooseMany with `reason: "mulligan"`), and since Stage 2 M1: number (X, "choose
  a number", how many times), order (scry / surveil with `buckets` top|bottom|graveyard, "put
  back in any order", trigger order: first = resolves first), assign (combat damage with
  trample or several blockers, divided damage; positional `amounts`), mode (modal spells), text
  (free-text card names, validated by the engine). Shapes: `shared/src/engine.ts`. Anything
  nobody answers within `CGWF_PROMPT_TIMEOUT_MS` (default 10 min) or while a seat is marked
  absent is decided by Forge's AI for that seat; an ILLEGAL answer gets an `error` and the same
  question again (three times, then the AI).
- **Casting is Forge's own human flow (Stage 2 M1).** `BridgeController.playChosenSpellAbility`
  / `playTrigger` / `playSaFromPlayEffect` hand the chosen ability to `PlaySpellAbility`, so
  optional costs (kicker) are offered, X is asked (capped by what the seat can pay), targets are
  chosen per ability through `chooseTargetsFor`, and costs are decided by `BridgeCostDecision`
  (extends Forge's AI decider: mana is still paid automatically; WHICH cards to sacrifice,
  discard, tap, exile or return is asked through chooseMany). Resolve-time "unless" costs
  (shock lands' 2 life, "counter unless you pay", echo) go through `payCostToPreventEffect`:
  a confirm prompt with the card and "If you don't: ..." first, then Forge's
  `payCostDuringAbilityResolve`. "You may" triggers ask at resolution (`confirmTrigger`);
  replacement effects, static applications, coin calls and tap/untap choices are confirms with
  two labelled buttons. Not asked yet: divide-shield,
  redirect targets (Spellskite), bidding, Un-set dice/sprockets.
- **Permanent tests.** `engine/src/test/.../PromptRoundTripTest` drives every prompt kind through
  the real controller against a hand-built game (needs `-Dforge.assets`): prompt shape, answer,
  return value, re-ask on illegal answers, "no question when the rules leave no choice";
  `HiddenInformationTest` still audits every prompt's view. `server/src/engine/engine.test.ts`
  round-trips each kind through the relay to the seat's socket and back.
- **The stack on screen (Stage 2 M2).** `SeatView.stack()` describes every stack item (public
  information): kind spell | ability | trigger, the source card with its identity (so the relay
  resolves a printing and ships it with the frame), and `targets` (cards, players, and other
  stack items by stack id, found by matching the targeted SpellAbility against the stack). The
  relay maps that onto `StackItem.kind/name/printingId/targets` (`StackTargetRef`, engine tables
  only; the classic reducer never fills the stack). Client (`client/src/game/StackPanel.tsx`):
  a compact frosted **Stack panel** top-right whenever the stack is not empty (newest on top:
  thumbnail, name, controller dot, "targeting ..."; tap = read the card through CardZoom with a
  synthesised ViewCard, since stack cards are in no zone of the view); when a chain forms (two
  or more items, or an item aimed at a stack item) the centred gold-framed **Interaction Stack**
  window opens on its own with the chain ("on top of" connectors, targeted items outlined),
  Respond (back to the board) / Let it resolve (passes priority) for the player with priority,
  "Waiting for X" otherwise; the x minimises it to an "Interaction" button in the panel, and it
  re-opens when a new item lands on top. Land plays never use the stack, so they never appear.
  Prompt sheets other than priority take precedence over the window.
- **Client sheets** (`client/src/game/EnginePrompts.tsx`): confirm (card image + question + two
  buttons), number (stepper + quick values), order (rows with up/down and a Top/Bottom or
  Top/Graveyard segment), assign (per-target -/+ with lethal hints and a "Lethal first" fill),
  mode (toggle list), text (card-name input with search suggestions). They open on their own when
  the prompt arrives; closing one leaves the question in the engine bar ("Answer..."). List-shaped
  prompts (choose / chooseMany / targets) open the list sheet automatically when no option is on
  the table to tap (tutors, text options, spells on the stack); lists over 12 entries get a filter.
- **Auto-pass.** The engine only offers priority at a seat's stops (`EngineStops`: my turn
  MAIN1, declare attackers, MAIN2, end; opponents' end step; always when the top of the stack is
  someone else's). Stops live in `UserSettings.engineStops` (sanitised in `shared/settings.ts`),
  are sent to the engine for every seat right after `createGame`, and the table's Menu -> Stops
  panel changes them for the game AND saves them (`{t:"stops"}` -> `saveEngineStops`). "End turn"
  answers with `passUntilTurn` so the rest of the turn passes without prompts.
- **Stops row + auto-pass when nothing (Stage 2 M3).** On engine tables the phase strip's step
  dots are toggles: tap a step to stop there on whose turn it currently is (a ring marks stops);
  Menu -> Stops shows the same as two rows of chips (my turn / opponents' turns) plus "always
  stop when someone else uses the stack" and "pass automatically when I have nothing to do"
  (`EngineStops.autoPassEmpty`, ON by default). With that on, the engine passes without asking
  whenever priority comes with no legal play (no land at sorcery speed, no castable spell, no
  activatable ability with the mana available). Information trade-off, accepted by the owner:
  an instant pass can tell the table the player holds nothing usable right now, as on Arena.
  "Hold" in the strip (`{t:"hold", turn}`, engine frame `hold`) holds priority for one turn:
  every priority stops and nothing auto-passes (it also cancels an "End turn"); the engine drops
  it when the turn is over and the relay mirrors it in `EngineInfo.holdTurn`.
- **Mana: automatic, with "Pay with" (Stage 2 M5, owner's option 1).** Mana is still paid by
  Forge's AI payer, but a long-press on a glowing spell or ability opens the **Pay with** sheet
  (`PayWithSheet` in `EnginePrompts.tsx`): the card, the cost pips, and every untapped permanent
  of yours that can make mana (`ViewCard.engine.mana`, colour letters or "any", filled by
  `SeatView` from the permanent's mana abilities) as toggles numbered in the order tapped;
  "Cast, tapping these" answers the priority prompt with `paySources` (iids -> Forge card ids in
  the relay), "Cast, pay for me" answers without. In the engine `BridgeController.payManaCost`
  (the first mana payment of that cast) runs `tapChosenSources` first: one mana ability per chosen
  source, any-colour / combo sources steered to a colour the cost still needs via the mana
  part's express choice (so no colour question is asked), activated with `ComputerUtil.playNoStack`
  so the mana lands in the pool; the automatic payer then draws on the pool before tapping
  anything else. Sources that are tapped, gone, another player's or not mana sources are skipped;
  extra mana floats like any floating mana. Tests: `PromptRoundTripTest.payWithTaps...` and the
  relay round trip ("Pay with" in engine.test.ts). Not built: a full Arena-style payment sheet
  (option 2) or asking only when it matters (option 3).
- **Active Board + Game Log (Stage 2 M4, `client/src/game/Overlays.tsx`).** Two frosted overlays
  on top of the board, never a page change. The **Active Board** on the LEFT edge follows the
  turn: whose turn and which step, hand count, untapped lands and creatures, life, that player's
  latest log line, and their battlefield (the `Battlefield` component in compact mode) with the
  cards named in that line highlighted; it opens on its own when an opponent's turn begins,
  closes when yours does (your board is the table), and minimises to a "Board" arrow tab. The
  **Game Log** on the RIGHT third lists the sentence log with every card name tappable (the
  `nameMatcher` regex over the printings this client has seen, longest name first, split-card
  faces too; a tap opens CardZoom on a synthesised public card, "named in the game log") and
  minimises to a "Log" tab; while minimised new lines arrive as toasts top-right under the Stack
  panel (`LogToasts`: at most three, ~5 s each, step/turn lines skipped, `aria-live`). Layout:
  at phone landscape the two are never open together (opening one closes the other; when the
  board closes it hands the log back if it took its place); portrait stacks them (board top
  half, log bottom half). **Rotation (2026-10-18 fix):** which panels are open is the pure
  reducer `sidePanels.ts` (`panelsReducer`); every open carries the orientation read live from
  `matchMedia` at that moment (nothing caches it: a background tab or a late media-query event
  left a cached flag stale once), and a `layout` event on matchMedia change / resize /
  orientationchange re-applies the rule (rotating to landscape with both open keeps the board on
  an opponent's turn, else the log; rotating to portrait gives back a log that only stepped aside).
  The Stack column (`.corner-right`: Stack panel + toasts) routes around open panels in pure CSS
  (`.table-mid.side-panels/.has-board/.has-log`): left of the log at landscape, width-capped beside
  the board, clear of the minimised Log tab, and in portrait between the board's header and the
  log's header, so no minimise button or edge tab is ever covered. **Repeatable check:**
  `client/src/game/layoutCheck.ts` (`layoutProblems` pure + unit-tested; the table installs
  `window.cgwfLayoutCheck()`), which hit-tests every key control (phase steps, Hold, bar actions,
  edge tabs, both minimise buttons, Stack header, Menu) with `elementFromPoint` and flags off-screen
  or covered controls and both panels open at landscape. Rotate in DevTools (812x375 / 375x812 /
  667x375 / 375x667) with the overlays open and closed and run it in the console: expect `[]`.
  Tests: `sidePanels.test.ts` (incl. a 2000-step seeded rotation fuzz), `layoutCheck.test.ts`.
  Note: the Stops panel edits a draft that only applies on Save; its x discards. The relay strips Forge's internal ids and target brackets from log
  lines (`cleanEngineText`: "Shock (108)" -> "Shock", "[Blair]" -> "Blair"). `isStepLine` is
  the shared "this line only announces a step" test. `CGWF_DEBUG_PRIORITY=1` on the engine
  prints every priority decision (stops, legal plays per card) to stderr: use it before
  suspecting the stops ("it skipped my stop" has so far always been "nothing was castable").
- **Absent seats.** When a seated player's last socket closes during a game the relay waits
  `ENGINE_ABSENT_GRACE_MS` (3 min), then tells the engine `detachSeat`: Forge's AI plays that seat
  (a log line says so) until a socket is back (`attachSeat` + `resync`). Reloading the page
  re-sends the cached state and the open prompt at once.
- **Bot seats (M4).** The Phase 7 "Computer opponents" box works on engine tables too, WITHOUT
  `AGENTS_ENABLED` (owner-host only, as before): the bot users and their library-deck copies are
  created the same way, but at game start the relay sends their seats as `kind: "ai"`, so Forge's
  own AI plays them (no model call, no spend, no `agent_runs`); no Sonnet runner starts for an
  engine room. On shared-cpu-2x a Forge AI turn takes ~25 s with four AI seats (README has the
  one-command upgrade to performance-1x). Test: engine.test.ts "seats a Phase 7 bot user".
- **Legality in the lobby.** `RoomMember.deckProblems` (engine rooms) lists why a seated deck
  cannot start an engine game; the lobby shows it under the seat and the host's Start button
  names the player to fix. Start refuses with the same reasons.
- **Client.** `client/src/game/Engine.tsx` (prompt bar inside the phase strip, list sheet,
  ability picker, mulligan overlay); `Table.tsx` engine mode: a tap on a glowing card answers
  the open prompt, classic actions/events are hidden, life is read-only, concede goes through
  `{t:"concede"}`; `PhaseStrip` shows "Waiting for X" and disables step buttons.
- **Run it locally.** Engine: see `engine/README.md` (JDK 21 + Maven portable zips in
  `C:/Openclaw/tools`, Forge clone at `C:/Openclaw/forge`); `java -jar engine/target/cgwf-engine.jar
  serve --assets C:/Openclaw/forge/forge-gui --port 8084` with `ENGINE_TOKEN=testtoken`. Server:
  `.env` with `ENGINE_URL=ws://localhost:8084` and `ENGINE_TOKEN=testtoken`. A second human for
  solo testing: `node scripts/engine-bot.mjs http://localhost:8093 <code> Blair 1` (registers a
  profile with a legal Krenko + 99 Mountains deck, sits down, answers every prompt). Note that
  with `ENGINE_URL` in `.env` every Vitest app also connects to that engine (harmless, noisy).
- **Bumping Forge.** Change the tag in `engine/pom.xml` (`forge.version`), `engine/Dockerfile`
  (`FORGE_TAG`) and `.github/workflows/ci.yml`; rebuild the four modules locally (README);
  run `mvn -Dforge.assets=... package` (the audit) and `node engine/spike/client.mjs` (four
  precons to completion); redeploy `cgwf-engine` from `engine/` with
  `fly deploy --remote-only --ha=false`, then `fly machine start` if it comes up stopped.

## Phases

1. Scaffold, Fly deploy, PWA shell, Scryfall ingest, card search page. **(done)**
2. Device identity, decks, decklist parser with per-site fixtures, printing resolution. **(done)**
3. Rooms, join codes, WebSocket sync, event log + reducer, the table, hidden info, reconnect. **(done)**
3b. Battlefield sections + assisted bookkeeping (attachment effects, anthems, triggers, mana). **(done)**
4. Polish: token finder, silent undo, sentence log, card zoom, rematch, personalization
   (playmats, sleeves, uploads, themes, layout), animations, accessibility. **(done)**
5. Accounts (email + password on top of device profiles), multi-device sessions, owner flag
   with a one-time claim code. **(done)**
6. Deck analysis engine, Commander Bracket panel, MTGJSON precon import, owner deck library
   with primers. **(done)**
7. Computer opponents driven by Claude Sonnet, owner-only, behind AGENTS_ENABLED with USD caps. **(done)**
8. Onboarding (welcome screen, tour, guided sign-up) and social (friend codes, requests, presence,
   table invites, notification bell, agent deck queue). **(done)**
9. Deck statistics panel beside Bracket (mana curve, pips, sources vs pips, breakdowns,
   functional counts), pure computation with an in-memory cache. **(done)**
9b. Owner-only Admin overview at `/admin` (who is on the platform, who is active). **(done)**
10. Local stores bridge: Scryfall purchase links in `cards`, read-only client for the Singles
    site's service API (cache + breaker), availability / shopping / stores routes, card-detail
    availability + purchase links, deck shopping panel, Stores page. **(done)**
10b. Table hygiene stopgap: ownership guardrails, automatic untap/draw, combat events, automatic
    eliminations, win advisories; phase strip, attack / block / damage UI, full-card zoom. **(done)**
11. Rules engine (Forge) tables, Stage 1: M1 engine control protocol + relay + CI **(done)**,
    M2 engine games playable end to end in the app **(done)**, M3 four seats / saved stops /
    resync / legality messages / docs **(done)**, M4 Forge AI bot seats **(done)**. See `docs/FORGE-ENGINE.md`.
11b. Stage 2: S2-M1 every common prompt reaches the human (confirm with the card, numbers/X,
    ordering, damage assignment, modes, card names, cost choices; casting via Forge's human flow)
    **(done)**; S2-M2 Stack panel + Interaction Stack **(done)**; S2-M3 stops row + auto-pass
    when nothing to do + hold **(done)**; S2-M4 Active Board overlay + Game Log panel with toasts
    **(done)**; S2-M5 manual mana (owner's option 1: automatic, long-press "Pay with" source picker)
    **(done)**.
12. Ideas: per-event view deltas if bandwidth matters, browser push notifications (see Phase 8),
    password reset once there is an email provider.
