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

Search: `NameIndex` keeps one default printing per oracle id (paper > REGULAR > fewest special
treatments > not promo > newest > hi-res scan > lowest collector number; see "Printings" below) plus
aliases for each face name; tiers exact > prefix > word > substring > bounded edit distance. Names
are normalised without punctuation, so two different cards can share an exact key ("Rampant Growth"
and the playtest card "Rampant, Growth"): the first in printing preference order keeps it, which is
the paper, regular card (fixed 2026-10-19; it had sent 23 EDHREC decks to Forge with a card Forge does
not know).

### Printings: default, picker, hover preview (2026-10-19)

Owner report: decks pasted as plain names ("1 Academy Manufactor") came out with odd printings. The
old preference (paper > promo-free > in boosters > newest) picked The List reprints (Scryfall marks
`plst` as in-booster, dated when the card joined The List) and the newest printing of recent cards,
which is usually a borderless / showcase / extended-art / Secret Lair / full-art version. In the
owner's Cloud deck (pasted 2026-10-19) 36 of 94 lines were such printings, in the Niv-Mizzet deck 26
of 77; 35 of the 171 lines were The List.

- **Look fields** (migration 0014, `cards`): `set_type`, `frame`, `frame_effects`, `border_color`,
  `full_art`, `textless`, `promo_types`, `finishes`, `oversized`, plus the derived `is_regular` and
  `treatment_count`, all from the bulk file by `toCardRow` (`scryfallTraits`). Rows keep the column
  defaults until the next ingest: **after deploying 0014 run `node server/dist/cli.js ingest --force`
  once** (through the running server over `fly ssh console`).
- **Regular** = `printingTreatments(traits)` in `shared/src/printing.ts` is empty. Treatments (also
  the picker's labels): Borderless (or another non-black/white border), Showcase, Extended art,
  Inverted frame, Etched, Shattered glass, Colorshifted, Full art, Textless, Retro frame (1993/1997
  frame on a card printed from 2004), Future frame, The List (`plst`, `mb1`, `mb2`, `ulst`), set types
  box (Secret Lair), masterpiece, from_the_vault, memorabilia, funny, minigame, vanguard,
  treasure_chest, alchemy, promo; promo types Booster Fun, serialized, thick stock, embossed, ... and
  any `*foil` treatment, Promo, Foil only / Etched only (no non-foil copy), Oversized. **Foil
  treatments count only when the printing has no non-foil copy**: Scryfall tags every Final Fantasy /
  Fallout precon card `surgefoil` because its foil copies are surge foil, but the non-foil copy is the
  plain card. Legendary frames, Universes Beyond, starter-collection and similar promo types are not
  treatments.
- **Default printing** = what a bare name resolves to (deck import, search, the token finder's
  ordering): paper and already released (previewed sets reach the bulk file early), regular first, then fewest treatments (so a foil-only precon face commander such
  as Dogmeat beats its showcase versions), then not promo, newest, hi-res, lowest collector number (a
  set's plain card before its same-day variants). A named set ("1 Sol Ring (FRC)") prefers that set's
  regular printing; an exact set + number still wins. **Printings already stored in decks are never
  changed**; owners fix existing lines with the picker. Replaying the owner's two lists: 61 of 94 and
  36 of 77 lines resolve differently now; the only special printings left are cards with no regular
  printing at all (Dogmeat PIP 2 foil-only face card, Super State only in Secret Lair).
- **Printing picker** (`client/src/components/PrintingPicker.tsx`): every deck line (own decks, the
  owner's library deck page; commanders under their image) has a set-code chip ("FRC 20") = "Change
  printing". The sheet lists every paper printing (`GET /api/cards/oracle/:oracleId/printings` ->
  `{printings: PrintingOption[], defaultId}`; set name and code, number, year, rarity, treatment labels,
  newest first) as a thumbnail grid with "In deck" and "Default" marks, a filter box above 12 printings
  (set, number, year, rarity, treatment words) and "Reset to default printing". Picking calls
  `PATCH /api/decks/:id/cards/:entry {cardId}` (own deck, 60/min) or `PATCH /api/library/:id/cards/:entry`
  (owner): `checkPrintingSwap` (`server/src/decks/printing.ts`) requires the same oracle id (same name
  for the rare row without one), paper, not a token; only that line changes and the deck's `updatedAt`
  moves, so Bracket, Stats and the shop panel refetch and commanders show the new art in deck tiles
  and games. `DeckCardEntry.entryId` and the library detail's `entryId`/`oracleId`/`set`/
  `collectorNumber`/`faceCount` carry what the picker needs. The library page's card list is now the
  same clickable lines as the deck page (tap = full card view).
- **Hover preview** (`client/src/components/hoverPreview.ts` rules + `CardHoverPreview.tsx`): deck
  page lines, library deck page lines and the import review (thumbnail, name, candidate chips) show the
  whole card (63:88, `CardImage`, never cropped) beside the cursor after 250 ms, flipped left near the
  right edge and clamped inside the viewport; moving between lines swaps the card at once and leaving
  waits 120 ms, so nothing flickers. Only for a mouse or pen on a device matching `(hover: hover) and
  (pointer: fine)` (checked live per event, plus a CSS guard): touch keeps tap-to-open. The preview
  has `pointer-events: none`, so a click still opens `CardDetail` (pointerdown hides it); keyboard focus
  that is `:focus-visible` shows it beside the line; Escape, scroll and window blur hide it; the fade
  runs only without reduced motion. Two-faced cards show both faces side by side when the window has
  room, else the front with "Two-faced: click for the back". Tests: `hoverPreview.test.ts` (fake
  timers: touch never, delay, no flicker, click hides, focus-visible only, placement, short windows),
  `shared/src/printing.test.ts`, `server/src/routes/printings.test.ts` (fixture printings: regular vs
  borderless / showcase / extended / surge / Secret Lair / The List / promo / retro / precon surge foil,
  the fallback, the printings route, both PATCH routes and their refusals), `scryfall/map.test.ts`.

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
- **Deck editor (2026-10-28, owner request).** Deck page -> "Edit cards" opens a local draft
  (`client/src/components/deckDraft.ts`, pure + `deckDraft.test.ts`; UI `DeckEditor.tsx`): "Add a card" searches
  the card data (`/api/cards/search`, 250 ms debounce, 8 results, "In deck xN") and adds one copy per tap to the
  main board (same printing = same line); every line (commanders too) gets a "−" to the right of its printing chip
  that takes one copy off (the line goes with its last copy); "Undo" steps back through the last 50 changes and
  names the one it takes back ("Undo: Removed Sol Ring"); the printing picker changes the draft line instead of
  saving. A slim bar (count against 100, Undo, Cancel, Save) stays pinned while scrolling the list; leaving with
  unsaved changes asks first. **Save = `PUT /api/decks/:id/cards` with the whole list, refused unless main +
  commander make exactly 100** (`deckSizeProblem` in `shared/src/deck/types.ts`, the same check on the page and
  the server): "Your deck currently has 101 cards. Please remove 1 card prior to saving." (or "...98 cards.
  Please add 2 cards..."). Companion, sideboard and maybeboard sit outside the 100 (`COUNTED_BOARDS`). Imports
  (`POST /api/decks`) still only warn, so a short import can be finished in the editor.
  **Commanders that lift the maximum** (owner, 2026-10-28): Whtz, the Bibliophile ("Rulebreaker — A deck with this
  commander has no maximum deck size", released 2026-10-19) and The Covert Blue Mage ("any number of cards beyond
  the maximum deck size"). `deckSizeRule(commanders)` (shared `deck/types.ts`) reads the commanders' Oracle text
  (`NO_MAXIMUM_DECK_SIZE`, so a new card with the same wording counts) -> `{min: 100, max: null, grantedBy}`; the
  standard rule is `STANDARD_DECK_SIZE` (100/100). It drives the PUT save check (from the commander lines being
  saved), the deck page's "size" warning (which engine tables treat as blocking, so a 150-card Whtz deck can sit
  down; Forge reads the same cards' `DeckRule:Size:AdjustMax$ Unlimited`) and `DeckDetail.sizeRule`; the editor bar
  shows "N cards · at least 100, no maximum (Whtz, the Bibliophile)" while that commander is still in the draft
  (`draftSizeRule`). One line may hold up to 300 copies (`MAX_LINE_COPIES`, was 99) for big basic-land counts.
  Tests: `deckDraft.test.ts`, `server/src/routes/deckEdit.test.ts`; older tests that saved small lists through
  PUT now top them up to 100 with Forests (`padTo100`).
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

### Deck library (owner edits; every signed-in player can read and play it since 2026-10-18)

- **Read-only for everyone (2026-10-18).** `GET /api/library-decks[?bracket=]` (summaries) and
  `GET /api/library-decks/:id` (card list) need only a signed-in player; everything below under
  `/api/library` (edit, primers, import, submissions) and the agents pages stay owner-only.
  **Lobby deck choice** (`client/src/game/DeckPicker.tsx`): a bracket filter ("Any bracket" or
  B1-B5) above two separate lists presented as an OR, "Your decks" and "Deck library" (picking in
  one clears the other, because the seat holds one deck). `GET /api/rooms/deck-options[?bracket=N]`
  (`server/src/routes/deckOptions.ts`) returns the caller's own decks (bracket = the analysis
  engine's suggestion, computed with `analyzeSync`, cached per deck id + `updatedAt`; unknown only
  under "Any bracket") and every library deck (stored bracket), both alphabetical
  (`filterDeckOptions` / `deckOptionLabel` in `shared/src/deckOptions.ts`). Other players' personal
  decks are never listed. A library pick is stored in `room_members.deck_id` as
  `library:<library_decks.id>` (no migration); `describeDeck` shows it to the table as
  "<name> (library)", and `seatDeckRows` (rooms/deck.ts) feeds `deckForEngine` and the classic
  `loadDeckForGame` the same boards and legality checks as an own deck. Bot seats still copy an
  agent-eligible library deck as before. Tests: `routes/deckOptions.test.ts`,
  `shared/src/deckOptions.test.ts`, engine.test "one of them from the deck library".

- Tables (migration 0006): `library_decks` (name, source precon|user, source_key unique =
  `mtgjson:<fileName>` or `deck:<deckId>`, set_code, set_name, release_date, commanders JSON,
  bracket (owner's call, precons default 2, user decks default to the suggestion, EDHREC decks EDHREC's), bracket_floor,
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
- **Bot pool and the rules-engine check (2026-10-19).** Owner report: Bracket 2 bots kept dealing the
  same four decks (Sai, Giada, Trostani, Jace). Cause: only 4 of the 197 precons were agent-eligible
  (an earlier test run had switched them on), so the Bracket 2 pool was four decks. Fixes:
  - `server/src/library/coverage.ts` (`LibraryCoverage`): the EDHREC importer's Forge check made
    library-wide, for any source. Each deck goes through `deckForEngine` (an engine table's own
    conversion and legality checks) and `CoverageChecker` (four decks per `deckcheck-<uuid>` game);
    `LibraryService.recordCoverage` stores `import_meta.coverage` {checkedAt, missing}, `problems`
    (why an engine table would refuse it), `coverageError`, `eligibleBy`, and writes
    `DATA_DIR/reports/library-coverage-<ts>.md` (per-bracket eligible before/after, switched on,
    excluded with missing cards or problems, not checked). Run: `node server/dist/cli.js
    check-library-coverage [--source precon|edhrec|user] [--enable]` over `fly ssh console` (needs the
    running server; stays attached and prints progress), `POST /api/admin/library-coverage` (loopback /
    ADMIN_TOKEN), owner `POST/GET /api/library/coverage {source?, enable?}` and the Library page's "Check
    with the rules engine" button. **Precon imports run it for the decks they add** (with enable) and
    list the ones that are not for bots in the import's problems.
  - **Eligibility never overrides the owner** (`server/src/library/eligibility.ts`, `decideEligibility`):
    `import_meta.eligibleBy` = "owner" (set by PATCH agentEligible from the Library page: the check never
    changes it, on or off) or "coverage" (switched on by a check, so a later failing check may switch it
    off). With no record, a deck that is already on counts as the owner's (the four hand-enabled
    precons), except EDHREC imports, which only ever became eligible through their importer's check. A
    check that could not run (engine down) changes nothing. The EDHREC importer's `setCoverage` uses the
    same rule. `LibraryDeckSummary.engineCheck` exposes the result for every source (`importInfo` is now
    EDHREC rows only); the library deck page shows missing cards / problems for non-EDHREC decks.
  - **Library page header**: bot-eligible vs total per bracket (`LibraryListResponse.bracketCounts`,
    whole library, ignoring filters), brackets under 15 eligible decks marked; tap one to filter.
  - **Bot box** (`AgentsControl` in `client/src/game/Lobby.tsx`): `GET /api/agents/pool?room=CODE`
    (owner, not behind AGENTS_ENABLED) -> eligible decks per bracket + the host's deck bracket (library
    seat: its stored bracket and tags; own deck: the analysis suggestion), which is the default choice.
    Options read "2 · Core · 190 decks", plus "Any bracket near mine (B1-B3) · N decks" (`bracket:
    "near"` = `nearBrackets(host)`, the host's bracket and one either side). A warning shows when the
    pool is under 5 decks per bot seat ("Only N decks at this bracket; re-rolls will repeat").
    `AddAgentsResponse.pool` {brackets, size, fallback, note}: an empty choice still falls back to every
    eligible deck and says so ("No Bracket 1 decks for bots; dealt from all brackets."). Helpers
    `agentPoolSize`, `agentPoolIsSmall`, `nearLabel` in `shared/src/agents.ts`. Tests:
    `library/eligibility.test.ts`, `library/coverage.test.ts` (fixture engine + fixture MTGJSON: import
    auto-check, hand-enabled kept, hand-disabled kept, check-enabled switched off later, offline engine,
    report-only, routes, counts), `agents/runner.test.ts` "bot box", `shared/src/agents.test.ts`.
- **Phase 7 hook:** a model may draft the primer; keep `PRIMER_SECTIONS` headings (the agent will
  read them by name), write the draft into `library_decks.primer` through the same PATCH, and add
  the model call behind an owner-only route. Agent opponents should pick from
  `library.list({agentEligible: true})`.

### EDHREC average decks (2026-10-18)

175 agent-eligible library decks from EDHREC: 75 Bracket 3 (EDHREC "upgraded"), 75 Bracket 4
("optimized"), 25 Bracket 5 ("cedh"). Code: `server/src/library/edhrec/`. Run:
`node server/dist/cli.js import-edhrec [--dry-run] [--refresh] [--recheck-coverage]` (asks the running
server over loopback, like `import-precons`, prints progress and the final report; without a server it
runs in-process with no engine, so coverage stays unchecked). Owner route: `POST /api/library/import-edhrec`.

- **Source and terms.** EDHREC's public JSON at `https://json.edhrec.com/pages/` (verified 2026-10-18):
  `commanders/{week|month|year}.json` and the 32 colour-identity lists (`commanders/<slug>.json`, slugs
  in `identity.ts`: mono-white ... colorless, azorius ... simic, esper ... temur, yore-tiller, glint-eye,
  dune-brood, ink-treader, witch-maw, five-color) give the candidate pool (top 100 each; partner and
  background pairs are one entry "A // B"); `commanders/<slug>.json` carries `bracket_counts` {"1".."5"}
  (decks per bracket) and `container.json_dict.card.color_identity`; `average-decks/<slug>/<upgraded|
  optimized|cedh>.json` is the bracket's average deck (`deck.commander[]`, `deck.cards {Type: [[name,
  qty]]}`, `archidekt [{c, q, u: Scryfall id}]`). Bracket-ranked lists do not exist (403); a 403 means an
  unknown path. Reference: the owner's skill `~/.claude/skills/mtg-edhrec-fetch`.
- **Politeness** (`client.ts`): one request per second, one at a time; User-Agent `CGwF/<version>
  (private card table, deck library import; <CONTACT_EMAIL>)`; every answer (including 403s as
  "missing") cached under `DATA_DIR/edhrec-cache/`, so reruns make no requests (`--refresh` ignores the
  cache); 429/5xx back off (Retry-After, else 5/15/45 s) and retry three times. A full first run is about
  650 commander pages + 35 lists + ~300 average decks: 15-20 minutes.
- **Selection** (`select.ts`, pure): per bracket, candidates with at least `minDecks` decks in that
  bracket (20 for B3/B4, 50 for cEDH) ranked by that bracket's deck count. Passes: A coverage (best deck of
  every colour identity that has one for B3/B4; of every size group - mono, two, three, four, five,
  colourless - for cEDH), B new primary archetypes until 10, C each win condition up to 3 (B3/B4) or 1
  (cEDH), D fill by rank, E only if still short: ignore the archetype cap (reported). Caps throughout:
  4 per colour identity (3 in cEDH), 12 per primary archetype; Bracket 4 may reuse at most a third (25)
  of the Bracket 3 commanders. Primary archetype = the analysis engine's top tag; win condition
  (`wincon.ts`, heuristic) = combo > alternate win > drain/burn > control/value > combat.
- **A candidate is evaluated only when it could be taken**: fetch its average deck for the bracket,
  resolve it through `resolveDecklist` (exact names; a fuzzy guess is refused; an unresolved name falls
  back to the Scryfall id EDHREC lists), require exactly 100 cards and zero `deckWarnings` (engine
  tables block illegal decks), analyse it (Spellbook through the cache). Failures are listed as
  "rejected" in the report and the next candidate is tried.
- **Import** (`importer.ts`, `LibraryService.upsertImported`): source `edhrec`, `source_key`
  `edhrec:<slug>:<upgraded|optimized|cedh>` (idempotent: a rerun replaces cards/analysis/tags/meta of the
  same row; it keeps an owner-edited primer and keeps earlier imports the new selection dropped, listed
  in the report), name `<Commander(s)> — <Upgraded|Optimized|cEDH> (EDHREC average)`, `source_url` the
  edhrec.com page, stored bracket = EDHREC's, tags from the engine, primer = the engine skeleton (no model
  spend), `import_meta` (migration 0012) = `LibraryImportInfo` {slug, edhrecBracket, decks, rank,
  winCondition, pickReason, mismatch, coverage, coverageError}. **Mismatch** = the classifier's floor is
  above EDHREC's bracket (e.g. an "upgraded" average with 4+ Game Changers) or its suggestion is two or
  more below; EDHREC's bracket is kept and the library flags it.
- **Forge coverage** (`coverage.ts`): exactly what a real engine table does - `deckForEngine` on the
  library deck, then a `createGame` whose `gameCreated` lists per seat the cards Forge's DeckLoader cannot
  resolve. Four decks per check game, all seats "human" (Forge's AI never plays), `endGame` at once, game
  id `deckcheck-<uuid>` (no room has that id, so the relay ignores its frames); "engine busy" waits and
  retries. Clean decks become agent-eligible; decks with missing cards stay in the library for people and
  are listed in the report; unchecked decks (no engine) stay ineligible until `--recheck-coverage`.
- **Attribution**: "Average deck data from EDHREC" with a link to the deck's EDHREC page on the library
  deck page (`client/src/components/EdhrecCredit.tsx`; as text in library rows, which are links
  themselves). Nothing else from EDHREC is republished. The averages are SYNTHESISED (most common card per
  slot across indexed decks), never one pilot's list; the deck names and the credit say so.
- Report: `DATA_DIR/reports/edhrec-import-<timestamp>.md` (per-bracket diversity summary, every pick
  with its reason, rejections, mismatches, coverage exclusions, stale imports). Tests:
  `edhrec/select.test.ts` (parsers, ranking, every cap, overlap, cEDH groups) and
  `edhrec/importer.test.ts` (polite client, partner mapping, import, coverage, idempotency) with fixture
  JSON (`edhrec/fixtures.ts`), no network.

## Deck Doctor (2026-10-19, free, no model spend)

Owner request: "a programmatic way to determine if there is a card that could be added into the deck to
increase synergy, and then recommend a cut of a card to make room". Code: `server/src/analysis/doctor/`
(`edhrec.ts` commander data, `roles.ts`, `plan.ts` pure planner, `service.ts`), `server/src/routes/doctor.ts`,
`shared/src/doctor.ts`, `client/src/components/DoctorPanel.tsx` (deck page and library deck page, under
Performance). Inspired by the Singles site's swap planner (vegas-mtg `lib/synergy.ts`, `lib/power.ts`); no
code is shared.

- **Routes.** `GET /api/decks/:id/doctor?bracket=N&allowHigher=1` (own deck), `GET /api/library-decks/:id/doctor`
  (library deck, any signed-in player, read-only: `canApply` false), both 20/min; `POST
  /api/decks/:id/doctor/apply {cutEntryId, addOracleId}` (own deck only: the cut line gives up one copy or
  is replaced, the add's default printing goes in, same filters as the suggestions, bumps `updatedAt` so
  Bracket / Stats / Performance / the shop refresh); `POST|DELETE /api/doctor/prefs {deckRef, oracleId,
  name, kind: keep|dismiss}` (migration 0015 `deck_doctor_prefs`, per player and deck, by oracle id).
- **EDHREC data** (`edhrec.ts`): the commander page `commanders/<slug>.json` and, when the target bracket
  maps to one, `commanders/<slug>/<core|upgraded|optimized|cedh>.json` (B2..B5; verified 2026-10-19). Each
  listed card has `synergy` (-1..1) and `num_decks / potential_decks` = inclusion. Slug = the front face
  name without accents or punctuation, hyphenated; partner / background pairs try "a-b" then "b-a"; the
  page's own commander name must mention every commander or it is not used. Through the import's polite
  client (1 req/s, named User-Agent, disk cache) with `maxAgeMs` 7 days and `failFast` (one attempt, then a
  stale cached copy if there is one). No page: "No EDHREC data for X" and no suggestions.
- **Candidates**: every card on the commander's EDHREC lists, plus Commander Spellbook "almostIncluded"
  combos that are exactly one card away (only when the target is Bracket 3+ or a higher bracket is
  allowed). Hard filters: the default printing, paper, not a token, not a basic land, Commander-legal,
  inside the commanders' colour identity, not already in the deck (by oracle id or name), not dismissed.
- **Scoring** (`plan.ts`): add = 60 x inclusion + 100 x positive synergy, + 15 when it fills a short role,
  + 20 per completed combo (two at most), dropped under 8. Roles come from the Stats finders: ramp, card
  draw, removal, board wipes, protection, lands; targets (`DOCTOR_ROLE_TARGETS`) are rules of thumb 10 / 10 /
  8 / 2 / 3 / 35. **Bracket**: the 80 best adds are replayed through `analyzeDeck` with the add and any
  combo it completes; one whose floor exceeds the target (or the deck's own floor, if that is already
  higher) is dropped unless "Allow a higher bracket", where the swap says "Raises the bracket floor to N".
  Target bracket = the deck's suggested bracket unless the player picks one.
- **Cuts**: never a commander, a "keep" card, a piece of a combo the deck already has, or a land unless the
  add is a land (so the land count never drops otherwise; a basic line gives up one copy). Cut value =
  60 x inclusion + 100 x synergy (0 when EDHREC does not list it) + 25 per short role it fills that the add
  does not - 8 per over-filled role - 5 at mana value 6+. The cut is the lowest-valued card sharing a role
  with the add ("ramp for ramp"), else the lowest overall; each card is cut once. A swap is kept when the
  add outscores the cut; the best 10 by gain. The reason sentence is built from those numbers ("+57%
  synergy with Cloud, in 66% of Cloud decks; the deck has 4 ramp of 10 suggested. Replaces Garruk's
  Uprising, your lowest-synergy card draw card."). Local stock for the adds from the Phase 10 bridge.
- **Attribution**: "Synergy data from EDHREC" (link to the commander page used) and "Combos by Commander
  Spellbook" (link) at the foot of the panel.
- **Known limits**: synergy measures what decks with this commander play, not card quality, so pet cards
  and new printings score low; role detection is the Stats regexes (same misses); a card on several
  EDHREC lists keeps the entry with the most decks; the bracket check sees combos only through Spellbook's
  one-card-away list (a three-card combo completed by two adds is not caught); EDHREC lists ~300 cards per
  commander, so niche picks outside them are never suggested.
- **Tests**: `analysis/doctor/doctor.test.ts` (fixture cards: same-role cut and reason text, dismissed /
  keep / combo pieces / commander protected, the land rule, a Game Changer held back at Bracket 2 unless
  allowed, an early two-card combo refused at B3 and offered at B4, ranking; EDHREC slugs, page parsing,
  page match), `routes/doctor.test.ts` (fixture EDHREC page: colours, cache, prefs, apply + its refusals,
  library read-only, no page), `client/src/components/doctorText.test.ts`.

### Deck Doctor AI upgrade (M2, OWNER ONLY, model spend)

"An upgrade that is to remain locked to all but me as the website owner, where they can use a Claude API to
find the absolute best card to add and what to cut." Code: `server/src/analysis/doctor/ai.ts` (`DoctorAi`,
`AnthropicDoctorLlm`), routes at the end of `routes/doctor.ts`, `client/src/components/DoctorAiSection.tsx`
(inside the Deck Doctor panel, rendered only for `isOwner`), `client/src/pages/DoctorAiUsageCard.tsx` (Admin).

- **Locks**: every route is `[requireUser, requireOwner]`; nothing runs unless `DOCTOR_AI_ENABLED=1` (Fly
  secret) and `ANTHROPIC_API_KEY` is set (the workspace-scoped key the agents use; never printed). Off =
  the owner sees "Claude upgrade: off", starting answers 503.
- **Model**: `DOCTOR_MODEL`, default `claude-opus-5-5` (the claude-api skill's default and the strongest
  Opus-class model; quality matters more than cost at a handful of runs, and Claude Fable 5.1 costs 2.5x with
  longer turns). Effort `DOCTOR_EFFORT` = `high` (Opus 5.5 defaults to `medium`); thinking is always on;
  `tool_choice: auto` (forced tool choice is a 400 on this model) with `strict` tool schemas; streamed
  (`finalMessage`) so long thinking never times out; server-side refusal fallbacks on (`betas:
  ["server-side-fallback-2026-07-01"], fallbacks: "default"`); the system prompt and the deck context are
  cache breakpoints, so every call after the first reads them at $0.20/MTok.
- **Input** (`renderContext`): the decklist with full oracle text and EDHREC synergy / inclusion per card,
  commanders and colour identity, the bracket rules, the analysis (floor, suggestion, reasons, Game Changers,
  combos), role counts, the free Doctor's shortlist with its reasons, the top 60 EDHREC cards not in the deck,
  the primer (library decks), pinned and dismissed cards, the target bracket and "allow higher".
- **Tools**: `lookup_card {name}` returns OUR card row (exact name via `NameIndex`; else up to five close
  matches): oracle text, type, cost, colour identity, Commander legality, inside the colours, Game Changer,
  roles, in the deck, dismissed, the floor now and if added (`floorWith`, counting combos it completes).
  `submit_recommendations {read, swaps[{add, cut, reason}]}` is validated with the free Doctor's rules (real
  paper card, legal, inside the identity, not in the deck, not dismissed, not added twice; cut in the deck,
  not a commander, not kept, a land only for a land, not more copies than the deck has; each swap and all of
  them together within the target bracket unless allowed). Invalid = an `is_error` tool result listing every
  problem; Claude fixes and resubmits. Up to `DOCTOR_MAX_CALLS` (10) model calls; text without a tool call
  is nudged twice, then the run ends as an error.
- **Spend** (separate from the agents' caps): before every call the run's cost so far is checked against
  `DOCTOR_MAX_USD_PER_RUN` (3.00) and today's total (UTC) against `DOCTOR_MAX_USD_PER_DAY` (15.00); a hit
  ends the run as `capped`. `DOCTOR_MAX_TOKENS_PER_CALL` (16000) bounds each answer. Cost = `costOf` from
  `agents/pricing.ts` per model attempt (`usage.iterations` when a refusal fallback ran). Table
  `doctor_ai_runs` (migration 0018): user, deck ref/name/version, target, model, served by, status
  running|done|capped|refused|error, calls, tool calls, rejected answers, tokens (in, out, cache read, cache
  write), cost, result JSON, error, timestamps. Admin page: today / 30 days / caps / last 30 runs.
- **Cache**: `POST .../doctor/ai` returns the finished run for the same deck version, target and "allow
  higher" without a model call; "Run again" (`force`) starts a new billed run. A run made for an older deck
  version still shows, marked as such, without Apply.
- **Output**: a one-paragraph read of the deck and up to five swaps with reasons, the same Apply / Keep /
  Not interested actions as the free Doctor (Apply = the same `/doctor/apply` route, own decks only).
- **Tests** (`routes/doctorAi.test.ts`, a scripted model, no network): owner only; a lookup, an invalid answer
  sent back with each reason, the fixed answer accepted; usage and cost recorded; the cache and Run again;
  per-run cap, refusal, daily cap and the flag; fallback pricing per attempt; the context marks pinned cards.

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
  takes `library.list({agentEligible: true, bracket})` (falls back to any eligible deck) and picks
  with `pickAgentDecks` (`pick.ts`, 2026-10-19 fix for "Re-roll always deals the same four decks":
  the old greedy fewest-shared-tags sort let tag-less decks win every deal): a **weighted random
  draw** (weight = 1 - 0.75 x share of the deck's tags already at the table, floor 0.25; a deck with
  no tags counts as half overlapping), decks dealt to this host recently sit out until the eligible
  pool is used up (`meta` key `agent_recent_decks:<userId>`, newest first, last 120 decks), then the
  least recently dealt come back first; two bots never share a commander unless the library leaves no
  other choice. Tests: `pick.test.ts` (seeded), runner.test "re-rolling keeps dealing decks this host
  has not just been dealt". It then creates the bot user ("Krenko bot", random avatar), the deck
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
(Classic-table harness: since casual tables were retired on 2026-10-18 it cannot open a room; use
`scripts/engine-bot.mjs` for engine tables.) `node scripts/bots.mjs http://localhost:8080` registers "Georgie" + three bots with small decks,
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
  `min(100vw - 48px, 56dvh * 63/88)` above a scrolling text pane in portrait (`game.css`). The grid's
  row is `minmax(0, 1fr)` (2026-10-27, owner report: a planeswalker holding every other walker's
  abilities): without it the row grew to its content in landscape and `.zoom`'s `overflow: hidden` cut
  the ability list off, so only the first few could be chosen; now the text column scrolls at every
  size (checked at 812x375, 667x375, 375x812, 375x667 with 14 abilities) and the list says how many
  there are ("14 available, scroll for all").
  `scripts/bots.mjs` bots act whenever they are the active player (a turn now opens on upkeep).

## Rules engine tables (Forge, Stage 1)

The open-source Forge rules engine runs the game (untap, draw, mana, the stack, combat, win
conditions) and humans answer its prompts. **Since 2026-10-18 every new table is an engine table**
(owner: casual tables "tend to be chaos"): the Play page has one "New table" button, and
`POST /api/rooms` without `engine: true` answers 400 "Casual tables are retired", as does a rematch
of an old casual room. The classic table code stays: existing casual rooms still load and show as
"Casual (legacy)" in recent tables, the lobby and the phase strip. `BuildOptions.casualRooms`
(tests of the classic table only, deliberately not an env var) turns creation back on. With no
reachable engine the Play page disables "New table" and says why. Design and effort plan: `docs/FORGE-ENGINE.md`;
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
  two labelled buttons. Everything else Forge can ask a player was audited on 2026-10-18 (next
  bullet); only Un-set Attractions/Contraptions and mana payment details stay with Forge's AI.
- **No decision is silently Forge's AI (audit 2026-10-18).** `BridgeController` extends Forge's
  `PlayerControllerAi`, so a `PlayerController` method it does not override is decided by the AI.
  Every one was compared with Forge's desktop `PlayerControllerHuman`; the table with each method's
  decision, frequency and verdict is `docs/FORGE-ENGINE.md` section 16. Routed in this audit: new
  targets for copies and redirects (`chooseNewTargetsFor`, and copies now go through Forge's human
  copy path), casting choice from effects / alternative additional costs (`getAbilityToPlay`),
  convoke/improvise, votes, coin-flip calls, dice (ignore / reroll / modify / swap), "one of each"
  digs, splice, Spellskite's target pick, prevention-shield splits, Assist (whom to ask; how much of
  someone else's spell you pay), dungeon choice, Room doors, life bids; an illegal trample split or
  "discard a land or two cards" answer is asked again instead of going to the AI. **Notices:** what
  Forge shows a human without asking (`reveal`: cards revealed to that seat, e.g. an opponent's hand
  after Gitaxian Probe; `notifyOfValue`: "Blair chose blue", votes, flips) goes out as an engine
  `notice` frame for that seat only; the relay resolves printings and sends `{t:"notice"}` to that
  player's sockets only; `client/src/game/Notices.tsx` shows them top right (cards stay until
  dismissed, text fades after 8 s). **Guard:** `BridgeCoverageTest` (reflection, no
  assets) fails when a `PlayerController` method is neither overridden nor in its `ALLOWED` map
  (verdict + reason per entry) and on stale entries; after a Forge bump, read the human controller's
  version of each new method and route it or allow-list it with a doc row. The targets prompt
  carries `cancelLabel` ("Keep current targets" when Cancel keeps the old targets).
- **Permanent tests.** `engine/src/test/.../PromptRoundTripTest` drives every prompt kind through
  the real controller against a hand-built game (needs `-Dforge.assets`): prompt shape, answer,
  return value, re-ask on illegal answers, "no question when the rules leave no choice";
  `HiddenInformationTest` still audits every prompt's view. `server/src/engine/engine.test.ts`
  round-trips each kind through the relay to the seat's socket and back.
- **Choices grouped by player (2026-10-20).** Owner request after #34: "a card list of items that we can interact
  with, separated by player". Every targets / choose / chooseMany prompt with a card, player or stack-item option
  (required or optional; not mulligan bottoms or Draw 10 put-backs) opens `GroupedChoiceSheet`
  (`client/src/game/ChoiceSheet.tsx`, grouping in `choiceGroups.ts`): one collapsible section per player in turn
  order starting with "You" (avatar, name, life; hidden when it has no option), the player as a target at the
  top of their section ("Player · 31 life"), then their cards by zone (battlefield Creatures / Artifacts /
  Enchantments / Lands / Other permanents from the card's row on the table, then Graveyard, Exile, Command
  zone, Hand, Library), then "On the stack", then anything else; a filter above 12 options. Battlefield cards
  belong to their controller, others to their owner. Rows: thumbnail (tap = CardZoom, never selects), name,
  mana cost dots, type line, P/T, counters, tapped, "with <attached cards>", a "Read" toggle with the oracle
  text inline (never selects). The footer counts ("1 of 2 chosen · 1 to 2") and the primary button names the
  action from the effect's first verb ("Exile Rhystic Study and Sol Ring"); #34's rules stand (disabled until
  min is met, "Choose none" with a confirmation when min is 0, closing only minimises). The glowing cards on the
  table remain a shortcut into the same pick state. To show oracle text the relay now sends the card data of a
  prompt's card options with that seat's state (`EngineTable.prompts[seat].printings`), to that seat only
  (relay test "sends a prompt's card options' full card data ... to that seat only"). Tests:
  `client/src/game/choiceSheet.test.tsx` (grouping by player and zone, player target placement, Read and Zoom
  do not select, named primary, a table tap updates the sheet, collapse).
- **Optional choices never default to "nothing" (2026-10-20).** Owner report: Cloud, Ex-SOLDIER ("attach up to
  one target Equipment you control to it") never got his Equipment. The bridge asked correctly (targets, min 0,
  max 1; prod room 7W4KD3) and the client answered `options: []`, because Confirm in the bar was enabled with
  nothing picked. Now (`client/src/game/optionalChoice.ts`): every targets / chooseMany prompt with min 0 and
  options, and every optional choose, opens its list sheet at once (`Table.tsx`; glowing cards may be hidden
  behind an overlay), with the source card and its ability on top; the primary button is disabled until
  something is picked and names it ("Choose Bloodforged Battle-Axe"); "Choose none" (single optional choices:
  "Don't use this") is a secondary, dashed button with one confirmation ("Attach nothing to Cloud?") before
  `options: []` goes out; a lone option is outlined first but never preselected; the x, tapping outside and
  Escape only minimise the sheet to the bar ("Choose..."). Sheets sit above the Interaction Stack and side
  panels (z 60). Optional targets lose the bar's Cancel (it was the same empty trap). `cgwfLayoutCheck()`
  checks an open sheet's own buttons. Tests: `client/src/game/optionalChoice.test.tsx` (happy-dom, a real
  React render: primary cannot send empty, x / backdrop / Escape never answer, the confirm path sends
  `options: []`), engine `CloudAttachTest` (a real game: the human casts Cloud, the trigger asks the human,
  choosing the Axe leaves it attached).
- **Playing cards from exile and other zones (2026-10-25).** Owner report (Fire Lord Zuko deck): Party Thrasher's
  chosen card and Inside Information's cards "never went to the board". The engine was right all along: engine
  `PlayFromExileTest` (a real game) shows the chosen card and both of an opponent's exiled cards in the priority list
  (Inside Information's as "{0}, Pay 1 life"), in the seat's view, and casting them puts them on the battlefield
  for the right price. The table only glowed hand and battlefield cards, so a card in exile (above all in an
  OPPONENT's exile) had no visible way to be played. Now `offZonePlays` (`client/src/game/offZonePlays.ts`) lists
  every priority option whose card sits in an exile, a graveyard, a command zone or the known top of a library,
  mine first, then turn order; the priority bar shows them as a row of buttons ("Llanowar Elves · Blair's exile ·
  Pay 1 life"; tap = the same as tapping a glowing card, long-press = Pay with), my Exile / Grave / Cmd buttons get
  an "N to play" badge, and zone card lists glow like the table. Tests: `offZonePlays.test.ts`,
  `offZoneBar.test.tsx` (a real render: the row, the cost, a tap plays it).
- **Opening hand (2026-10-20).** Owner request: free mulligans for the table, and a "draw 10, put 3 back"
  start. Lobby setting (host, frozen at start, shown to everyone with its rules in plain words from
  `OPENING_HAND_TEXT` in `shared/src/openingHand.ts`; `rooms.opening_hand` / `free_mulligans`, migration
  0020; recorded in `game_results.opening_hand` / `free_mulligans`; a rematch keeps it and who-goes-first).
  Sent as `createGame.openingHand`; engine side `OpeningHand` (shared by every seat's controller like
  `StartingPlayer`).
  - **Draw 7 (London mulligan), Free mulligans 0 / 1 / 2 (default 1 = the official multiplayer rule).**
    Forge's own `MulliganService` + `LondonMulligan` run the whole flow (deal, keep or shuffle back and draw
    seven, Serum Powder, opening-hand actions). Forge's only free-mulligan setting is a flag (first mulligan
    free with more than two players, or Brawl), and the service is built inside `GameAction.startGame`, so the
    table's count is applied where Forge asks for it: `tuckCardsViaMulligan` (bridge and AI seats) answers with
    mulligans taken minus the free ones (`OpeningHand.bottomNow`, from `PlayerStatistics.getMulliganCount`).
    Forge's London asks for the bottom cards right after each redraw (then "keep?"), not once after keeping;
    the outcome is the same. The keep prompt carries `mulligans`, `freeMulligans`, `nextBottom` for the line
    under "Keep this hand?" (`client/src/game/openingHandText.ts`).
  - **Draw 10, put 3 back (no mulligans)** (owner, 2026-10-20: not discarded, "the graveyard would favour
    graveyard decks"). Forge deals ten (`Player.setStartingHandSize`). The first `mulliganKeepHand` Forge asks
    (any seat) runs `GameSession.putBackAll` once on the game thread: every connected human gets a chooseMany
    (`reason: "putBack"`, exactly 3 of their own ten) AT THE SAME TIME (helper threads; the game thread waits),
    Forge's AI (`getCardsToDiscard`) picks for bots and absent seats; then each player's three go into the
    library and Forge shuffles it (game RNG), logged "Alex put 3 cards back and shuffled." with no card named.
    Every keep question then answers "keep" without asking. Nothing is discarded or revealed, so nothing
    triggers; Leylines / Gemstone Caverns / Chancellors are offered afterwards from the seven.
    Client: the mulligan modal with "Put 3 back into your library". `cgwfLayoutCheck()` checks a pregame
    modal's own buttons while one is open (they cover the table by design).
  - Tests: engine `OpeningHandTest` (real games: 0/1/2 free mulligans give bottoms [1,2] / [1] / [] and keep
    5/6/7 after two mulligans; Draw 10 asks both humans for exactly 3 of 10 at once, never a mulligan, nothing
    in any graveyard, 99 = library + hand, the three never appear in a later frame, the log line, Leyline still
    offered), relay engine.test "opening hand" (host only, validation, reload, frozen, createGame, game_results),
    `shared/src/openingHand.test.ts`, `client/src/game/openingHandText.test.ts`.
- **Who goes first (2026-10-19).** Owner request: "roll to determine who goes first". Lobby setting (host,
  `rooms.first_player`, migration 0019): **Roll a D20** (default) or **Random**. On Start the relay sends
  `createGame` with `deferStart: true` (the engine builds the game, so missing cards are still caught before
  anyone rolls, but does not start it), appends `GameStarted` and then:
  - **Roll:** `RoomInfo.firstRoll` (`shared/src/firstRoll.ts`: round, per seat value / contending / history /
    auto, winner, doneAt) goes to every member. Each seated player taps Roll (`{t:"roll"}`; only for their
    own seat, once per round; spectators refused); the server rolls with `crypto.randomInt` (`d20` in
    `engineTable.ts`), never the client. Bots and seats with no socket roll on their own after
    `FIRST_ROLL_AUTO_MS` (1.5 s, +0.4 s per seat); a connected player who never taps is rolled for after
    `FIRST_ROLL_TIMEOUT_MS` (60 s); a player who disconnects mid-roll is rolled for after the short delay.
    The single highest roll wins; a tie re-rolls among the tied seats only (`resolveRound`). Every roll is
    an `EngineRoll {round, seat, value, auto}` event plus an EngineLog line ("Alex rolled 17", "Alex and
    Blair tied with 12: they roll again", "Alex goes first"); `EngineFirstPlayer {seat, method}` closes it.
    A reload rebuilds the roll from those events (`PersistedState.firstPlayer.decided` says whether it was
    still open), re-arming the automatic rolls.
  - **Random:** the server picks a seat with `crypto.randomInt`, logs "Random pick: Alex goes first", no overlay.
  - Then `beginGame {startingSeat}`; `game_results.starting_seat` / `first_player_method` record it.
  - **Engine hook** (`StartingPlayer`, `BridgeAiLobbyPlayer`): Forge's `GameAction.determineFirstTurnPlayer`
    flips for a player and then asks THAT player's controller `chooseStartingPlayer`. Every seat's controller
    (the bridge's for humans, a `PlayerControllerAi` subclass for AI seats) answers with the table's choice,
    so Forge's own flip never decides and nobody is asked "Who plays first?". Without a `startingSeat`
    (an older relay) Forge behaves as before. A deferred game never begun is dropped after 30 minutes.
  - **Client** (`client/src/game/FirstRoll.tsx`, styles at the end of `game.css`): a modal over the lobby (the
    engine has sent no frame yet) or the table: a big original SVG D20 (your roll, then the winning roll),
    one small die per seat with Roll / "rolls automatically" / "waiting", tie rounds with each seat's rolls,
    "<name> goes first" for 4.5 s (Continue closes it) while the mulligan comes up underneath. The tumble is
    decorative (random faces for 0.9 s, then the server's value); under reduced motion the value shows at
    once. `cgwfLayoutCheck()` checks the overlay's own controls while it is open (it covers the table by
    design) and is installed by the overlay before the table exists; [] at 812x375 and 375x812.
  - Tests: engine `StartingPlayerTest` (real games: each of a human and two AI seats takes turn 1 when chosen,
    over seeds whose own flip differs; no "Who plays first?" prompt; a deferred game waits and can be
    ended), relay `engine.test.ts` "rolling for who goes first" (lobby setting + Random, own-seat rolls,
    refusals, a scripted tie re-rolled among the tied, beginGame + game_results, bot and absent seats
    rolling on their own, client reload and relay reload mid-roll), `shared/src/firstRoll.test.ts`,
    `client/src/game/firstRoll.test.ts`. `scripts/engine-bot.mjs` rolls its own die.
- **Ending a game never calls Forge from another thread (2026-10-20).** `GameSession.end()` (the relay's
  `endGame`: "End table", the owner's close, the idle sweep) used to call `game.setGameOver` on the control
  socket's thread. That takes Game's monitor and fires an event, while the game thread may sit inside
  `GameSession.onEvent` (the event bus's per-subscriber lock) waiting for Game's monitor: a deadlock that
  would have frozen the control socket, so every table. Found by `StartingPlayerTest` in the full suite.
  Now `end()` only sets a flag and marks the humans absent (a waiting prompt returns at once); the game
  thread sets the game over at its next event. Rule: from outside the game thread, never call a Forge method
  that fires events.
- **Counts are clamped to the options (2026-10-19).** Owner report: Blasphemous Edict ("each player
  sacrifices thirteen creatures") with six creatures sent a choose-13-of-6 prompt that could never be
  answered, so the spell never resolved. Rule 701.21a: a player sacrifices as many as they can. The
  fix is at the root, in `BridgeController.chooseManyIndex` / `chooseManyText` (every count-carrying
  prompt: sacrifice, destroy, discard, reveal, the cost decider, choose cards / entities for an
  effect, zone changes, one-of-each groups): max = min(max, options), min = min(min, max); no options
  (or max 0) = no prompt, an empty choice; when min equals the options they are all chosen without a
  prompt and the log says so for sacrifice / destroy / discard / reveal / exile ("Alex sacrificed all
  6 creatures (Blasphemous Edict).", "both creatures", "their only creature"; counts only, never
  names, since the options may be hidden cards). Costs are different: a cost is paid in full or not
  at all, so `chooseCardsForCost` answers null (unpaid) when there are fewer cards than the cost asks,
  as Forge's human controller does, and Forge's own `canPay` keeps such a spell off the priority
  list. Tests: `PromptRoundTripTest.countClamp*` (the Edict with six creatures and an opponent's
  three, sacrifice two of two / of three, empty lists, Cathartic Reunion with one other card).
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
  panel (`LogToasts`: at most three, ~5 s each, `aria-live`). **Only what happened (owner, 2026-10-29):**
  the relay tags every engine log line with `LogEntry.kind` from Forge's log entry type
  (`kindFromEngineLogType` in `shared/src/game/logLines.ts`: TURN -> turn, PHASE -> step, the relay's ROUND
  -> round, MANA -> mana ("Plains - {T}: Add {W}.", one per mana tap), anything else -> event); toasts and
  the Active Board's "Latest:" show `event` lines only (`isEventEntry`), and the Game Log hides `step` and
  `mana` lines by default (`isQuietEntry`) behind a "Show all" / "Events only" chip in its header, keeping
  turn and round lines as separators. Lines without a kind (classic tables, lines persisted before this) are
  classified by wording (`classifyLogLine`), which also knows Forge's bare possessive for names ending in s
  ("Chris' Draw step") and leaves "phased out" and a resolved spell's description ("Giada, Font of Hope -
  Creature 2 / 2", STACK_RESOLVE) as events. The coach's log uses the same classifier. Tests: `shared/src/game/logLines.test.ts`, `overlays.test.tsx`,
  relay "announces each round" (kinds on the wire). Layout:
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
- **Land drops (checked 2026-10-18).** The only way to play a land on an engine table is Forge's own
  land ability: the priority list comes from `legalAbilities()` (Forge's `LandAbility.canPlay` ->
  `Player.canPlayLand`, which compares lands played this turn with `getMaxLandPlays()`), and the
  bridge plays the pick exactly as Forge's AI controller does (`sa.canPlay()` again, then
  `sa.resolve()`, which counts the drop). Extra drops exist only when a card raises Forge's maximum
  (Exploration, Azusa, Dryad of the Ilysian Grove); "put a land onto the battlefield" effects are
  ordinary effects, not land plays. The relay refuses classic events on engine tables, so nothing
  else can move a card. Test: `PromptRoundTripTest.landDropsFollowForgesLimitAndExplorationGrantsOneMore`.
  The owner's "two lands in a turn" came from a Casual table (FHWK6D), where nothing is enforced;
  casual tables were retired later the same day (new tables are always engine tables; old ones show
  "Casual (legacy)", and the phase strip shows a "Casual" tag on them).
- **Planeswalkers and the human's own triggers (2026-10-18).** Loyalty limits are Forge's, per card:
  `SpellAbilityRestriction` compares that walker's `getPlaneswalkerAbilityActivated()` with 1 (2 under
  `NumLoyaltyAct` statics such as Oath of Teferi; The Chain Veil adds more), and the priority list is
  rebuilt from Forge's live playable abilities at every priority, so two walkers activate once each
  and a blinked walker (a new object, printed loyalty) activates again. The owner's last game log
  shows two walkers activating in the same turn (VUMT2D turns 20, 22, 24). The real defect found
  while reproducing: the bridge inherited Forge's AI `orderAndPlaySimultaneousSa`, so Forge's AI
  chose the TARGETS and modes of the human's own triggered abilities (Displacer Kitten blinked
  whatever the AI picked). `BridgeController.orderAndPlaySimultaneousSa` now plays each of the
  seat's triggers through Forge's human flow (`PlaySpellAbility.playSpellAbility`, as Forge's own
  human controller does), so targets, modes, X and costs reach the human; copies of spells keep
  Forge's handling. Test: `PlaneswalkerTest` (a real game through Forge's priority loop: Ajani +
  Garruk once each, Mox Opal under Displacer Kitten with the human choosing the target, the blinked
  Ajani again at 4 loyalty, Oath of Teferi allowing one more, never a third).
- **Rounds (2026-10-18).** Forge's game turn stays the source of truth. A round is one pass around
  the table starting with the player who took turn 1: a new round begins when the turn goes to a
  player who sits earlier in Forge's player order (counted from that first player) than whoever had
  the previous turn. That is 1 + floor((turn - 1) / players still in at the start of the round)
  while nobody leaves or takes an extra turn, and stays right when they do (an eliminated player's
  skipped turn shortens the round; an extra turn stays in its round). Computed in the engine
  (`RoundTracker`, fed by `GameEventTurnBegan`), sent as `round` on every state, prompt-view and log
  frame; the relay maps it to `PlayerView.round` and writes a persisted "Round N begins" EngineLog
  line just before the round's first "Turn T (player)" line (restored on reload, never twice). The
  phase strip shows "Round N · <player>'s turn" with "Game turn T" small; the Active Board header
  "Round N · <player>'s turn", "<step> · Game turn T". Tests: `RoundTrackerTest`, relay
  "announces each round".
- **Opening hand and pregame (2026-10-18).** Forge's `MayEffectFromOpeningHand` cards (Leyline of the
  Void, Gemstone Caverns: never for the starting player, luck counter, exiles a card from hand;
  Chancellors' reveals with their delayed triggers) reach the human as one chooseMany
  (`reason: "openingHand"`, "From your opening hand: use which of these before the game begins?",
  each label "Card: what it does"); each action is logged when Forge actually plays it ("X uses
  Leyline of the Void from their opening hand.": an earlier pick may exile a later card, which Forge
  then skips). Serum Powder is implemented by the bridge (Forge has it only in its desktop UI): the
  mulligan prompt carries `serumPowder` (iids of the powders in hand), the overlay shows "Use Serum
  Powder", the answer `{serumPowder: iid}` exiles the hand and draws that many, logs it, and asks
  again. Companions: the deck's `companion` board travels as `EngineDeck.companions` -> Forge's
  sideboard; `Player.assignCompanion` offers it through `chooseSingleEntityForEffect`, which the
  bridge makes non-optional for the companion (Forge has no null check there; an unused revealed
  companion is harmless) and logs ("X reveals Y as their companion."). Colour identity of the
  companion is not checked (Forge does not either). None of these is answered by the AI unless the
  seat is absent or the prompt times out. Test: `PregameTest` (a real Match.startGame with a scripted
  human: Serum Powder, opening-hand prompt, Leyline, Gemstone with its luck counter, the Chancellor's
  first-upkeep Goblin, the companion).
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

## Deck statistics: game results, test games, closing tables (2026-10-19)

Owner request: track each deck's performance (overall, per table bracket and player count, head to head),
mark games as "Test" so they are not counted, treat every earlier game as a test game, and close tables
that never finished. Decisions (the parent session's, recorded here):

- **Table bracket** = a lobby setting (B1-B5) agreed before the game. Default: the highest suggested
  bracket among the seated decks (library decks: stored bracket; own decks: the analysis engine's
  suggestion; a bot's library copy: its library deck's bracket). The host may pick one until the game
  starts (`{t:"tableSettings", tableBracket}`; null = automatic); it is frozen at start.
- **Test game**: lobby toggle, off by default, host-editable until start (`{t:"tableSettings", testGame}`),
  shown to everyone (`RoomInfo.testGame`), tagged "Test" in Recent tables.
- **Counted** only when: an engine game, not a test game, and Forge reported a result (a winner, or
  Forge's own draw). A concede is a loss for that seat. A table closed without a finish is
  "abandoned" (recorded, never counted); an engine failure with no outcome is "abandoned" too.
- **Frozen per seat at start**: the user (or bot user, `is_bot`), the deck reference (own deck id, or
  `library:<id>`; a bot's copy of a library deck is recorded as the library deck), deck name and
  commanders as text (history survives deletions), the deck's bracket at that moment, seat count, table
  bracket. Personal decks carry `deck_owner_id` (their stats are visible only to that owner); library
  decks have none (aggregated across everyone).

**Data** (migration 0011): `rooms.test_game`, `rooms.table_bracket`; `game_results` (id = room id,
room code, started/ended, table bracket, player count, test, counted, end_reason win|draw|abandoned,
detail = Forge's end reason or why it was closed, turns) and `game_result_seats` (seat, user id, is_bot,
deck_ref, deck_owner_id, deck_name, commanders, deck_bracket, place, won, conceded). The migration marks
EVERY existing room `test_game = 1` and backfills a `game_results` row (test, never counted) for every
room that had started. Written only by the engine relay (`server/src/stats/results.ts` `GameResults`:
`recordStart` in `EngineTable.start`, `recordFinish` on the engine's `gameOver`, `abandon` on close or
an engine restart); the classic table never writes results.

**Places from Forge.** The engine's `gameOver` frame now carries `results` per seat
(`GameSession.results()`): place 1 = the winner, then in reverse order of elimination (seats out
together share a place; `GameSession.noteEliminations` watches `Player.hasLost()` on every game event),
`won`, `conceded`, `lossReason`. A draw leaves every seat still in at place 1, none won. Engine test:
`GameResultsTest` (a real game: the human concedes, Forge's AI wins). Note: a concede only takes effect
at the seat's next priority (Forge asks pregame questions first).

**Closing tables (no result recorded).** `LiveRoom.closeTable(reason)`: an engine game is torn down
(`EngineTable.close`: endGame to the engine, the room ends at once with an EngineGameOver line, the
result is "abandoned"; the engine's later draw frame is ignored); a lobby just ends. Who: the host
("End table" in the lobby, `{t:"endTable"}`, or `POST /api/rooms/:code/end` from Recent tables; the
owner may too), the owner from Admin -> Open tables (`GET /api/admin/tables`,
`POST /api/admin/tables/:code/close`, `POST /api/admin/tables/close-idle {hours: 24}`), and the server
itself: `RoomManager.startIdleSweep` closes tables idle for `TABLE_IDLE_CLOSE_HOURS` (48) one minute
after boot and hourly. For operations, `GET /api/admin/machine/open-tables` and
`POST /api/admin/machine/close-idle-tables {hours}` answer loopback (fly ssh) or `x-admin-token`.
Tests: engine.test (counted win with places and a concede, test game not counted, End table + late
draw ignored, idle close), `stats/backfill.test.ts`, deckOptions.test (owner-only admin close, host end).

**Stats views (part 2).** Pure arithmetic in `shared/src/deckStats.ts` (`deckPerformance`,
`bracketHint`, `gamesInScope`), rows loaded by `server/src/routes/deckStats.ts` from COUNTED games
only. `GET /api/deck-stats[?bots=0]` lists the caller's own decks (by `deck_owner_id`) and the library
decks they have played; `GET /api/deck-stats/deck/:ref[?bots=0]` (own deck id or `library:<id>`)
returns overall (games, wins, win rate, average place, concedes), the grid of OPPONENTS' bracket B1-B5 by
player count 2/3/4 (wins/games, win rate, `lowSample` under 5 games), a hint and head-to-head (per
opposing deck: games together, this deck won, lost to it, placed above it; once per game even when
two opponents played the same deck). Privacy: a personal deck's numbers answer only its owner (404 for
anyone else, so its existence is not confirmed); library decks aggregate every player's games and are
open to every signed-in player. "Include games vs bots" (default on) off = any game that had a bot
seat is left out. **Opponents' bracket (2026-10-20, owner report):** the automatic table bracket is the
highest seated deck, so a B4 deck's games all landed in the B4 row even against B2 bots. A grid row is now
`opponentBracket` (shared `opponentBracket` / `withOpponentBrackets`, computed at read time from
`game_result_seats.deck_bracket`, so every past game re-sorts with no migration): the most common deck
bracket among the OTHER seats, ties to the higher bracket (a record is never flattered), seats without a
bracket ignored, none at all = the stored table bracket. The stored `table_bracket` itself is unchanged.
The hint is an indication, never a verdict: with at least 5 games against opponents above
the deck's own bracket and wins >= 1.5x an even share (1 / players per game) it says the deck "may
play stronger than its bracket"; with 5+ games at its bracket or below and wins <= 0.5x an even share,
"may play weaker". UI: `client/src/components/PerformancePanel.tsx` on the deck page and the library
deck page ("Performance (all players)"), and the Deck stats page `/stats` (nav "Stats",
`DeckStatsPage.tsx`: sortable table, tap a deck for its panel). Tests: `shared/src/deckStats.test.ts`
(grid by players and brackets, head-to-head, bots toggle, hint), `routes/deckStats.test.ts` (test and
abandoned games excluded, personal-deck privacy, library aggregation).

## Players page (2026-10-28)

Owner request: "a section that shows people who are signed up", with each player's deck count, average bracket,
decks per bracket and performance, so players can see who tends to play at their level before inviting them (no
B4 regular at a B2 table). Code: pure `shared/src/players.ts` (`playerSummaries`, `playerDetail`, `bracketCounts`,
`performanceOf`, `matchWith`), `server/src/routes/players.ts`, `client/src/pages/PlayersPage.tsx` (nav "Players",
`/players`), styles at the end of `pages.css`.

- **Who is listed**: every non-bot user with an account, plus device-only profiles with a deck or a counted game,
  minus anyone with `UserSettings.hideFromPlayers` (profile page: "Show me on the Players page", on by default). A
  hidden player still sees their own card, marked hidden; anyone else gets 404 for them, including friend requests.
- **Card**: deck count, average bracket (one decimal), one column per bracket B1-B5 (unrated decks counted apart),
  "Plays at" = the most common OPPONENTS' bracket in their counted games (`withOpponentBrackets`, ties to the
  higher), else their most common deck bracket; record = wins / counted games, performance = wins over an even
  share (1 / players per game): strong >= 1.25x, below <= 0.75x, else even, "few games" under 5. Deck brackets
  are the analysis engine's suggestion (`DeckBrackets.ownDeck`, cached per deck version).
- **Match with my decks** (`matchWith`): "Good match: you have 2 B3 decks" when I own a deck at their level,
  else "Plays around B4; your highest deck is B2" / lowest / nearest; filter chips Everyone / Good matches /
  Friends / Online now, and a name search.
- **Detail** (tap a card): decks as commanders + bracket only (deck names and lists never leave the server; tests
  check the payload), record by opponents' bracket with the even-share ratio, by table size, the last ten counted
  games, and Add friend (`POST /api/players/:id/friend-request`, `SocialService.requestUser`: same rules as a
  friend code; answering a crossed request accepts it). Friends are then invited from the lobby as before.
- Tests: `shared/src/players.test.ts`, `server/src/routes/players.test.ts`. Checked in a browser against a copy
  of the local dev database with seeded games at 1280 wide, 375x812 and 812x375 (cards, detail scrolling,
  Add friend, the profile switch).

## Voice on Discord (2026-10-19)

The owner chose "a CGwF bot that creates a temporary voice channel per table" (option 2 of 3). Code:
`server/src/discord/` (`client.ts` REST client, `voice.ts` service), `shared/src/discord.ts` (types and
`normaliseInvite`), `client/src/game/Voice.tsx` (lobby panel, table headphone button, Personalize
default), `client/src/pages/DiscordStatusCard.tsx` (Admin). Tests: `server/src/discord/voice.test.ts`
against an in-memory fake Discord.

- **Secrets** (Fly app `cgwf`, never printed, never in the repo): `DISCORD_BOT_TOKEN`,
  `DISCORD_GUILD_ID` (the owner's server), `DISCORD_CATEGORY_ID` (the "CGwF Tables" category). All three
  set = on; none = off (manual links only); some = off with "X is not set" on the Admin page.
- **Bot permissions** on the category: View Channels, Manage Channels, Create Instant Invite, Connect.
  No gateway connection and no privileged intents: REST only (`https://discord.com/api/v10`,
  `Authorization: Bot <token>`, `User-Agent: DiscordBot (https://cgwf.fly.dev, 1.0)`). The client honours
  per-route `X-RateLimit-Remaining/Reset-After` buckets and 429 `retry_after` (global too; at most 3
  retries, never a wait over 15 s), times out each call at 8 s, and never blocks a table: every call is
  queued per room and fire-and-forget; a failure is logged and the table shows "voice unavailable".
- **Boot check** (`DiscordVoice.verify`): GET /users/@me, /guilds/{id}, /guilds/{id}/channels, the bot's
  member roles; the category must exist in that guild, be a category (type 4), and the bot's effective
  permissions on it (Discord's algorithm: roles, @everyone and category overwrites; `effectivePermissions`)
  must include the four above. Admin page: "Discord: connected as <bot> / category <name>" or the exact
  problem naming the secret or permission; "Check again" re-runs it (`POST /api/admin/discord/check`).
- **Lifecycle.** Table created (lobby) -> voice channel (type 2) "CGwF · <code>" under the category,
  `user_limit` `VOICE_USER_LIMIT` = 5 (4 players + 1 spectator), invite `max_age 0, max_uses 0,
  unique true`; stored in `rooms.voice_channel_id` / `voice_invite_url` (migration 0013). Closed by the
  host or owner, or auto-closed after 48 h idle (`LiveRoom.closeTable`) -> deleted at once. A game that
  ends on its own keeps its channel for `VOICE_REMATCH_GRACE_MS` (15 min) so the table can talk and
  rematch, then it is deleted; a rematch takes over the same channel (renamed to the new code), a
  reverted ending keeps it. Orphan sweep at boot and hourly: CGwF-named voice channels under the category
  whose table is not open (past the grace) are deleted; nothing else in the server is ever touched.
- **Who sees the invite.** `RoomInfo.voice` is filled only for members of that table (players and
  spectators: `room_members`); everyone else, `/api/rooms/mine`, logs and other tables get nothing.
- **Manual fallback.** When the bot is off or failed for a table, the host pastes an invite
  (`{t:"voiceLink", url}`; `normaliseInvite` accepts only discord.gg/ and discord.com/invite/, stored as
  `https://discord.gg/<code>` in `rooms.voice_manual_url`). `UserSettings.discordInvite` (lobby checkbox
  "Use for every table I host", or Personalize -> Voice on Discord) fills new tables the host opens; a
  rematch carries the manual link over.
- **UI.** Lobby: "Join voice on Discord" (new tab; on phones the Discord app), or "Setting up..." /
  "unavailable" with the host's paste field. Table: a 44 px headphone button beside the Menu in the turn
  bar (`.voice-btn`, `a[aria-label='Join voice on Discord']`, also in `layoutCheck`'s control list);
  `cgwfLayoutCheck()` returned [] at 812x375 and 375x812 with it present.

## AI Coach (2026-10-19, owner only)

The owner wants an AI to review games they lost (and won) and say where better plays were available.
Two milestones; M1 records what M2 needs, with no model spend.

**M1: decision snapshots** (`server/src/coach/snapshots.ts`, table `decision_snapshots`, migration
0015). On engine tables, every prompt a HUMAN seat answers (`EngineTable.answer`) is recorded with that
seat's OWN view at that moment, built only from the prompt frame the engine sent that seat (the view the
engine's hidden-information audit already covers) and trimmed again by `buildSnapshot`: round / turn /
phase / active seat, the prompt kind, title and option labels, the answer (raw + chosen labels), the
seat's own hand / mana pool / lands played, every player's public zones (battlefield with tapped / sick /
P/T / counters / damage / attachments, graveyard, exile with another player's face-down cards unnamed,
command zone), life, poison, commander damage, hand and library COUNTS only, the stack and combat. The
builder copies named hands only for the seat itself and never reads a library list, so even a leaky
engine frame cannot put another hand or a library into a snapshot (tested with one).
- Skipped: a pass when nothing was offered; the same pass again (same turn, step, options, stack depth)
  is collapsed. Bots (Forge AI seats) answer nothing here, so they record nothing.
- Storage: gzip JSON blob per decision, `room_id` = `game_results.id` (no FK: a snapshot can precede the
  result row), seat, user id, relay seq, turn, prompt kind. Size budget: ~1-3 KB JSON (~0.5-1 KB
  stored) per decision, at most 2000 per seat per game, so a game stays well under 1 MB.
- Never slows a prompt or fails a game: built in try/catch, compressed with async `zlib.gzip`, inserted
  in the callback, errors logged. `DecisionRecorder.flush()` for tests.
- Reading: `GET /api/rooms/:code/decisions` returns only the caller's own snapshots (any other seat
  gets an empty list); M2 reads the owner's through the same `forUser`.
- Retention: 90 days (`SNAPSHOT_RETENTION_DAYS`), cleaned 90 s after boot and daily.
- Tests: `coach/snapshots.test.ts` (own hand only, no other hand / library / face-down names; retention),
  engine.test "records a decision snapshot ..." (real relay path, a leaky frame, collapsed passes,
  another seat reads nothing).

**M2: the coach** (OWNER ONLY: `requireUser` + `requireOwner`, and `COACH_AI_ENABLED=1` with
`ANTHROPIC_API_KEY`; otherwise every `/api/coach/*` route answers 404 and the client shows nothing,
`useCoachEnabled` asks `/api/coach/status`). Code: `server/src/coach/{llm,context,coach}.ts`,
`server/src/routes/coach.ts`, `client/src/coach/`, `client/src/pages/CoachPage.tsx`, tables
`coach_reports` / `coach_followups` (migration 0017).
- **Model:** `claude-opus-5-5` (`COACH_MODEL`), the claude-api skill's default and strongest generally
  priced Opus-class model: a game review is deep, multi-step reasoning and a report is a handful of
  calls. Adaptive thinking (always on for this model), effort `high` for the report, `medium` for
  follow-ups; server-side refusal fallbacks (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`); structured output (`output_config.format` JSON schema
  `REPORT_SCHEMA`: summary, 3-6 turning points with round / turn / had / chose / betterLine / why /
  theme / cards, three habits, a hidden-information note); one strict custom tool `card_text(name)`
  (oracle text from the local card data). Prompt caching: the system prompt and the big game record
  carry `cache_control`, so the tool loop and follow-ups re-read them at the cache price.
- **What the model sees** (`buildCoachGame`): seats, decks, places; the owner's decklist with mana cost,
  type and oracle text, plus the primer (library deck, or the library copy of an own deck); the
  opponents' cards only as they appeared in public zones; the public log (step lines dropped, capped
  60k chars); the owner's decision snapshots rendered as text (full boards once per turn, hand / stack /
  floating mana / options / choice every decision; capped 160k chars keeping the start and the end).
  Games without snapshots get a LIGHT review (log + the owner's raw EngineAnswer rows), labelled in the
  prompt and on the page. The system prompt requires conditional phrasing about hidden information.
- **Flow:** "Coach me" (game-over overlay on engine tables, Recent tables for ended engine tables, the
  Deck stats page's AI Coach panel listing finished games losses first) -> `/coach/:code` ->
  `POST /api/coach/rooms/:code` starts a background report (polled every 4 s), cached per game and
  player (`coach_reports` unique room + user; an errored one may be retried; a done one is never
  regenerated). "Ask a follow-up": one question at a time (`POST .../followup`), answered in the
  background with the report and the last five Q&As as context. Card names in turning points open the
  card.
- **Spend control:** every call's usage (summing `usage.iterations` when a fallback ran) is priced
  ($4 in / $20 out / $5 cache write / $0.20 cache read per MTok) and stored on the report or follow-up;
  a report stops as "capped" past `COACH_MAX_USD_PER_REPORT` ($4) or `COACH_MAX_TOKENS_PER_REPORT`
  (600k input+output tokens) and after 8 calls (follow-ups: 4); nothing new starts once today's coach
  spend (UTC day, reports + follow-ups) reaches `COACH_MAX_USD_PER_DAY` ($20), a cap SEPARATE from the
  agents' daily cap. Admin page: "AI Coach" line + per-report tokens and dollars (`GET /api/admin/coach`).
- Tests: `coach/coach.test.ts` with `ScriptedCoachLlm` (no network): owner only (403 for others, 404
  when off), the prompt carries the owner's hand and public cards but not an opponent's hand, the
  card_text tool, structured report stored and priced, cached (no second call), follow-up counted, light
  review label, per-report cap, daily cap.

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
