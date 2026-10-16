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
  position); Phase 6 adds `combo_cache`, `library_decks`, `library_deck_cards`.
  Boards: main | commander | sideboard | maybeboard | companion. Format column kept, "commander" only.
- Parser: `shared/src/deck/parse.ts` (pure text -> lines/boards/tags/markers); fixtures for the
  five sites in `shared/src/deck/fixtures.ts`. Resolution against card data lives in
  `server/src/decks/resolve.ts`: exact set+number, then exact name (preferring the named set),
  then fuzzy -> "ambiguous" with candidates. Unlabelled lists (Moxfield/Goldfish) get the
  "first small block of legendary creatures = commander" heuristic.
- Routes: `POST /api/decks/parse`, `GET /api/decks/import-url?url=`, `GET/POST /api/decks`,
  `GET/PATCH/DELETE /api/decks/:id`, `PUT /api/decks/:id/cards`. Warnings (size, singleton,
  colour identity, commander count/partners) are computed on read, never block saving.
- URL import finding (2026-10-15): Archidekt's `https://archidekt.com/api/decks/{id}/` is public
  JSON (cards carry Scryfall `uid`, set code, collector number, categories; "Commander" category =
  commander; categories with `includedInDeck=false` = maybeboard). Moxfield's API returns 403 to
  non-browser clients, so Moxfield users paste the text export.
- Client routes: `/` decks, `/decks/new` import (paste or Archidekt link -> review/fix -> save),
  `/decks/:id`, `/cards` search, `/me` profile, `/signup`, `/signin`. `RequireUser` shows the
  first-run profile form.

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
  ManaEmptied, KeepManaToggled. `Attached` carries the confirmed `effect` {power, toughness,
  keywords}. Clients send `{type, payload}`; the server stamps `seq` (1-based, contiguous),
  `actor`, `ts`.
- `reducer.ts`: `applyEvent(state, event, seed)` is pure and throws `GameError` for illegal
  actions (nobody touches another player's hand or library; only the host starts). `replay(events,
  seed)` rebuilds state; a `Revert {toSeq}` replays the prefix up to `toSeq` and later events
  continue from there. Log lines name a card only when its identity is public.
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
  my battlefield (`Battlefield.tsx`: sections, stacked attachments, anthem badge), hand drawer,
  zone buttons, life widget, mana pill, triggers panel. Tap a card -> `ActionSheet`
  (`actions.ts` builds the list per zone); press-and-hold -> `CardZoom`. `@dnd-kit` drag onto
  rows/zone buttons is the secondary path. Menu: log (tap a line to revert), dice, tokens
  (Scryfall token search or custom text token), undo, untap all, concede, leave.
- Mulligan overlay handles London mulligans; `toBottom` in the state drives the "put N on the
  bottom" step. Pass turn untaps the new active player's permanents automatically (re-tap what
  should stay tapped).
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
  `GET /api/library/:id/primer-skeleton`.
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

### Testing alone

`node scripts/seed-field.mjs <base-url> <code> <token> "Lotus Cobra" "Rancor" ...` pulls named
cards from that player's library straight onto their battlefield (for testing bookkeeping).
`node scripts/bots.mjs http://localhost:8080` registers "Georgie" + three bots with small decks,
creates a room, seats the bots and prints a device token: put it in localStorage as `cgwf.token`
and open `/room/<code>` to play seat 1. Bots keep, play a land and pass on their turns; press
Enter in that terminal to force-drop and rejoin Blair (reconnect drill). Works against
https://cgwf.fly.dev too. The Vite proxy needs `ws: true` for `/api` (already set).

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
7. LLM opponents, owner-only (builds on `requireOwner`).
8. Ideas: per-event view deltas if bandwidth matters, rules-engine groundwork (stack, priority).
