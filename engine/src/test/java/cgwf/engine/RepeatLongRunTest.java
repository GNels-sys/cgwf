package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import cgwf.engine.bridge.CastReplay;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.StaticData;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-22: Sprout Swarm (convoke, buyback) repeated 500 times with a few hundred Saprolings in play
 * slowed to a crawl near the 200th token and ended in "engine failure" (the engine's log: OutOfMemoryError). Forge
 * kept two copies of the whole battlefield per cast until the end of the turn. Real games: a long repeat with a big
 * board no longer leaves a board's worth of card copies behind per cast, and a running repeat can be stopped.
 * Needs -Dforge.assets.
 */
class RepeatLongRunTest {
    private static final int CREATURES = 150;
    private static final int REPEATS = 26;
    private static List<DeckLoader.Loaded> spikeDecks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)), "set -Dforge.assets to run");
        ForgeBoot.init(Path.of(assets), true);
        spikeDecks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 2);
    }

    private static PaperCard card(String name) {
        PaperCard pc = StaticData.instance().getCommonCards().getCard(name);
        assertNotNull(pc, "Forge knows " + name);
        return pc;
    }

    private static void put(Game game, Player p, String name) {
        Card c = Card.fromPaperCard(card(name), p);
        p.getZone(ZoneType.Hand).add(c);
        game.getAction().moveToPlay(c, p, null, null);
    }

    /** What one game showed when the repeat ended. */
    private record Result(String notice, int strays, int board, List<String> paths, JsonObject progress) { }

    /**
     * The human has 150 Grizzly Bears and Sprout Swarm: the first cast by hand (buyback, convoke with five creatures),
     * then "repeat 26 times". `stopAfter` > 0 presses Stop once that many repeats are done.
     */
    private static Result repeat(int stopAfter) throws Exception {
        Deck deck = new Deck("Swarm");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 120_000);
        Game[] gameRef = new Game[1];
        Player[] meRef = new Player[1];
        String[] notice = new String[1];
        int[] strays = {-1}, board = {0};
        List<String> paths = new ArrayList<>();
        human.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if ("prompt".equals(type)) queue.add(frame);
            if ("notice".equals(type) && frame.has("text") && frame.get("text").getAsString().startsWith("Repeated")) {
                // the repeat is over (game thread): measure, then end the game
                notice[0] = frame.get("text").getAsString();
                board[0] = meRef[0].getCardsIn(ZoneType.Battlefield).size();
                strays[0] = RetentionWalk.count(gameRef[0], paths);
                human.requestConcede();
            }
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair"))), 4242L);
        Game game = created.game();
        gameRef[0] = game;
        human.setViewBuilder(p -> SeatView.build(game, p));
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) meRef[0] = p;
        final Player my = meRef[0];
        boolean[] setUp = {false};
        int[] stage = {0};
        AtomicReference<JsonObject> progress = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "mulligan" -> a.addProperty("keep", true);
                        case "priority" -> {
                            boolean mine = p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean() && "MAIN1".equals(p.get("phase").getAsString());
                            int swarm = -1;
                            for (JsonElement e : p.getAsJsonArray("options")) {
                                JsonObject o = e.getAsJsonObject();
                                if ("Sprout Swarm".equals(o.get("cardName").getAsString())) swarm = o.get("index").getAsInt();
                            }
                            if (mine && !setUp[0]) {
                                setUp[0] = true;
                                for (int i = 0; i < CREATURES; i++) put(game, my, "Grizzly Bears");
                                my.getZone(ZoneType.Hand).add(Card.fromPaperCard(card("Sprout Swarm"), my));
                                a.add("option", null); // asked again with the new board
                            } else if (swarm >= 0 && stage[0] == 0) {
                                stage[0] = 1;
                                a.addProperty("option", swarm); // the first cast, by hand
                            } else if (swarm >= 0 && stage[0] == 1 && p.has("repeat")) {
                                stage[0] = 2;
                                a.addProperty("option", p.getAsJsonObject("repeat").get("option").getAsInt());
                                a.addProperty("repeat", REPEATS);
                            } else {
                                a.add("option", null);
                            }
                        }
                        case "chooseMany" -> {
                            boolean convoke = p.has("reason") && "convoke".equals(p.get("reason").getAsString());
                            JsonArray picks = new JsonArray();
                            for (int i = 0; i < Math.min(p.getAsJsonArray("options").size(), convoke ? 5 : 1); i++) picks.add(i);
                            a.add("options", picks); // buyback; then five creatures to convoke with
                        }
                        default -> a = ScriptedSeat.answer(p, my.getId());
                    }
                    a.add("promptId", p.get("promptId"));
                    human.answer(a);
                }
            } catch (InterruptedException stop) {
                // the game is over
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "swarm-human");
        answerer.setDaemon(true);
        answerer.start();
        Thread stopper = new Thread(() -> {
            try {
                while (true) {
                    CastReplay r = human.replay();
                    if (r != null && r.active() && r.done() >= stopAfter) {
                        progress.set(human.repeatingJson());
                        human.requestStopRepeat(); // the Stop button
                        return;
                    }
                    Thread.sleep(2);
                }
            } catch (InterruptedException done) {
                // not needed
            }
        }, "swarm-stop");
        stopper.setDaemon(true);
        if (stopAfter > 0) stopper.start();
        created.match().startGame(game);
        answerer.interrupt();
        stopper.interrupt();
        if (failure.get() != null) throw new AssertionError(failure.get());
        return new Result(notice[0], strays[0], board[0], paths, progress.get());
    }

    @Test
    void aLongRepeatDoesNotKeepACopyOfTheBoardForEveryCast() throws Exception {
        Result r = repeat(0);
        assertEquals("Repeated Sprout Swarm " + REPEATS + " times.", r.notice());
        assertTrue(r.board() >= CREATURES + REPEATS, "the board: " + r.board());
        // Before the fix every cast left two boards of card copies behind (26 casts: over 50 boards' worth). What
        // may stay: the newest few casts' snapshots, and one copy of each card that entered a zone this turn.
        assertTrue(r.strays() < 16 * r.board(), "card copies kept alive: " + r.strays() + " for a board of " + r.board() + "\n" + String.join("\n", r.paths()));
    }

    @Test
    void aRunningRepeatShowsItsProgressAndCanBeStopped() throws Exception {
        Result r = repeat(3);
        assertNotNull(r.notice(), "the repeat ended");
        assertTrue(r.notice().matches("Repeated Sprout Swarm \\d+ of " + REPEATS + " times; stopped: you stopped it\\."), r.notice());
        int done = Integer.parseInt(r.notice().replaceAll("\\D+(\\d+) of.*", "$1"));
        assertTrue(done >= 3 && done < REPEATS, "stopped part of the way: " + done);
        assertNotNull(r.progress(), "the seat's own view says what is running");
        assertEquals("cast", r.progress().get("kind").getAsString());
        assertEquals("Sprout Swarm", r.progress().get("name").getAsString());
        assertEquals(REPEATS, r.progress().get("wanted").getAsInt());
    }
}
