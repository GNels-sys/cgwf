# CGwF rules engine (Stage 0 spike)

Headless [Forge](https://github.com/Card-Forge/forge) rules engine behind a JSON-over-WebSocket
bridge, so CGwF can run real Commander games (enforced rules, stack, combat, win conditions) with
its own React table on top. This folder is **GPL-3.0** (it links `forge-game`); see `LICENSE` and
`NOTICE`. The rest of the repository talks to it over a socket and keeps its own licence.

Design for the real thing: [`docs/FORGE-ENGINE.md`](../docs/FORGE-ENGINE.md). This README is the
spike: how to build it, what it proved, what it measured, and the go/no-go.

## What is here

| Path | What |
| --- | --- |
| `src/main/java/cgwf/engine/HeadlessGui.java` | The no-op `IGuiBase` Forge needs before its model loads |
| `ForgeBoot.java` | Loads the card database once (`FModel.initialize`, lazy card scripts, en-US) |
| `DeckLoader.java` | CGwF deck JSON -> Forge `Deck` (exact set + collector number, then set, then name) |
| `GameFactory.java` | Four-seat Commander `Match`/`Game`; Forge AI seats by default |
| `SeatView.java` | **The per-seat JSON view: the only serialiser, where hidden information is decided** |
| `HiddenInfoAudit.java` | Runs a game and checks every seat's view at every event (used by the test and `audit`) |
| `Metrics.java` | Turn timing, peak heap, RSS (Linux) |
| `bridge/BridgeController.java` | The human seat: extends Forge's AI controller, overrides the prompts the spike models |
| `bridge/BridgeSession.java` | Prompt/answer hand-off between the game thread and the socket (timeout -> AI) |
| `bridge/BridgeLobbyPlayer.java` | Forge lobby player that creates a `BridgeController` |
| `bridge/BridgeServer.java` | Java-WebSocket server: one connection = one table (1 human + 3 AI) |
| `Main.java` | `bench` \| `audit` \| `serve` |
| `src/test/.../HiddenInformationTest.java` | **Permanent test**: no seat ever sees another hand or any library |
| `spike/export-precons.mjs` | Pulls four Commander precons from MTGJSON (CGwF's library source) into `spike/decks/` |
| `spike/client.mjs` | Scripted human seat (Node, no deps) that plays a whole game through the bridge |
| `Dockerfile`, `fly.toml` | Fly app `cgwf-engine` (lax, 2 GB), Forge cloned at a pinned tag during the image build |

## Stage 1 (what changed after the spike)

The spike's one-socket-one-table server became a **control socket** that the CGwF server
holds open: `EngineServer` + `GameSession` serve many tables on one connection, every frame
carries `gameId` (= the CGwF room id) and `seat` (table seat, -1 = spectator). Browsers never
connect here. Handshake: `Authorization: Bearer <ENGINE_TOKEN>` (refused otherwise).

| Direction | Frames |
| --- | --- |
| CGwF -> engine | `createGame {rid, gameId, seed, seats:[{seat, kind: human\|ai, name, deck}]}`, `answer {gameId, seat, promptId, ...}`, `setStops {gameId, seat, stops}`, `resync {gameId, seat}`, `attachSeat` / `detachSeat {gameId, seat}` (absent seat = the AI plays it), `concede {gameId, seat}`, `endGame {gameId}`, `health {rid}`, `ping` |
| engine -> CGwF | `hello`, `gameCreated {rid, gameId, players:[{seat, playerId, deckName, resolved, missing}]}`, `cards {cards:[{cardId, owner, name, set, scryfallSet, number}]}` once at start (printing mapping), `state {seat, ...view}`, `prompt {seat, promptId, prompt, view, ...}`, `log {seq, turn, logType, text}`, `gameOver {winnerSeat, winner, endReason, turns}`, `error`, `health`, `pong` |

Other Stage 1 engine changes: server-side Arena-style stops per seat (`BridgeSession.Stops`;
defaults = my MAIN1 / after attackers / MAIN2 / end, opponents' end step, always when the top
of the stack is someone else's; `passUntilTurn` in a priority answer passes the rest of a turn),
cached per-seat frames for `resync`, Forge's bookkeeping effect cards hidden from the command
zone, `CGWF_MAX_GAMES` (default 4), and the hidden-information audit now also checks the view
attached to every prompt of a scripted human seat (`ScriptedSeat`). `spike/client.mjs` is now a
fake CGwF server (useful without the app): `node engine/spike/client.mjs ws://localhost:8081 --token T`.

Deployment: `fly.toml` has no public service and `restart = always`; the machine must be
started once by hand after a deploy that finds it stopped (`fly machine start <id>`). Stage 1
stays on `shared-cpu-2x` (humans only); for bot seats see the measurements below.

## Toolchain (exact versions used, 2026-10-17)

Docker is not installed on the Windows dev box; the image builds remotely on Fly. Locally:

| Tool | Version | Where |
| --- | --- | --- |
| JDK | Eclipse Temurin **21.0.12.1+1** (portable zip from `api.adoptium.net`) | `C:\Openclaw\tools\jdk-21.0.12.1+1` |
| Maven | **3.9.16** (portable zip from `dlcdn.apache.org`) | `C:\Openclaw\tools\apache-maven-3.9.16` |
| Forge | tag **forge-2.0.15** (released 2026-09-28), shallow clone | `C:\Openclaw\forge` |
| Node | 24 (already present) | |

Neither tool is on PATH or in the registry (no admin prompt was needed). Oracle JDK 25 is also on
the machine (`java -version`), but Forge targets Java 17+ and the image uses 21, so 21 is used
for everything here. Forge publishes no library jars (its GitHub release is a 300 MB desktop
installer), so the four GUI-less modules are built from source.

```bash
# one-time: Forge at the pinned tag (~160 MB checkout, ~3.5 min build)
git clone --depth 1 --branch forge-2.0.15 https://github.com/Card-Forge/forge.git C:/Openclaw/forge
export JAVA_HOME=/c/Openclaw/tools/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:/c/Openclaw/tools/apache-maven-3.9.16/bin:$PATH"
cd /c/Openclaw/forge && mvn -B -pl forge-core,forge-game,forge-ai,forge-gui -am -DskipTests -Dcheckstyle.skip -Dmaven.javadoc.skip=true install
```

`forge-gui` is needed as well as core/game/ai: it is the GUI-agnostic model layer (`FModel`,
preferences, `GuiBase`, the net-play seam); it contains no Swing. `forge-gui-desktop` and
`forge-gui-mobile` are not built. The first build downloads ~200 MB of Maven dependencies; a
transient "connection aborted" on a plugin download happened once and a retry fixed it.

```bash
# the engine
cd /c/Openclaw/cgwf-forge/engine
mvn -B -DskipTests package                       # -> target/cgwf-engine.jar (26 MB, Forge inside)
mvn -B -Dforge.assets=/c/Openclaw/forge/forge-gui package   # also runs the hidden-information test

# four-AI benchmark (JSON report on stdout)
java -Xmx1400m -XX:+UseSerialGC -jar target/cgwf-engine.jar bench --assets /c/Openclaw/forge/forge-gui --decks spike/decks --seed 1 --games 2 --max-turns 60

# hidden-information audit on its own
java -jar target/cgwf-engine.jar audit --assets /c/Openclaw/forge/forge-gui --decks spike/decks --seed 7

# bridge: engine + scripted human seat
java -jar target/cgwf-engine.jar serve --assets /c/Openclaw/forge/forge-gui --decks spike/decks --port 8081
node spike/client.mjs ws://localhost:8081 --seed 42 --name Georgie [--dump-dir spike/dumps]

# decks (MTGJSON Commander precons; default product BLC = Bloomburrow Commander)
node spike/export-precons.mjs BLC
```

Fly (token: `export FLY_ACCESS_TOKEN=$(grep access_token ~/.fly/config.yml | awk '{print $2}' | tr -d '"')`):

```bash
cd engine
fly apps create cgwf-engine --org personal        # done 2026-10-17
fly deploy --remote-only --ha=false               # ~10 min: clones Forge, builds it, builds the engine
fly ssh console -a cgwf-engine -C "java -Xmx1200m -XX:+UseSerialGC -jar /app/cgwf-engine.jar bench --seed 1 --games 2 --max-turns 60"
```

## What the spike proved

1. **Headless Forge runs here and on Fly.** Card database (~30k scripts), editions, formats and
   AI profiles load with a 90-line `IGuiBase` shim; no display, no Swing.
2. **Four Commander precons from CGwF's library source load into Forge by printing.** Of the 360
   distinct cards in the four Bloomburrow Commander decks, 358 resolved to the exact set +
   collector number CGwF stores (2 by name only, 0 missing). Forge's edition files carry
   Scryfall's set codes, so the id mapping the design needs is a lookup, not a heuristic.
3. **Four Forge AIs play a whole Commander game to a real win** (`AllOpponentsLost`), with
   commander damage, tokens, the stack and combat all handled by the engine.
4. **A human seat works through Forge's `PlayerController` seam** with eight prompt kinds:
   priority (play a land, cast a spell with automatic mana payment), targets, declare attackers,
   declare blockers, single choice, multiple choice, confirm, mulligan. Everything else, and every
   unanswered prompt, falls back to Forge's AI. The scripted client played 39 turns of a 46-turn
   game before being eliminated: 10 lands, 17 spells, 4 attack declarations, 456 priority prompts
   (hence the auto-pass design in the doc), 0 engine errors.
5. **Hidden information holds on the wire.** `HiddenInformationTest` serialises every seat's view
   plus a spectator's at every priority pass, step change and zone change of a 40-turn game and
   asserts no view contains the id of any library card or of another seat's hand card, no name
   that only such a card could have supplied, no `library` array, no foreign `hand` array, and
   counts equal to the truth. It runs in `mvn package` when `-Dforge.assets` (or `FORGE_ASSETS`)
   points at `forge-gui`, and is skipped otherwise so plain CI stays green.

## Measurements

Local = Windows 11, this dev box, JDK 21, `-Xmx1400m -XX:+UseSerialGC`. Fly = `cgwf-engine`,
`shared-cpu-2x`, 2 GB, `eclipse-temurin:21-jre`, `-XX:MaxRAMPercentage=70` (1.3 GB heap cap).
Games = four Forge AIs, Bloomburrow Commander precons, 60-turn cap.

| Metric | Local | Fly (lax) |
| --- | --- | --- |
| Startup to "ready" (card DB loaded), cold file cache | 147 s (first run; Windows + Defender reading 30k files) | 19.8 s (first boot of the machine) |
| Startup to "ready", warm cache | 7.9-8.6 s | 4.0 s |
| Heap after boot | ~110 MB | ~60 MB |
| Game 1 (seed 1) | 50 turns, 188 s, **3.8 s/turn** avg, slowest turn 27 s, winner AI 3 | shared-cpu-2x: 58 turns, 1540 s, **26.6 s/turn**, slowest turn 358 s, winner AI 1; one AI decision hit Forge's own per-decision timeout and passed. performance-1x (1 dedicated vCPU, 2 GB): the same 50-turn game in 298 s, **6.0 s/turn**, slowest turn 42 s, peak heap 305 MB, RSS 502 MB |
| Game 2 (seed 2) | 56 turns, 433 s, 7.7 s/turn, slowest turn 72 s, winner AI 2 (run while two other JVMs were busy on the box) | not run (game 1 took 26 min on the shared machine) |
| Peak heap during a game | 365 MB (game 1), 493 MB (game 2) | 400 MB (game 1) |
| Peak RSS of the JVM | n/a on Windows | 592 MB (game 1); the idle `serve` JVM sat at 165 MB RSS next to it, 734 MB used of 1968 in total |
| Human-seat game via the bridge (seed 42, local) | 46 turns in 116 s wall, 594 state frames, first prompt 2.3 s after connect | not run on Fly |

"Seconds per turn" is wall time for four AI players; a human table spends most of its time
waiting for humans, so this is the engine overhead floor, not a game pace.

**Is 2 GB enough?** Yes for memory: one four-player game peaks under 600 MB RSS with a 1.2 GB
heap cap, and two JVMs (idle server + a running game) used 734 MB of the machine's 1968 MB. **CPU
is the constraint, not RAM:** Forge's AI evaluates every candidate play each priority pass, and on
Fly's `shared-cpu-2x` an AI-only game ran 7-8x slower than on the dev box (26.6 s/turn vs 3.8),
with one 6-minute turn. Human tables are mostly idle (humans think far longer than the engine),
but bot seats and the stack/combat resolution of a busy board need real CPU, so Stage 1 should
size the machine by CPU: `performance-1x` (one dedicated vCPU, 2 GB) ran the same game 5x faster
than `shared-cpu-2x` and within 1.6x of the dev box (6.0 vs 3.8 s/turn); `performance-2x` needs
4 GB on Fly. Keep the AI's per-decision timeout (Forge already enforces one and passes when it
fires). Cost note: performance-1x is ~$31/month if always on, shared-cpu-2x ~$6-12; with
scale-to-zero both bill only while a table is open.

## Risks hit during the spike

- Forge 2.0.15's `Card.getCounters()` returns a Guava `Multiset`, not a `Map` (API drift between
  versions; budget an hour per Forge bump).
- The AI's "cards I could play" list includes the top card of every library (for play-from-top
  effects); the human prompt filters those unless the seat may see the card. The view audit does
  not cover prompts yet (Stage 1 item).
- Eliminated players vanish from `getPlayersInTurnOrder()`; the view now uses
  `getRegisteredPlayers()` so a dead seat still shows with `lost: true`.
- The AI's cast path puts a spell on the stack before targeting and cannot cleanly roll back a
  failed targeting; the bridge chooses targets first and only then casts. Modal spells (Charm)
  pick modes inside the cast, so their sub-ability targets come from the AI for now.
- Windows cold start is slow (file cache); the Linux image is fine. Keep the machine warm while
  games can start (Stage 1), and never scale to zero mid-game: games live in RAM only.
- Oracle JDK 25 is the machine's default `java`; the portable Temurin 21 must be put on PATH for
  each shell (the commands above do that).

## Go / no-go

**GO** for Option 1. Every Stage 0 question has a measured answer: Forge builds and runs headless
in 4-20 s on a 2 GB Fly machine with a few hundred MB of heap; a four-player Commander game runs
to completion in a few minutes of AI time; the `PlayerController` seam carries a human seat over
JSON with the AI as a safety net; decks map by exact printing; hidden information is testable at
the serialiser. The risks are engineering (prompt coverage, auto-pass UX, reconnect, Forge bumps),
not feasibility.

**First thing Stage 1 should build:** the control protocol + relay (`createGame`, seat
multiplexing, `answer`, `resync`) on the engine and an "engine mode" in `LiveRoom` that forwards
the spike's eight prompts to the existing browser socket, with printing mapping. That puts a real
engine game inside the real app in the first week (see `docs/FORGE-ENGINE.md`, section 15).

## Fly state after the spike

The spike's machine is scaled to zero (`fly.toml`: `auto_stop_machines = "stop"`,
`min_machines_running = 0`). Nothing is stored on it (no volume; games live in RAM), so nothing
is lost by stopping it. It wakes on the first connection to `cgwf-engine.fly.dev:443` (~20 s).
