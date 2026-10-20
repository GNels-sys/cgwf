package cgwf.engine.bridge;

import cgwf.engine.DeckLoader;
import cgwf.engine.GameFactory;
import cgwf.engine.SeatView;
import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameLogEntry;
import forge.game.card.Card;
import forge.game.event.GameEvent;
import forge.game.event.GameEventGameFinished;
import forge.game.event.GameEventGameOutcome;
import forge.game.event.GameEventGameStarted;
import forge.game.event.GameEventPlayerPriority;
import forge.game.event.GameEventTurnBegan;
import forge.game.event.GameEventTurnPhase;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * One table inside the engine: the Forge game on its own thread, one {@link BridgeSession} per
 * human seat, per-seat views pushed to the control socket, the log streamed once, and cached
 * frames so a seat can be resynced without touching the game from another thread.
 *
 * Seats are the table's seat numbers (0-3, possibly with gaps); -1 is the spectator view.
 */
public final class GameSession {
    public record SeatSpec(int seat, boolean human, String name, DeckLoader.Loaded deck) { }

    public static final int SPECTATOR = -1;
    private static final long MIN_FLUSH_GAP_NANOS = 100_000_000L;

    private final String gameId;
    private final long seed;
    private final List<SeatSpec> specs;
    private final Consumer<JsonObject> out;
    private final Map<Integer, BridgeSession> humans = new LinkedHashMap<>();
    private final Map<Integer, Player> playerBySeat = new LinkedHashMap<>();
    private final Map<Player, Integer> seatByPlayer = new LinkedHashMap<>();
    private final Map<Integer, String> lastState = new ConcurrentHashMap<>();
    private final GameFactory.Created created;
    private final Game game;
    private final Thread thread;
    private volatile boolean dirty;
    private long lastFlushNanos;
    private int logSent;
    private volatile boolean over;
    private final StartingPlayer starting = new StartingPlayer();
    private final OpeningHand opening;
    /** end() was called: the game thread sets the game over at its next event. */
    private volatile boolean endRequested;
    private final java.util.concurrent.atomic.AtomicBoolean started = new java.util.concurrent.atomic.AtomicBoolean();
    private final long createdAt = System.currentTimeMillis();
    private boolean cardsSent;
    /** Rounds for people (Forge's turn stays the truth): see RoundTracker. */
    private final RoundTracker rounds = new RoundTracker();
    /** Seats in the order Forge took them out of the game (same index = left together), for game results. */
    private final Map<Integer, Integer> outOrder = new java.util.LinkedHashMap<>();
    private int outCount = 0;

    public GameSession(String gameId, long seed, List<SeatSpec> specs, long promptTimeoutMs, Consumer<JsonObject> out) {
        this(gameId, seed, specs, promptTimeoutMs, out, OpeningHand.FORGE);
    }

    public GameSession(String gameId, long seed, List<SeatSpec> specs, long promptTimeoutMs, Consumer<JsonObject> out, OpeningHand opening) {
        this.opening = opening == null ? OpeningHand.FORGE : opening;
        this.gameId = gameId;
        this.seed = seed;
        this.specs = List.copyOf(specs);
        this.out = out;
        List<GameFactory.Seat> seats = new ArrayList<>();
        Map<LobbyPlayer, Integer> seatOfLobby = new LinkedHashMap<>();
        for (SeatSpec s : specs) {
            LobbyPlayer lp;
            if (s.human()) {
                BridgeSession session = new BridgeSession(s.seat(), promptTimeoutMs);
                final int seat = s.seat();
                session.attach(frame -> emit(frame, seat));
                humans.put(seat, session);
                session.setStartingPlayer(starting);
                session.setOpeningHand(this.opening);
                lp = new BridgeLobbyPlayer(s.name(), session);
            } else {
                lp = new BridgeAiLobbyPlayer(s.name(), starting, this.opening);
            }
            seatOfLobby.put(lp, s.seat());
            seats.add(new GameFactory.Seat(s.name(), s.deck().deck(), lp));
        }
        created = GameFactory.create(seats, seed);
        game = created.game();
        for (Player p : game.getRegisteredPlayers()) {
            Integer seat = seatOfLobby.get(p.getLobbyPlayer());
            if (seat == null) continue;
            playerBySeat.put(seat, p);
            seatByPlayer.put(p, seat);
        }
        for (BridgeSession s : humans.values()) {
            s.setViewBuilder(p -> {
                JsonObject v = SeatView.build(game, p, this::seatOf);
                v.addProperty("round", rounds.round());
                return v;
            });
            s.setBeforeAsk(this::flushIfDirty);
        }
        if (this.opening.drawTen()) {
            for (Player p : game.getRegisteredPlayers()) p.setStartingHandSize(OpeningHand.DRAW10_HAND); // Forge deals ten
            this.opening.setPutBack(this::putBackAll);
        }
        game.subscribeToEvents(this);
        thread = new Thread(this::run, "game-" + gameId);
        thread.setDaemon(true);
    }

    public String gameId() { return gameId; }
    public boolean isOver() { return over; }

    private int seatOf(Player p) {
        Integer s = seatByPlayer.get(p);
        return s == null ? -1 : s;
    }

    /** The {@code gameCreated} frame: seats, Forge player ids and how each deck resolved. */
    public JsonObject createdFrame() {
        JsonObject j = new JsonObject();
        j.addProperty("type", "gameCreated");
        j.addProperty("gameId", gameId);
        j.addProperty("seed", seed);
        JsonArray players = new JsonArray();
        for (SeatSpec s : specs) {
            Player p = playerBySeat.get(s.seat());
            JsonObject pj = new JsonObject();
            pj.addProperty("seat", s.seat());
            pj.addProperty("playerId", p == null ? null : p.getId());
            pj.addProperty("name", s.name());
            pj.addProperty("human", s.human());
            DeckLoader.Loaded d = s.deck();
            pj.addProperty("deckName", d.spec().name());
            pj.addProperty("resolved", d.resolved());
            pj.addProperty("exactPrinting", d.exactPrinting());
            pj.addProperty("byName", d.byNameOnly() + d.bySetOnly());
            JsonArray missing = new JsonArray();
            for (String m : d.missing()) missing.add(m);
            pj.add("missing", missing);
            players.add(pj);
        }
        j.add("players", players);
        return j;
    }

    public void start() { begin(null); }

    public OpeningHand openingHand() { return opening; }

    /**
     * Draw 10, put 3 back (game thread, from the first keep question): every human seat is asked at the same
     * time (its own ten only), Forge's AI picks for bots and absent seats; then each player's three go back
     * into their library, which is shuffled (Forge's shuffle, the game's RNG). Nothing is discarded or
     * revealed, so nothing triggers; the log names no card. The opening-hand actions follow from the seven.
     */
    private void putBackAll() {
        flushIfDirty(); // the asks below run on helper threads while this thread waits: nothing changes meanwhile
        List<Player> players = new ArrayList<>(game.getPlayers());
        Map<Player, java.util.concurrent.CompletableFuture<List<Card>>> asks = new LinkedHashMap<>();
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "putback-" + gameId);
            t.setDaemon(true);
            return t;
        });
        try {
            for (Player p : players) {
                if (p.getController() instanceof BridgeController bc && !bc.autopilot()) {
                    asks.put(p, java.util.concurrent.CompletableFuture.supplyAsync(() -> bc.choosePutBack(OpeningHand.PUT_BACK), pool));
                }
            }
            for (Player p : players) {
                List<Card> hand = new ArrayList<>(p.getCardsIn(ZoneType.Hand));
                List<Card> chosen = null;
                if (asks.containsKey(p)) {
                    try { chosen = asks.get(p).join(); } catch (RuntimeException e) { chosen = null; }
                }
                if (chosen == null || chosen.size() != Math.min(OpeningHand.PUT_BACK, hand.size()) || !hand.containsAll(chosen)) chosen = aiPutBack(p, hand);
                for (Card c : chosen) game.getAction().moveToLibrary(c, null);
                p.shuffle(null);
                game.getGameLog().add(forge.game.GameLogEntryType.MULLIGAN, p.getName() + " put " + chosen.size() + " cards back and shuffled.");
            }
        } finally {
            pool.shutdownNow();
        }
    }

    /** Forge's AI discard choice (the cards it would least like to keep), exactly three. */
    private static List<Card> aiPutBack(Player p, List<Card> hand) {
        int n = Math.min(OpeningHand.PUT_BACK, hand.size());
        List<Card> out = new ArrayList<>();
        if (p.getController() instanceof forge.ai.PlayerControllerAi ai) {
            try {
                for (Card c : ai.getAi().getCardsToDiscard(n, null, null)) if (hand.contains(c) && !out.contains(c) && out.size() < n) out.add(c);
            } catch (RuntimeException ignored) { }
        }
        for (int i = hand.size() - 1; out.size() < n && i >= 0; i--) if (!out.contains(hand.get(i))) out.add(hand.get(i));
        return out;
    }

    /**
     * Starts the game thread (Match.startGame: who goes first, then mulligans). {@code startingSeat}
     * = the table's choice (D20 roll or random pick), fixed before Forge flips; null = Forge decides.
     * A second call is refused.
     */
    public void begin(Integer startingSeat) {
        if (over) throw new IllegalStateException("the game is over");
        if (startingSeat != null) {
            Player p = playerBySeat.get(startingSeat);
            if (p == null) throw new IllegalArgumentException("no player in seat " + startingSeat);
            starting.set(p);
        }
        if (!started.compareAndSet(false, true)) throw new IllegalStateException("the game has already begun");
        thread.start();
    }

    public boolean hasBegun() { return started.get(); }

    /** Created with deferStart and never begun for this long: the relay forgot it (restart mid-roll). */
    public boolean isStale(long maxWaitMs) { return !started.get() && System.currentTimeMillis() - createdAt > maxWaitMs; }

    private void run() {
        try {
            created.match().startGame(game);
        } catch (Throwable t) {
            System.err.println("[engine] game " + gameId + " thread died: " + t);
            t.printStackTrace(System.err);
            JsonObject err = new JsonObject();
            err.addProperty("type", "error");
            err.addProperty("message", "engine failure: " + t);
            emit(err, SPECTATOR);
        } finally {
            over = true;
            try {
                flush(true);
            } catch (RuntimeException ignored) { }
            JsonObject done = new JsonObject();
            done.addProperty("type", "gameOver");
            done.addProperty("turns", game.getPhaseHandler().getTurn());
            if (game.getOutcome() != null) {
                boolean draw = game.getOutcome().isDraw() || game.getOutcome().getWinCondition() == GameEndReason.Draw;
                Player winner = null;
                if (!draw && game.getOutcome().getWinningLobbyPlayer() != null) {
                    for (Player p : game.getRegisteredPlayers()) if (p.getLobbyPlayer() == game.getOutcome().getWinningLobbyPlayer()) winner = p;
                }
                done.addProperty("winnerSeat", winner == null ? null : seatOf(winner));
                done.addProperty("winner", winner == null ? null : winner.getName());
                done.addProperty("endReason", game.getOutcome().getWinCondition() == null ? null : game.getOutcome().getWinCondition().name());
            }
            noteEliminations();
            done.add("results", results());
            done.addProperty("round", rounds.round());
            emit(done, SPECTATOR);
        }
    }

    /** Records seats newly out of the game; everyone who left since the last check shares one step. */
    private synchronized void noteEliminations() {
        boolean any = false;
        for (Map.Entry<Integer, Player> e : playerBySeat.entrySet()) {
            if (outOrder.containsKey(e.getKey())) continue;
            if (e.getValue().hasLost()) { outOrder.put(e.getKey(), outCount); any = true; }
        }
        if (any) outCount++;
    }

    /**
     * Per seat: place (1 = winner; then the last one out, and so on; seats out together share a place),
     * won, conceded, how the seat lost. A draw leaves every seat still in at place 1 with won = false.
     */
    private synchronized JsonArray results() {
        JsonArray out = new JsonArray();
        int seats = playerBySeat.size();
        int stillIn = 0;
        for (Integer seat : playerBySeat.keySet()) if (!outOrder.containsKey(seat)) stillIn++;
        for (Map.Entry<Integer, Player> e : playerBySeat.entrySet()) {
            Player p = e.getValue();
            JsonObject r = new JsonObject();
            r.addProperty("seat", e.getKey());
            Integer step = outOrder.get(e.getKey());
            int place;
            if (step == null) place = 1;
            else {
                // seats that went out at a later step (or never) rank above this one
                int ahead = stillIn;
                for (Map.Entry<Integer, Integer> o : outOrder.entrySet()) if (o.getValue() > step) ahead++;
                place = Math.min(seats, ahead + 1);
            }
            r.addProperty("place", place);
            r.addProperty("won", p.getOutcome() != null && p.getOutcome().lossState == null && p.hasWon());
            r.addProperty("conceded", p.conceded());
            r.addProperty("lossReason", p.getOutcome() == null || p.getOutcome().lossState == null ? null : p.getOutcome().lossState.name());
            out.add(r);
        }
        return out;
    }

    // ------------------------------------------------------------------ inbound (control socket thread)

    public void answer(int seat, JsonObject msg) {
        BridgeSession s = humans.get(seat);
        if (s == null) { error("seat " + seat + " is not a human seat", seat); return; }
        s.answer(msg);
    }

    public void setStops(int seat, JsonObject stops) {
        BridgeSession s = humans.get(seat);
        if (s != null) s.setStops(stops);
    }

    /** Hold priority for a turn (0 = release). */
    public void setHold(int seat, int turn) {
        BridgeSession s = humans.get(seat);
        if (s != null) s.setHold(turn);
    }

    public void concede(int seat) {
        BridgeSession s = humans.get(seat);
        if (s != null) s.requestConcede();
    }

    public void setAbsent(int seat, boolean absent) {
        BridgeSession s = humans.get(seat);
        if (s != null) s.setAbsent(absent);
    }

    /** Re-sends the last state for a seat (or the spectator) plus its open prompt, from cache. */
    public void resync(int seat) {
        String cached = lastState.get(seat);
        if (cached == null && seat != SPECTATOR) cached = lastState.get(SPECTATOR);
        if (cached != null) {
            JsonObject frame = com.google.gson.JsonParser.parseString(cached).getAsJsonObject();
            emit(frame, seat);
        }
        BridgeSession s = humans.get(seat);
        if (s != null) {
            JsonObject open = s.openPrompt();
            if (open != null) emit(open.deepCopy(), seat);
        }
    }

    /** Ends the table (host closed the room): the game finishes as a draw on its own thread. */
    public void end() {
        if (!started.get()) { over = true; return; } // ended during the roll: no game thread to stop
        // The GAME thread ends it, at its next event (onEvent). Calling setGameOver from here deadlocked:
        // it takes Game's monitor and fires an event, while the game thread sits inside onEvent (the event
        // bus's per-subscriber lock) waiting for Game's monitor (found 2026-10-20; this runs on the
        // control socket's thread, so it could have frozen every table). Absent seats let a waiting
        // prompt return at once, so that next event comes promptly.
        endRequested = true;
        for (BridgeSession s : humans.values()) s.setAbsent(true);
    }

    // ------------------------------------------------------------------ outbound (game thread)

    @Subscribe
    public void onEvent(GameEvent e) {
        if (endRequested && Thread.currentThread() == thread && !game.isGameOver()) {
            endRequested = false;
            game.setGameOver(GameEndReason.Draw); // the table was closed (see end())
        }
        noteEliminations();
        if (e instanceof GameEventTurnBegan tb) {
            List<Player> order = game.getRegisteredPlayers();
            int idx = -1;
            for (int i = 0; i < order.size(); i++) if (tb.turnOwner() != null && order.get(i).getId() == tb.turnOwner().getId()) idx = i;
            rounds.onTurn(tb.turnNumber(), idx, order.size());
        }
        if (e instanceof GameEventGameStarted && !cardsSent) sendCards();
        boolean force = e instanceof GameEventPlayerPriority || e instanceof GameEventTurnPhase
                || e instanceof GameEventGameFinished || e instanceof GameEventGameOutcome || e instanceof GameEventGameStarted;
        long now = System.nanoTime();
        if (force || now - lastFlushNanos > MIN_FLUSH_GAP_NANOS) flush(false);
        else dirty = true;
    }

    private void flushIfDirty() {
        if (dirty) flush(false);
    }

    private void flush(boolean force) {
        dirty = false;
        lastFlushNanos = System.nanoTime();
        if (!cardsSent) sendCards();
        for (Map.Entry<Integer, Player> e : playerBySeat.entrySet()) {
            if (!humans.containsKey(e.getKey())) continue;
            JsonObject view = SeatView.build(game, e.getValue(), this::seatOf);
            view.addProperty("round", rounds.round());
            lastState.put(e.getKey(), view.toString());
            emit(view, e.getKey());
        }
        JsonObject spectator = SeatView.build(game, null, this::seatOf);
        spectator.addProperty("round", rounds.round());
        lastState.put(SPECTATOR, spectator.toString());
        emit(spectator, SPECTATOR);
        streamLog();
    }

    /** Every physical card at the start of the game, so the relay can map printings once. */
    private void sendCards() {
        cardsSent = true;
        JsonArray cards = new JsonArray();
        for (Card c : game.getCardsInGame()) {
            if (c.isToken()) continue;
            JsonObject cj = new JsonObject();
            cj.addProperty("cardId", c.getId());
            cj.addProperty("owner", c.getOwner() == null ? -1 : seatOf(c.getOwner()));
            SeatView.addIdentity(cj, c);
            cj.remove("power");
            cj.remove("toughness");
            cards.add(cj);
        }
        if (cards.isEmpty()) { cardsSent = false; return; } // zones not prepared yet; try on the next flush
        JsonObject j = new JsonObject();
        j.addProperty("type", "cards");
        j.add("cards", cards);
        emit(j, SPECTATOR);
    }

    private void streamLog() {
        List<GameLogEntry> all = game.getGameLog().getAllEntries(); // oldest first
        for (int i = logSent; i < all.size(); i++) {
            GameLogEntry e = all.get(i);
            JsonObject j = new JsonObject();
            j.addProperty("type", "log");
            j.addProperty("seq", i + 1);
            j.addProperty("turn", game.getPhaseHandler().getTurn());
            j.addProperty("round", rounds.round());
            j.addProperty("logType", e.type().name());
            j.addProperty("text", e.message());
            emit(j, SPECTATOR);
        }
        logSent = all.size();
    }

    private void error(String message, int seat) {
        JsonObject j = new JsonObject();
        j.addProperty("type", "error");
        j.addProperty("message", message);
        emit(j, seat);
    }

    private void emit(JsonObject frame, int seat) {
        frame.addProperty("gameId", gameId);
        frame.addProperty("seat", seat);
        out.accept(frame);
    }

    /** Human seat count, for health reporting. */
    public int humanSeats() { return humans.size(); }

    /** Cards the viewer of `seat` can see right now, for tests. */
    public Game game() { return game; }

    public static List<Integer> seatsOf(List<SeatSpec> specs) {
        List<Integer> out = new ArrayList<>();
        for (SeatSpec s : specs) out.add(s.seat());
        return out;
    }

    /** Library sizes by seat, for tests. */
    public Map<Integer, Integer> librarySizes() {
        Map<Integer, Integer> m = new LinkedHashMap<>();
        for (Map.Entry<Integer, Player> e : playerBySeat.entrySet()) m.put(e.getKey(), e.getValue().getCardsIn(ZoneType.Library).size());
        return m;
    }
}
