# CGwF rules engine on Forge: design for Stages 1-4

Status (2026-10-17): Stage 0 spike done; Stage 1 M1 (control protocol, relay, CI), M2 (engine
tables playable in the app) and M3 (four seats, saved stops, lobby legality hints, absent-seat
grace, resync) and M4 (Forge AI bot seats through the Phase 7 lobby box, no model) are merged and
live; Stage 1 is complete. Stage 2 M1 (2026-10-18) wired the remaining common prompt kinds
(section 3.3: confirm incl. unless-costs and optional triggers, number, order, assign, mode, text,
spell targets, cost card choices) and moved casting onto Forge's own human play flow; mana payment
stays automatic until the owner picks a manual-mana design. Stage 2 M2 put the stack on screen
(stack items carry kind, printing and targets; Stack panel + Interaction Stack window), M3 made
the step dots stop toggles with auto-pass-when-nothing and a one-turn Hold, and M4 added the
Active Board overlay (left edge, follows the turn) and the Game Log panel (right third, tappable
card names, toasts when minimised). M5 added manual mana in the owner's option 1: payment stays automatic, a long-press "Pay with"
picker names the sources to tap first (their mana goes to the pool, the payer finishes). This document is the plan;
where the code differs from the plan the code wins and CLAUDE.md "Rules engine tables" describes
it. The spike's measurements and go/no-go are in [`engine/README.md`](../engine/README.md).

## 0. The one-paragraph version

CGwF keeps everything it has (accounts, decks, rooms, the React table, Scryfall images, the
visual style). A second, separate service written in Java (`engine/`, Fly app `cgwf-engine`)
runs the open-source Forge rules engine headless. The CGwF server opens one WebSocket per game to
the engine and relays per-seat JSON frames to the players' existing room sockets. Forge decides
what is legal, moves cards, resolves the stack, runs combat and ends the game; humans answer
prompts ("you have priority", "declare attackers", "choose a target"); bot seats are Forge's own
AI, which replaces the Sonnet agents for engine games. Hidden information is enforced twice: the
engine's per-seat view never contains hidden cards (proved by a permanent test), and the CGwF
relay only forwards a seat's own frames to that seat's sockets.

## 1. Why this shape (and the two we rejected)

| Option | What it means | Why not |
| --- | --- | --- |
| **1. Own headless Forge service (chosen)** | Java service under our control, JSON protocol we design, our UI | Two services to run; Java toolchain; we own the bridge code (~3-5k lines) |
| 2. Manabrew as a whole | Their AGPL React client + relay + harness | AGPL would pull our whole app under it; their UI replaces ours; their protocol is theirs to change |
| 3. Forge's built-in network play | Run Forge's own lobby/server (`forge-gui/.../net`) and write a client for its ~71-call GUI protocol | The protocol is a remote Swing GUI (buttons, highlights, "select card"), Java-serialised objects over Netty; it is marked experimental and shaped for a desktop client, not a phone PWA |

Option 1 reuses the idea of Manabrew's harness (drive Forge through its `PlayerController`
seam) without any of its code. The spike confirmed the seam is enough: ~110 decision methods,
all overridable, with a working AI implementation to fall back on for anything not yet modelled.

## 2. Architecture

```
 phone/browser ──wss──► CGwF server (Fastify, app "cgwf")  ──ws (Fly private network)──► cgwf-engine (Java)
   React table           rooms, auth, decks, images,                                      Forge game threads,
                         relay + card-id mapping,                                         per-seat views,
                         event log persistence                                            Forge AI seats
```

- **The browser never talks to the engine.** It keeps `GET /api/rooms/:code/ws?token=...`.
  `LiveRoom` gains an "engine mode": instead of reducing events itself it relays.
- **One engine socket per game**, multiplexing seats (`seat` field on every frame). Fewer
  sockets, one place to reconnect.
- **The engine is stateless across restarts** (games live in RAM) and keeps no secrets but the
  shared service token. The CGwF server persists the log and the result.
- **Fly:** `cgwf-engine` is a separate app (own Dockerfile, own scaling, own rollbacks) in `lax`
  next to `cgwf`. Stage 1 reaches it over Fly's private network (`cgwf-engine.internal:8081`)
  so no public port is needed; a token guards it anyway (`ENGINE_TOKEN`, a secret on both apps).
- **Licensing:** `engine/` is GPL-3.0 (it links forge-game) with a NOTICE crediting Forge; the
  TypeScript app talks to it over a socket and keeps its own licence. Forge is cloned at a pinned
  tag during the image build and is not vendored.

## 3. Protocol

JSON text frames. Every frame has `type`. Frames between CGwF and the engine carry `gameId`
and, where seat-specific, `seat` (0-3, the engine's seat index) so one socket serves a table.
Frames between CGwF and a browser carry no `gameId` (the room socket already scopes it).

### 3.1 Control (CGwF server -> engine)

| Frame | Fields | Notes |
| --- | --- | --- |
| `createGame` | `gameId`, `seed`, `seats: [{seat, kind: "human" \| "ai", name, deck, aiProfile?}]`, `rules: {format: "commander", startingLife: 40}` | `deck` is the JSON shape in 5. The engine answers `gameCreated {gameId, cardMap}` (6.2) or `error`. |
| `createGame` `openingHand` | `{mode: "draw7" \| "draw10", freeMulligans: 0-2}` (2026-10-20) | Draw 7: Forge's London MulliganService with the table's free mulligans (the bottom count goes through `tuckCardsViaMulligan`). Draw 10: Forge's starting hand size 10, then every player puts three back into the library at once (shuffled), no mulligans. Absent: Forge's own rule. |
| `beginGame` | `gameId`, `startingSeat?` | Only after `createGame {deferStart: true}` (2026-10-19): the table rolled a D20 (or picked at random) for who goes first; the engine fixes that seat as Forge's starting player and starts the game (mulligans next). `createGame` may also carry `startingSeat` directly. |
| `attachSeat` / `detachSeat` | `gameId`, `seat` | Tells the engine a human is connected / gone (for autopilot timers, 7). |
| `resync` | `gameId`, `seat` | Engine re-sends `state` for that seat and the open `prompt` if any. |
| `setStops` | `gameId`, `seat`, `stops: {...}` (10) | Server-side auto-pass. |
| `answer` | `gameId`, `seat`, `promptId`, + prompt-specific fields | Forwarded from the browser after validation of shape only; the engine validates meaning. |
| `concede` | `gameId`, `seat` | Takes effect at the seat's next decision point. |
| `endGame` | `gameId` | Host ended the room; engine drops the game. |
| `ping` | | `pong` |

### 3.2 Engine -> CGwF server (per seat unless noted)

| Frame | Fields |
| --- | --- |
| `state` | the per-seat view (4) |
| `prompt` | `promptId`, `prompt` (kind, 3.3), `title`, `view`, kind-specific fields; exactly one open prompt per seat at a time |
| `notice` | `kind: reveal \| info`, `title`, `text?`, `cards[]` (identities revealed to this seat), `source[]?`; no answer expected (built 2026-10-18, 16.3) |
| `log` | `seq`, `turn`, `type`, `text`, `cardIds?` (all seats; 8) |
| `gameOver` | `winner`, `endReason`, final `view` (all seats) |
| `error` | `message`, `promptId?` |

### 3.3 Prompt kinds (the full set Forge needs for Commander)

Forge's `PlayerController` has ~110 decision methods. They collapse onto fourteen wire shapes.
The answer always echoes `promptId`. "Spike" marks what Stage 0 already implements.

| Kind | Forge methods covered | Prompt fields | Answer | Stage |
| --- | --- | --- | --- | --- |
| `priority` | `chooseSpellAbilityToPlay` | `options[] {index, cardId, cardName, zone, kind: land\|spell\|ability, description, cost, targets}`, `canPass`, `stackEmpty`, `phase` | `{option}` or `{option: null}` = pass, or `{concede: true}` | Spike |
| `targets` | `chooseTargetsFor`, `chooseNewTargetsFor`, `chooseTarget` (redirect) | `ability`, `min`, `max`, `options[] {index, kind: card\|player, ...card}`, `divided?: {total}` | `{options: [index...]}`, with `{amounts: {index: n}}` when divided | Spike (no divided) |
| `pay` | `payManaCost`, `applyManaToCost`, `chooseManaFromPool`, `specifyManaCombo`, `chooseCardsForConvokeOrImprovise`, `chooseCardsToDelve`, `helpPayForAssistPayment` | `cost` (remaining shards), `sources[] {cardId, abilityIndex, produces}`, `pool`, `auto: bool` | `{auto: true}` or `{source: {cardId, abilityIndex}}` repeated until paid, `{cancel: true}` | Stage 2 (spike pays automatically via the AI) |
| `assign` | `assignCombatDamage`, `divideShield`, `assignGenericAmount`, `orderBlockers`, `orderAttackers`, `orderBlocker` | `source`, `total`, `targets[] {kind, id, min, lethal?}` | `{amounts: {id: n}}` or `{order: [id...]}` | Stage 2 |
| `choose` | `chooseSingleEntityForEffect`, `chooseSingleSpellForEffect`, `chooseSingleCardForZoneChange`, `chooseSingleReplacementEffect`, `chooseSingleStaticAbility`, `chooseCounterType`, `chooseProtectionType`, `chooseKeywordForPump`, `chooseSingleCardFace`, `chooseSingleCardState`, `chooseStartingPlayer`, `chooseSector`, `chooseSprocket`, `chooseRollToIgnore`, `chooseRollToModify`, `chooseRollToSwap`, `choosePDRollToIgnore`, `vote`, `chooseFlipResult`, `chooseCardsPile` | `options[] {index, kind: card\|player\|text, ...}`, `optional`, `source` | `{option}` / `{option: null}` | Spike (entities) |
| `chooseMany` | `chooseEntitiesForEffect`, `chooseCardsForEffect`, `chooseCardsForEffectMultiple`, `chooseCardsForZoneChange`, `chooseCardsToDiscardFrom`, `chooseCardsToDiscardUnlessType`, `chooseCardsToDiscardToMaximumHandSize`, `chooseCardsToRevealFromHand`, `chooseCardsForCost`, `choosePermanentsToSacrifice`, `choosePermanentsToDestroy`, `chooseSpellAbilitiesForEffect`, `chooseModeForAbility` (modes), `chooseOptionalCosts`, `chooseSaToActivateFromOpeningHand`, `exertAttackers`, `enlistAttackers`, `chooseContraptionsToCrank`, `chooseDiceToReroll`, `chooseColors`, `tuckCardsViaMulligan` | `options[]`, `min`, `max`, `source`, `grouped?` (for multiple-list variants) | `{options: [index...]}` | Spike |
| `order` | `orderMoveToZoneList`, `orderSimultaneousSa`, `orderAndPlaySimultaneousSa` (trigger order), `arrangeForScry`, `arrangeForSurveil`, `orderCosts`, `willPutCardOnTop` | `items[]`, `buckets: ["top","bottom"]` or `["graveyard","top"]` or none (pure order) | `{order: [index...], bucket: {index: name}}` | Stage 2 |
| `number` | `chooseNumber` (both), `chooseNumberForCostReduction`, `chooseNumberForKeywordCost`, `announceRequirements` (X), `chooseRollSwapValue` | `min`, `max`, `values?[]`, `title` | `{value}` | Stage 2 |
| `text` | `chooseCardName`, `chooseSomeType`, `chooseColor`, `chooseColorAllowColorless` | `options?[]` (types, colours) or `freeText: true` with a server-side name validator | `{text}` | Stage 2 |
| `confirm` | `confirmAction`, `confirmBidAction`, `confirmReplacementEffect`, `confirmStaticApplication`, `confirmTrigger` (optional triggers), `confirmPayment`, `payCostToPreventEffect`, `payCostDuringRoll`, `payCombatCost`, `chooseBinary`, `mulliganKeepHand` is its own kind below | `message`, `options: [yesLabel, noLabel]`, `card?`, `mode` | `{confirm: bool}` | Spike |
| `mulligan` | `mulliganKeepHand` + `tuckCardsViaMulligan` (as `chooseMany`) | `hand[]`, `cardsToReturn`, `mulligansTaken` | `{keep: bool}` | Spike |
| `attackers` | `declareAttackers` (+ exert/enlist via `chooseMany` follow-ups) | `candidates[] {...card, canAttack: [entityRef]}`, `defenders[] {kind, id, name, life}`, `requirements` (must-attack text) | `{attacks: [{cardId, defender: {kind, id}}]}` | Spike |
| `blockers` | `declareBlockers` | `attackers[] {...card, attacking}`, `blockers[] {...card, canBlock: [attackerId]}`, `requirements` | `{blocks: [{blockerId, attackerId}]}` (several blocks per blocker allowed when legal) | Spike |
| `mode` | `chooseModeForAbility` when `allowRepeat` or ordered modes matter (Charm/escalate/spree) | `modes[] {index, text}`, `min`, `max`, `allowRepeat` | `{modes: [index...]}` | Stage 2 |

Informational calls (`reveal`, `notifyOfValue`, `revealAnte`, `revealAISkipCards`, `revealUnsupported`,
`tempShowCards`) become `notice` frames; nothing to answer. `sideboard`, `chooseCardsYouWonToAddToDeck`,
`chooseStartingHand` (Vanguard), `cheatShuffle` are not used in Commander and stay on the AI default.

**Validation.** The engine never trusts an index blindly: an out-of-range or illegal answer gets
`error {promptId}` and the same prompt again (Forge's priority loop makes "ask again without
passing" free: return an empty list). A seat that answers nothing for `promptTimeoutMs`
(default 10 min) gets the AI's answer for that one prompt and a `notice`.

### 3.4 Visibility rule for prompts

Prompt option lists may legitimately contain cards the seat cannot otherwise see (a tutor shows
you your library). That is Forge's call, made per effect, and matches paper. The rule is: an
option list goes ONLY to the seat being asked; the `state` view never includes those cards; the
relay never forwards one seat's `prompt` to another socket. Stage 1 adds the prompt frames to the
hidden-information audit (every prompt's `view` is checked like a `state`).

## 4. The per-seat view and CGwF card ids

The spike's `SeatView` (Java) is the only serialiser. Shape (Stage 1 keeps it, adds `seq`):

```
{ type: "state", seq, turn, phase, activePlayer, priorityPlayer, viewer, gameOver, winner?, endReason?,
  players: [{ id, name, isYou, human, life, poison, lost, handCount, libraryCount, landsPlayedThisTurn,
              commanderDamage: {commanderCardId: n}, manaPool?: {W,U,B,R,G,C},
              hand?: [card]   // only for the viewer
              battlefield: [card], graveyard: [card], exile: [card], command: [card] }],
  stack: [{ id, description, sourceCardId, sourceName, activatingPlayer }],   // top first
  combat: { attackingPlayer, attackers: [{ cardId, defender: {kind,id}, blockedBy: [cardId] }] } | null,
  log: [{ type, text }] }

card = { id, zone, controller, owner, tapped, faceDown, token, commander?, damage?, sick?, attachedTo?, counters?,
         // identity, present only when the viewer may see the face:
         name, set, scryfallSet, number, types, manaCost?, power?, toughness? }
```

Rules baked into the serialiser: libraries are a count; other hands are a count; a face-down
permanent or face-down exiled card is an object with an id and no identity unless Forge's
`CardView.canBeShownTo(viewer)` says otherwise; spectators (`viewer: null`) see public zones only.

**Mapping to CGwF printings.** Forge identifies a printing by name + its edition code + collector
number; Forge's edition files carry Scryfall's set code (`ScryfallCode`) and the engine emits it
as `scryfallSet`. In the spike's four precons 358 of 360 distinct cards resolved to the exact
printing CGwF holds (the two others by name). The CGwF relay resolves each `(scryfallSet,
number)` to `cards.id` once per game (cache keyed by engine card id, since a card's printing never
changes mid-game), falling back to `NameIndex` best printing by name (front face for split/MDFC
names "A // B"), and for tokens to the token catalogue by name + P/T (`distinctTokens`). The
browser then receives today's `{view, printings}` shape with `printingId` on every visible card,
so the image proxy, zoom, sleeves and every component keep working. Unmappable cards (should be
none; Forge-only promos) get `printingId: null` plus `name`, drawn as a text card.

**What changes in the client's PlayerView.** Engine games add `stack`, `priority`, `phase` (Forge
steps), `combat`, and per-card `sick`/`damage`/`attachedTo`; they drop the free-form sections
(`zone.row`) in favour of type-derived rows (`sections.ts` already does this) and drop the
manual bookkeeping events (anthems, triggers, mana bank) because the engine computes them.

## 5. Deck conversion

CGwF deck (`decks` + `deck_cards`) -> engine deck JSON (exactly the spike's `engine/spike/decks/*.json`):

```
{ name, commanders: [{name, setCode, number, scryfallId, count}], main: [...] }
```

- `commanders` = the deck's `commander` board (one card, or two with Partner / Partner with /
  Friends forever / Background / Doctor's companion; Forge handles all of these from the
  Commander section). Companion and sideboard are out of scope for v1.
- Colour identity, singleton, 100 cards: CGwF's existing warnings become **blocking** for engine
  games (Forge does not check deck legality at game start; it would simply play an illegal deck).
- Resolution on the engine: exact set + number, then set, then name; the engine reports
  `{resolved, byName, missing}` in `gameCreated` and CGwF refuses to start when anything is
  missing (lists the names). Forge covers ~30k cards; the gap is newest-set cards for a few weeks
  and some Un-cards. Bumping Forge = changing one tag in `pom.xml` + `Dockerfile` and redeploying.

## 6. Game lifecycle, reconnect and resync

6.1 **Start.** Host presses Start in a room with "Rules engine" on -> CGwF builds the deck JSON
for every seated player, picks Forge AI for bot seats, sends `createGame` with the room's seed
(deterministic shuffles) -> engine replies `gameCreated` -> CGwF marks the room `playing` and
each connected socket gets its first `state`.

6.2 **Card map.** `gameCreated` carries `cardMap: [{cardId, name, scryfallSet, number}]` for
every physical card in every deck (ids are stable for the game; tokens come later through the
view). CGwF resolves printings up front and stores the map with the room (`rooms.engine_state`
JSON) so a server restart does not need the engine again to render.

6.3 **Reconnect (browser).** Same as today: a new socket calls `room.attach` -> in engine mode
CGwF sends `resync {gameId, seat}` -> engine answers `state` + the open `prompt` for that seat
(prompts have stable ids and the engine keeps the open one per seat). Nothing is kept client-side.

6.4 **Reconnect (CGwF <-> engine socket).** CGwF reconnects with backoff; on reconnect it sends
`resync` for every seat. Games keep running inside the engine meanwhile (humans just see
"reconnecting..."; timers in 7 do not start until the seat is detached for real).

6.5 **Engine restart = games lost.** Forge has no save-game for a running match. Mitigations,
in order: (a) the engine process exposes `GET /health {activeGames}` and deploys are gated on
zero active games (a tiny script, Stage 3); (b) `min_machines_running = 1` and
`auto_stop_machines = "off"` whenever a game is live (Stage 1 keeps the machine always on; cost
~$31/month for performance-1x 2 GB, ~$6-12 for shared-cpu-2x; Stage 3 can scale to zero when idle through the Fly Machines
API from CGwF); (c) CGwF detects a dead game (engine says `unknown gameId` on resync) and shows
"the table was lost; here is the log; rematch?" instead of hanging.

## 7. Absent players

- A detached human seat keeps the game waiting for `absentGraceMs` (default 3 min, host-configurable
  1-10). Then the engine switches that seat to **autopilot** (Forge AI answers its prompts) until
  the player is back; every autopilot decision is logged ("Autopilot passed priority for Blair").
  This is what the spike already does on disconnect, minus the grace period.
- Concede works at any time; the seat becomes a spectator view.
- A table where every human left for 30 min ends as a draw and is logged.

## 8. Game log and persistence

- The engine streams Forge's `GameLog` entries as `log {seq, turn, type, text, cardIds}` with
  the engine's own sequence number. CGwF appends each as a `room_events` row of type
  `EngineLog` (actor = engine), so the existing log panel, turn separators and the admin stats
  ("games started") keep working. Hidden cards are never named in Forge's log (it says "a card").
- Decisions by humans (`answer` frames) are also appended as `EngineAnswer` events: with the seed
  and the deck lists they are the replayable record of the game. Replay through the engine is a
  Stage 4 nicety, not needed for v1.
- `gameOver` writes the result onto the room (`rooms.status = ended`, winner, reason, turns).
- No undo in engine games (the engine is authoritative). Forge's own "undo last action" exists
  only for the acting player before anyone else gets priority; exposing it is a Stage 4 option.

## 9. Authentication and proxying

- Players authenticate exactly as today (device/session token on the room socket); seats are
  the room's `room_members.seat`. The CGwF server is the only thing that knows which socket is
  which seat, and it is the only thing that talks to the engine.
- CGwF -> engine: `Authorization: Bearer ${ENGINE_TOKEN}` on the WebSocket handshake; the engine
  refuses anything else. The engine listens on the Fly private network only (no `[[services]]`
  block once Stage 1 lands; the spike exposes a public port for the scripted client).
- Rate and size limits stay in Fastify (25 msgs/s, 256 KB) and apply to `answer` frames too.
- Spectators get `seat: null` views; the engine builds them with `viewer = null`.

## 10. Bot seats: Forge AI instead of Sonnet

Engine games do not use `server/src/agents/` at all: a bot seat is `kind: "ai"` with a Forge
profile (`Default`, `Cautious`, `Reckless`) and a deck from the owner's library
(`library.list({agentEligible: true})`, same picker as Phase 7). No model spend, no caps, no
reasoning drawer, instant decisions (the spike measured whole AI turns in well under a second).
The Sonnet agents stay available on the classic table (they cannot play on an engine table:
their tools are bookkeeping events). The "Claude commentator" idea (a model narrating an engine
game from the public log) is possible later because the log is clean text.

## 11. Auto-pass and stops (Arena-style)

The engine gives priority dozens of times per turn. Without help a human would tap "pass" all
day, so:

- **Server-side stops.** Each seat has a stop set, sent with `setStops` and remembered per
  player (`user_settings`): for my turn `{upkeep, draw, main1, beginCombat, declareAttackers,
  declareBlockers, damage, main2, end}`, for opponents' turns the same list. Defaults: my turn =
  main1, declareAttackers, main2, end; opponents' turns = declareBlockers (only when I am
  attacked), end step when the stack is non-empty. The engine's `priority` prompt is only sent
  when (a) the step is a stop, or (b) the stack is non-empty and the top object was not put there
  by me, or (c) the seat has a playable instant-speed action and the client asked for
  "stop when I can respond", or (d) the game needs a decision no matter what (targets, blocks...).
  Otherwise the engine passes for the seat without a round trip. This mirrors Forge's own
  `YieldController`/auto-yield and Arena's full control off.
- **Client overrides.** "Hold" (long-press pass) = stop at every priority for this turn.
  "Pass until end of turn" / "Pass until my next turn" = temporary empty stop set. "Full
  control" toggle = every priority + manual mana (`pay` prompts instead of auto-pay).
- **Auto-yield for triggers:** a `confirm` for an optional trigger can be answered "always yes /
  always no for this card this game" (the client remembers and answers; engine side stays dumb).
- **Timing UI:** the priority prompt includes `stackEmpty`, `phase`, `hasPlayable` and the list
  of my playable options so the UI can show "nothing to do" and a 2-second auto-pass countdown.

## 12. UI integration plan (CGwF client)

Stage 1 reuses the existing table (`client/src/game/Table.tsx`, sections, hand, zoom, log) and
adds an `EngineAdapter` that turns engine frames into the same `PlayerView` shape plus an
`EnginePrompt` overlay: pass/priority bar with phase strip and stops, a target picker (tap the
highlighted cards/players), an attack picker (tap creatures, then the opponent), a block picker,
a generic choice sheet reusing `ActionSheet`, the mulligan overlay reused. Cards that are legal
to play glow (from `priority.options`); tapping one answers the prompt (no action sheet needed
when the card has a single legal ability; the sheet lists them otherwise). Bookkeeping panels
(mana bank, triggers, anthems) hide in engine mode; the engine's `manaPool` shows in the pill.
`design-refresh` must have merged before this starts (that branch owns `client/` right now).

## 13. Rollout

| Stage | Scope | Done when | Effort |
| --- | --- | --- | --- |
| **1. Engine games alongside the classic table (beta)** | Engine: control protocol (3.1), `ENGINE_TOKEN`, seat multiplexing, stable `promptId` + resync, `cardMap`, `log` streaming, health. Server: `LiveRoom` engine mode, relay, printing mapping, `EngineLog`/`EngineAnswer` events, deck conversion + blocking legality, room option "Rules engine (beta)", Forge AI bot seats. Client: adapter + priority bar + target/attack/block pickers + choice sheet + mulligan; default stops. Audit extended to prompts; CI job builds the engine and runs the hidden-information test. | Four friends finish a real Commander game on phones with the engine, with Forge bots filling empty seats; no hidden-info test failures; classic table untouched. | 3-4 weeks |
| **2. Full prompt coverage and control** | `pay` (manual mana, full control), `assign` (damage order/assignment, divided damage), `order` (scry/surveil, trigger order, bottom/top), `number`, `text`, `mode`; auto-yield; "hold"/"pass until"; concede/leave flows; spectator view; error/again loop UX. | Every prompt kind in 3.3 has a UI; a session of 20 mixed precon games produces no "AI decided for you" notices. | 3 weeks |
| **3. Operations and resilience** | Absent-player grace + autopilot (7), deploy gating on active games, scale-to-zero when idle via Machines API, metrics (games, prompt latency, memory), Forge version bump procedure + smoke suite (the four precons must play to completion on each bump), log retention, rematch for engine games, admin view of live engine games. | A week of real use without a lost table that was not explained by an engine restart; Forge bump done once end to end. | 2 weeks |
| **4. Engine by default** | New rooms default to the engine; classic table stays as "Casual (no rules)"; reconcile features: personalization, token finder (engine tokens are Forge's), deck stats/bracket unaffected; optional Claude commentator; optional per-game replay from `EngineAnswer`. | Owner flips the default; classic remains selectable. | 1-2 weeks |

Total: roughly 9-11 weeks of focused work. The order inside Stage 1 should be: control protocol
+ relay first (so a human can play through the real CGwF socket with the spike's eight prompts
and the existing table), then the UI pickers, then bots and legality.

## 14. Risks (hit or foreseen) and how to handle them

- **Startup time.** Forge scans ~30k card scripts at boot (lazy parsing on). On this Windows
  box that took 147 s; on Linux it is expected to be well under a minute (measured on Fly, see
  README). Either way the engine must not scale to zero between games in Stage 1.
- **Memory.** Measured peak heap for a four-player AI game is 365-493 MB (RSS under 600 MB); the
  service runs a handful of games per machine in Stage 1 and a `maxGames` limit (default 4)
  returns `error {busy}` beyond it. 2 GB is sized for that; if real games show more, 4 GB is a
  config change.
- **CPU, the real constraint.** Forge's AI evaluates every candidate play at every priority pass.
  On Fly's `shared-cpu-2x` an AI-only game ran 26.6 s/turn (one 6-minute turn) against 3.8 s/turn
  on the dev box, and Forge's own per-decision timeout fired once (the AI passes when it does).
  Human tables are mostly idle, but bot seats need real CPU: Stage 1 sizes the machine by CPU
  (`performance-1x`, one dedicated vCPU, measured 6.0 s/turn on the same game, 5x faster than
  shared-cpu-2x; `performance-2x` needs 4 GB on Fly) and keeps the AI's timeout. The classic-table Sonnet agents never had this problem because the humans did the
  rules work.
- **The AI-fallback seam.** The spike's human controller extends the AI controller and so
  reports `isAI() == true`. Forge branches on that flag in ~15 places (sideboarding, a loop cap,
  "RemAIDecks" filtering, Camouflage). Stage 1 switches to extending `PlayerController` directly
  with an AI *delegate* for the not-yet-modelled methods and `isAI() == false`; the compiler
  lists every method to implement, so nothing can be missed.
- **Targets before casting.** Forge's AI path moves the spell to the stack before choosing
  targets and has no clean rollback when targeting fails. The spike chooses targets first, then
  casts; modal spells (Charm) choose modes inside the cast, so their sub-ability targets come
  from the AI in the spike. Stage 2 implements the `mode` prompt before targeting. Nothing is
  left stuck on the stack in either case.
- **Prompt leaks.** Forge's AI candidate list includes the top card of every library (for
  "play from the top" effects). The spike filters those unless the seat may see the card; the
  prompt audit in Stage 1 makes this a tested property.
- **Forge bugs/loops.** Rare infinite loops or exceptions inside card scripts end the game
  thread; the spike catches `Throwable`, reports `gameOver` with an error and logs it. Forge also
  has per-turn runaway caps (tokens, triggers) that end such games as a draw. A watchdog
  (`maxTurnSeconds`, default 10 min, then draw) is cheap insurance.
- **Keeping up with Forge.** Pin a tag; bump monthly; the smoke suite (four precons to
  completion + audit) gates the bump. Forge's API churns a little between versions (the spike
  already found `getCounters()` returning a Multiset); budget an hour per bump.
- **Windows dev loop.** JDK 21 + Maven 3.9 as portable zips work; Docker is not installed, so
  images build remotely on Fly (`--remote-only`, ~10 min because Forge is compiled each time).
  Caching Forge's build in a base image is a Stage 3 nicety.

## 15. What Stage 1 builds first

The control protocol and the relay: `createGame`/`attachSeat`/`answer`/`resync` on the engine,
`LiveRoom` engine mode in Fastify forwarding the spike's eight prompt kinds to the existing
browser socket, and printing mapping. That gives a human a playable (ugly) engine game through
the real app within the first week and surfaces every integration problem early; the pickers and
stops come after.

## 16. Inherited decisions (audit, 2026-10-18)

`BridgeController` extends Forge's `PlayerControllerAi`, so any `PlayerController` method it does not
override is answered by Forge's AI for the human seat. The audit listed every non-static, non-private
method Forge 2.0.15's `PlayerController` declares (reflection; 79 were not overridden when it started) and
compared each with Forge's own desktop `forge.player.PlayerControllerHuman` (forge-gui), which is the
reference for what a human is asked.

Verdicts: **(a)** route to the human with an existing prompt kind; **(b)** route with a new message kind;
**(c)** legitimately automatic (no player choice exists in a CGwF game, or `PlayerControllerHuman` also
decides it without asking); **(d)** deliberately left to Forge's AI, with the reason. "How often" is for a
four-player Commander game.

**Counts (the 79 inherited at the start):** (a) 19, routed in the first PR (#14); (b) 3, routed in the second as per-seat notices;
(c) 50; (d) 7. Three more AI fallbacks were found inside methods the bridge already overrode and are fixed
too (second table).

**The guard.** `engine/src/test/java/cgwf/engine/BridgeCoverageTest.java` (plain reflection, no Forge
assets, runs in CI) fails when a `PlayerController` method is neither declared by `BridgeController` nor in
its `ALLOWED` map, where every entry carries its verdict and reason; it also fails on stale entries (a method
Forge removed, or one the bridge now overrides). After a Forge bump: run it, and for each new method read
`PlayerControllerHuman`'s version, then override it in the bridge or add an allow-list entry and a row here.

### 16.1 Routed to the human (a)

Every one falls back to Forge's AI only when the prompt times out or the seat is absent, as everywhere else.
Tests: `PromptRoundTripTest.inherited*` (each fails on the old bridge: no prompt was ever sent).

| Method | Decision | How often | Human reference | Now |
| --- | --- | --- | --- | --- |
| `chooseNewTargetsFor` | New targets for a copy that "may choose new targets" (Twincast, Reverberate, storm, Dualcaster, Lithoform Engine) and "change the target" effects (Redirect, Deflecting Swat, Bolt Bend) | Common | `TargetSelection` with the old number of targets; optional keeps the old ones | targets prompt, same count, Cancel = "Keep current targets"; a divided spell keeps its division |
| `orderAndPlaySimultaneousSa` (copies branch) | Copies were handed to the AI's `chooseNewTargetsForCopy` | Common | copies go on the stack, then `setupNewTargets(player)` | the bridge does the same, so the question above reaches the human |
| `getAbilityToPlay` | Which spell of a card to cast from an effect (cascade/discover into a split, adventure or MDFC card, "you may cast"), and which of several additional costs ("sacrifice a creature or pay 3 life") | Common | ability menu | choose (text) |
| `chooseCardsForConvokeOrImprovise` | Which untapped creatures / artifacts to tap for convoke, improvise, waterbend | Occasional | `InputSelectCardsForConvokeOrImprovise` | chooseMany (reason `convoke`, none = pay with mana); each card pays a shard of its colour first, as Forge's input |
| `vote` | Council's dilemma / will of the council (Expropriate, Council's Judgment, Tivit, Kharn) | Occasional | entity or ability choice | choose, with the running tally in the title |
| `chooseFlipResult` | Call heads or tails; Krark's Thumb: which flip to keep | Occasional | Heads/Tails or Win/Lose the flip | confirm with those two labels |
| `chooseRollToIgnore` | Roll two, ignore one (advantage) | Occasional | list | choose |
| `chooseDiceToReroll` | Which dice to reroll (Wyll, Pixie Guide-style) | Occasional | many | chooseMany (reason `reroll`) |
| `chooseRollToModify` | Which roll a modifier applies to | Rare | optional list | choose, optional |
| `chooseRollToSwap` / `chooseRollSwapValue` | Swap a roll with power/toughness (Unfinity-era die cards) | Rare | optional list | choose, optional |
| `chooseCardsForEffectMultiple` | "Put one of each ... into your hand" (DigMultiple) | Occasional | one pick per group | one chooseMany per group (a card picked once is not offered again) |
| `chooseCardsForSplice` | Splice onto Arcane | Rare | many | chooseMany (reason `splice`) |
| `chooseTarget` | Spellskite-style "change a target of target spell": which target | Rare | list of target + spell | choose (text) |
| `divideShield` | Split one prevention shield across several damage events | Rare | `assignGenericAmount` | assign |
| `choosePlayerToAssistPayment` | Assist: whom to ask for help | Rare | optional player choice | choose, optional |
| `helpPayForAssistSpell` | Assist: how much of SOMEONE ELSE's spell you pay (the AI used to tap the human's lands for it) | Rare | a number, then mana payment | number; the mana is paid automatically (owner's option 1); no answer = pay nothing |
| `chooseSingleCardFace` (list) | Venture into the dungeon: which dungeon | Occasional (AFR commanders, Acererak, Nadaar) | list | choose (text) |
| `chooseSingleCardState` | Rooms: which door to unlock / lock | Occasional | list | choose (text) |
| `confirmBidAction` | Bid life (Illicit Auction, Mages' Contest) | Rare | yes/no | confirm "Bid higher" / "Stop bidding" |

### 16.2 AI fallbacks inside methods already overridden (fixed)

| Method | Before | Now |
| --- | --- | --- |
| `orderAndPlaySimultaneousSa` | copied spells went through the AI path, which picked their new targets | Forge's human copy path (above) |
| `assignCombatDamage` | an illegal trample split ("lethal to every blocker first") handed the assignment to the AI | asked again, up to three times |
| `chooseCardsToDiscardUnlessType` | an illegal pick ("a land, or two cards") handed it to the AI | asked again, up to three times |

Still deliberate inside overrides: `chooseCardsToDiscardFrom` for ANOTHER player's hand chooses only from
cards shown to the chooser; Forge only calls it that way after a reveal or look, so the bridge falls back to
the AI only for hidden cards (two Forge cards, Mind Spike-style "you choose" without a reveal), rather than
put hidden identities into a prompt. `chooseColorAllowColorless` with one colour, `orderMoveToZoneList` for
zones where order is meaningless, and a mode answer illegal three times are AI or automatic by design.

### 16.3 New message kind (b): per-seat notices (second PR)

| Method | What Forge shows | How often | Human reference | Now |
| --- | --- | --- | --- | --- |
| `reveal(CardCollectionView, ZoneType, Player, String, boolean)` | Cards revealed to this seat: an opponent's hand (Gitaxian Probe, Thoughtseize), a tutored card, "reveal the top card", the rest of a dig | Common | dialog showing the cards | `notice` frame, kind `reveal`, with the cards |
| `reveal(List<CardView>, ...)` | The same, by card views | Common | dialog | same notice |
| `notifyOfValue` | A value Forge announces: chosen colour, number, creature type, vote, coin flip ("Blair chose blue") | Common | message box (mana abilities only logged) | `notice` frame, kind `info`, with the source card; skipped for mana abilities as Forge's human does |

None of these is a decision: the AI version only skipped showing them, so a human seat learned some of it
only from the log, and never saw an opponent's revealed hand. The engine sends `{type: "notice", kind,
title, text?, cards[], source[]}` for that seat only (fire and forget, no promptId, nothing persisted). The
identities are exactly what Forge reveals to that player, so carrying them is not a leak. The relay resolves
printings and sends `{t: "notice", notice: EngineNotice, printings}` to that player's sockets only (never
another seat, never spectators); the client shows them top right under the Stack panel (`Notices.tsx`):
revealed cards stay until dismissed, text-only notices fade after 8 s, the newest two show. Tests:
`PromptRoundTripTest.inheritedRevealsAndAnnouncedValuesReachTheSeatAsNotices`, relay "delivers a notice ...
to that seat only".

### 16.4 Legitimately automatic (c)

| Method(s) | Why |
| --- | --- |
| `getGame`, `getMatch`, `getPlayer`, `getLobbyPlayer`, `getAnteResult`, `isGuiPlayer`, `tempShowCards`, `endTempShowCards`, `autoPassCancel`, `awaitNextInput`, `cancelAwaitNextInput`, `resetAtEndOfTurn`, `isOrderedZone`, `orderedMoveToTopOfLibrary` | accessors, UI hooks and AI bookkeeping; no decision |
| `complainCardsCantPlayWell`, `revealAISkipCards`, `revealUnsupported` | messages about an AI's own deck or unsupported cards (decks are checked before the game) |
| `getFullControl`, `isFullControl` | Forge's "full control" flags are empty, the same default as Forge's human: Forge then skips the same optional questions for humans |
| `canPlayUnlimitedLands`, `cheatShuffle` | developer / AI cheats, off (`GameRules.allowCheatShuffle` false) |
| `addKeywordCost`, `chooseBinary` (3 args), `chooseCardsToDiscardFrom` (5 args), `chooseSingleEntityForEffect` (2 overloads), `chooseSomeType` (3 args), `confirmAction` (2 overloads), `getAbilityToPlay` (2 args), `getCostDecisionMaker` (3 args), `payManaCost` (5 args), `chooseSector` (2 args), `chooseSprocket` (1 arg), `reveal` (4 final overloads) | final or default overloads that only delegate to a method the bridge overrides or that has its own row |
| `chooseNumberForCostReduction` | `PlayerControllerHuman` returns the maximum unless full control is on |
| `chooseSingleStaticAbility` | only the cost-reduction order calls it; the human controller takes the first unless full control is on |
| `orderCosts` | the human controller keeps Forge's order unless full control is on |
| `chooseSingleCardFace` (predicate) | only the human controller's own name picker calls it; the bridge's `chooseCardName` replaces that picker |
| `orderBlockers`, `orderBlocker`, `orderAttackers` | damage assignment order is gone from the rules (Foundations); `GameRules.orderCombatants` is false, so Forge never calls them; damage itself is `assignCombatDamage` (routed) |
| `sideboard` | between games of a match only; CGwF plays one game |
| `chooseCardsYouWonToAddToDeck`, `revealAnte` | ante, not played |
| `choosePDRollToIgnore` | planar die, Planechase not enabled |
| `chooseStartingHand` | only Backup Plan (a Conspiracy card, never in a deck) makes extra opening hands |

### 16.5 Deliberately left to Forge's AI (d)

| Method | Reason |
| --- | --- |
| `applyManaToCost`, `chooseManaFromPool`, `specifyManaCombo` | mana payment is automatic by the owner's choice (Stage 2 M5, option 1); "Pay with" steers which sources are tapped first |
| `chooseSector` (3 args), `chooseSprocket` (2 args), `chooseContraptionsToCrank` | Un-set Attractions and Contraptions; not Commander-legal |
| `isAI` | stays true. Forge branches on it only for engine-internal paths: library searches pick one card at a time (still asked of the human), the 999-actions-in-one-priority loop guard, AI-unplayable cards left out of random pools (Booster Tutor-style "random card" effects), sideboarding, Camouflage. False would send Forge down GUI-only paths with no GUI attached |
