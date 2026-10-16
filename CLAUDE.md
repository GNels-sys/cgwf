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
- Battlefield = structured rows per player (lands / creatures / other); tap an opponent to view
  their field. Phone landscape is the primary device.
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
  the SHA-256 hash (`users.device_token_hash`). `requireUser` in `server/src/auth.ts` guards
  routes; rate limits key on the user when signed in, else the IP.
- Tables: `users`, `decks`, `deck_cards` (printing id + quantity + board + category + position).
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
  `/decks/:id`, `/cards` search, `/me` profile. `RequireUser` shows the first-run profile form.

## The game (Phase 3)

### Model (`shared/src/game/`)

- `types.ts`: `GameState` = players (life, counters, commanderDamage, commanderTax, mulligans, kept,
  toBottom, conceded, zones) + `cards` (one `CardInstance` per physical card or token: full
  `CardPrinting`, owner, zone {kind, owner, row}, tapped, faceDown, face, counters, attachedTo,
  revealedTo) + turnOrder / activePlayer / turn / step + `rng` + `log` + `seq`. Zones: library
  (index 0 = top), hand, graveyard, exile, command, battlefield rows lands | creatures | other.
  `stack` and `priority` exist but are never used (reserved for a rules engine).
- Events (`EventPayloads`): GameStarted, Mulligan, HandKept, CardsDrawn, CardMoved, CardTapped,
  UntapAll, CardFlipped, CardTurned, CardRevealed, CounterChanged, LifeChanged,
  PlayerCounterChanged, CommanderDamage, CommanderTaxChanged, LibraryShuffled, LibraryRevealed,
  LibraryLooked, LibrarySearched, Milled, TokenCreated, CardCopied, Attached, TurnAdvanced,
  StepAdvanced, StepSet, DiceRolled, CoinFlipped, RandomOpponent, PlayerConceded, Revert.
  Clients send `{type, payload}`; the server stamps `seq` (1-based, contiguous), `actor`, `ts`.
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
- Table: opponents across the top (tap -> `OpponentPanel` with their rows and zones), my three
  battlefield rows, hand drawer, zone buttons, life widget. Tap a card -> `ActionSheet`
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

### Testing alone

`node scripts/bots.mjs http://localhost:8080` registers "Georgie" + three bots with small decks,
creates a room, seats the bots and prints a device token: put it in localStorage as `cgwf.token`
and open `/room/<code>` to play seat 1. Bots keep, play a land and pass on their turns; press
Enter in that terminal to force-drop and rejoin Blair (reconnect drill). Works against
https://cgwf.fly.dev too. The Vite proxy needs `ws: true` for `/api` (already set).

## Phases

1. Scaffold, Fly deploy, PWA shell, Scryfall ingest, card search page. **(done)**
2. Device identity, decks, decklist parser with per-site fixtures, printing resolution. **(done)**
3. Rooms, join codes, WebSocket sync, event log + reducer, the table, hidden info, reconnect. **(done)**
4. Polish: token finder, silent undo, sentence log, card zoom, rematch, personalization
   (playmats, sleeves, uploads, themes, layout), animations, accessibility. **(done)**
5. Ideas: per-event view deltas if bandwidth matters, rules-engine groundwork (stack, priority).
