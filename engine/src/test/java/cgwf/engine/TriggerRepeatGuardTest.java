package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import cgwf.engine.bridge.TriggerRepeatGuard;
import com.google.gson.JsonObject;
import forge.StaticData;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.zone.MagicStack;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-21: "the bot accepted it was a draw". An opponent's Scute Swarm triggers were resolving one
 * by one; each token triggered the owner's Authority of the Consuls, and Forge called the 51st such trigger a
 * mandatory loop and ended the game as a draw. Real games: the same board is a draw on Forge's own count, plays
 * on with ours, and a real mandatory loop (Polyraptor + Marauding Raptor) is still a draw. Needs -Dforge.assets.
 */
class TriggerRepeatGuardTest {
    private static final int SWARMS = 60;
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

    /** What one game showed. */
    private record Result(boolean draw, int confirms, int lifeGained, List<String> trace) { }

    /**
     * The human has Authority of the Consuls and Niv-Mizzet, Ghost Counsel ("whenever you gain life, you may pay
     * that much life..."), the AI sixty Scute Swarms. A land enters on the AI's side: sixty landfall triggers, each
     * makes a token, each token gains the human 1 life and asks about Niv-Mizzet (answered "no", so no life is lost).
     */
    private static Result scuteSwarmGame(boolean guard) throws Exception {
        Deck deck = new Deck("Consuls");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Glarb", spikeDecks.get(0).deck(), GameFactory.ai("Glarb"))), 4242L);
        Game game = created.game();
        assertTrue(TriggerRepeatGuard.installed(game), "every game gets the size-aware count");
        if (!guard) { // Forge's own count back in place
            Field f = MagicStack.class.getDeclaredField("triggerRepeats");
            f.setAccessible(true);
            f.set(game.getStack(), new HashMap<Integer, Integer>());
        }
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        Player opp = null;
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) me = p;
            else opp = p;
        }
        final Player my = me;
        final Player them = opp;
        boolean[] setUp = {false}, landed = {false};
        int[] confirms = {0}, lifeAtStart = {0}, lifeGained = {0};
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    boolean concede = false;
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                put(game, my, "Authority of the Consuls");
                                put(game, my, "Niv-Mizzet, Ghost Counsel");
                                for (int i = 0; i < SWARMS; i++) put(game, them, "Scute Swarm");
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            if (!landed[0] && p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean()) {
                                landed[0] = true;
                                lifeAtStart[0] = my.getLife();
                                put(game, them, "Forest"); // landfall, sixty times
                            }
                            a.add("option", null);
                        }
                        case "confirm" -> {
                            confirms[0]++;
                            lifeGained[0] = my.getLife() - lifeAtStart[0];
                            if (confirms[0] <= 2 || confirms[0] % 10 == 0) trace.add("confirm " + confirms[0] + ": " + p.get("title").getAsString() + " (life +" + lifeGained[0] + ")");
                            a.addProperty("confirm", false);
                            concede = confirms[0] >= SWARMS; // everything resolved: stop the game here
                        }
                        default -> a = ScriptedSeat.answer(p, my.getId());
                    }
                    a.add("promptId", p.get("promptId"));
                    human.answer(a);
                    if (concede) human.requestConcede();
                }
            } catch (InterruptedException stop) {
                // the game is over
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "consuls-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        boolean draw = game.getOutcome() != null && game.getOutcome().isDraw();
        return new Result(draw, confirms[0], lifeGained[0], trace);
    }

    @Test
    void forgesOwnCountCallsSixtyTriggersOfOneCardADraw() throws Exception {
        Result r = scuteSwarmGame(false);
        // If this fails, Forge fixed its count: TriggerRepeatGuard can go.
        assertTrue(r.draw(), "the owner's game: a draw with a finite stack still to resolve\n" + String.join("\n", r.trace()));
        assertTrue(r.confirms() < SWARMS, "cut short after " + r.confirms() + " of " + SWARMS);
    }

    @Test
    void withTheGuardEveryTriggerResolvesAndNobodyDraws() throws Exception {
        Result r = scuteSwarmGame(true);
        String why = "\n" + String.join("\n", r.trace());
        assertFalse(r.draw(), "not a draw" + why);
        assertEquals(SWARMS, r.confirms(), "every token asked about Niv-Mizzet" + why);
        assertEquals(SWARMS, r.lifeGained(), "and gained its 1 life" + why);
    }

    /** Marauding Raptor deals 2 damage to each Polyraptor copy as it enters; each damaged copy makes another. Nobody can stop it. */
    @Test
    void aRealMandatoryLoopIsStillADraw() throws Exception {
        Deck deck = new Deck("Raptors");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Glarb", spikeDecks.get(0).deck(), GameFactory.ai("Glarb"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) me = p;
        final Player my = me;
        boolean[] started = {false};
        int[] priorities = {0};
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    JsonObject a;
                    if ("priority".equals(p.get("prompt").getAsString())) {
                        a = new JsonObject();
                        if (!started[0] && p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean()) {
                            started[0] = true;
                            put(game, my, "Marauding Raptor");
                            put(game, my, "Polyraptor");
                        } else if (started[0] && ++priorities[0] > 40) {
                            a.addProperty("concede", true); // the loop did not end the game: fail below, do not hang
                        }
                        if (!a.has("concede")) a.add("option", null);
                    } else {
                        a = ScriptedSeat.answer(p, my.getId());
                    }
                    a.add("promptId", p.get("promptId"));
                    human.answer(a);
                }
            } catch (InterruptedException stop) {
                // the game is over
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "raptor-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(failure.get());
        assertTrue(started[0], "the loop was started");
        assertTrue(game.getOutcome() != null && game.getOutcome().isDraw(), "an endless mandatory loop ends the game as a draw (rule 104.4b)");
    }
}
