package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
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
 * Owner report 2026-11-21: Enduring Tenacity ("whenever you gain life, target opponent loses that much life") with
 * Bloodthirsty Conqueror ("whenever an opponent loses life, you gain that much life") is an infinite loop, and the
 * table asked the same questions every round until everyone was dead. A real three-player game: after two rounds
 * answered by hand the next question offers the loop; accepting it answers the rounds without asking; when the
 * drained opponent is out the loop pauses for one new target and goes on; the human wins. Needs -Dforge.assets.
 */
class LoopShortcutTest {
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

    private static int optionNamed(JsonObject priority, String name) {
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (name.equals(o.get("cardName").getAsString())) return o.get("index").getAsInt();
        }
        return -1;
    }

    @Test
    void aTriggerLoopIsOfferedAfterTwoRoundsAndRunsUntilTheTableIsDead() throws Exception {
        Deck deck = new Deck("Loop");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        List<String> notices = new ArrayList<>();
        human.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if ("prompt".equals(type)) queue.add(frame);
            if ("notice".equals(type) && frame.has("text")) notices.add(frame.get("text").getAsString());
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair")),
                new GameFactory.Seat("Casey", spikeDecks.get(1).deck(), GameFactory.ai("Casey"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        List<Player> opps = new ArrayList<>();
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) me = p;
            else opps.add(p);
        }
        final Player my = me;
        boolean[] setUp = {false};
        int[] byHand = {0}, offers = {0}, pauses = {0};
        int[] offeredSteps = new int[1];
        String[] pauseReason = new String[1];
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                put(game, my, "Enduring Tenacity");
                                put(game, my, "Bloodthirsty Conqueror");
                                put(game, my, "Ajani's Pridemate"); // a second life-gain trigger: the order is asked too
                                my.getZone(ZoneType.Hand).add(Card.fromPaperCard(card("Kabira Crossroads"), my));
                                opps.get(0).setLife(10, null);
                                opps.get(1).setLife(8, null);
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            int land = p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean() ? optionNamed(p, "Kabira Crossroads") : -1;
                            if (land >= 0) a.addProperty("option", land); // it gains 2 life: the loop starts
                            else a.add("option", null);
                        }
                        case "order", "targets" -> {
                            String note = kind + ": " + p.get("title").getAsString();
                            if (p.has("loop")) {
                                offers[0]++;
                                offeredSteps[0] = p.getAsJsonObject("loop").get("steps").getAsInt();
                                a.addProperty("loop", 500);
                                note += " [loop offered: run it]";
                            } else {
                                if (p.has("loopPaused")) {
                                    pauses[0]++;
                                    pauseReason[0] = p.getAsJsonObject("loopPaused").get("reason").getAsString();
                                    note += " [paused: " + pauseReason[0] + "]";
                                }
                                byHand[0]++;
                                JsonArray picks = new JsonArray();
                                if ("order".equals(kind)) {
                                    for (int i = 0; i < p.getAsJsonArray("items").size(); i++) picks.add(i);
                                    a.add("order", picks);
                                } else {
                                    picks.add(0); // the first opponent listed
                                    a.add("options", picks);
                                }
                            }
                            trace.add(note);
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
        }, "loop-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace) + "\nnotices: " + notices + "\nlife: " + opps.get(0).getLife() + " / " + opps.get(1).getLife();

        assertTrue(offers[0] >= 1, "the loop is offered" + why);
        assertEquals(2, offeredSteps[0], "a round is two questions: the order, then the target" + why);
        assertTrue(pauses[0] >= 1, "the loop pauses when the opponent it drained is out" + why);
        assertTrue(pauseReason[0] != null && pauseReason[0].contains("is no longer a choice"), "and says why: " + pauseReason[0] + why);
        assertTrue(opps.get(0).hasLost() && opps.get(1).hasLost(), "both opponents are dead" + why);
        assertTrue(game.isGameOver() && !my.hasLost(), "the human won" + why);
        // nine rounds kill 10 + 8 life two at a time: by hand that is 18 questions; with the loop, the two
        // rounds that show it (4) and one new target per opponent after the first
        assertTrue(byHand[0] <= 6, "questions answered by hand: " + byHand[0] + why);
    }

    /**
     * Owner request 2026-11-21, from a game an opponent's Scute Swarms ended as a draw: "have a response to X amount
     * of triggers to do one thing and the rest to do another". The human has Authority of the Consuls and Niv-Mizzet,
     * Ghost Counsel; the AI's sixty Scute Swarms see a land enter. Sixty times: a token, 1 life, "pay that much life
     * and draw that many cards?". Yes three times by hand, then the offer: "Yes for 5 more, then No for the rest".
     * The loop runs on top of the opponent's triggers that were already on the stack, and nobody is asked again.
     */
    @Test
    void yesForSomeTriggersThenNoForTheRestOverAnOpponentsStack() throws Exception {
        final int swarms = 60;
        Deck deck = new Deck("Consuls");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        List<String> notices = new ArrayList<>();
        Player[] meRef = new Player[1];
        int[] lifeAtStart = {0}, handAtStart = {0}, lifeAtEnd = {-1}, handAtEnd = {-1};
        human.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if ("prompt".equals(type)) queue.add(frame);
            if ("notice".equals(type) && frame.has("text") && "Loop".equals(frame.get("title").getAsString())) {
                // the loop is over (game thread): read the result and end the game here
                notices.add(frame.get("text").getAsString());
                lifeAtEnd[0] = meRef[0].getLife();
                handAtEnd[0] = meRef[0].getCardsIn(ZoneType.Hand).size();
                human.requestConcede();
            }
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Glarb", spikeDecks.get(0).deck(), GameFactory.ai("Glarb"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player opp = null;
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) meRef[0] = p;
            else opp = p;
        }
        final Player my = meRef[0];
        final Player them = opp;
        boolean[] setUp = {false}, landed = {false}, offered = {false};
        int[] byHand = {0}, afterOffer = {0};
        JsonObject[] offer = new JsonObject[1];
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                put(game, my, "Authority of the Consuls");
                                put(game, my, "Niv-Mizzet, Ghost Counsel");
                                for (int i = 0; i < swarms; i++) put(game, them, "Scute Swarm");
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            if (!landed[0] && p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean()) {
                                landed[0] = true;
                                lifeAtStart[0] = my.getLife();
                                handAtStart[0] = my.getCardsIn(ZoneType.Hand).size();
                                put(game, them, "Forest"); // landfall, sixty times
                            }
                            if (offered[0]) trace.add("priority after the offer: stackEmpty " + p.get("stackEmpty"));
                            a.add("option", null);
                        }
                        case "confirm" -> {
                            if (offered[0]) afterOffer[0]++;
                            if (p.has("loop") && !offered[0]) {
                                offered[0] = true;
                                offer[0] = p.getAsJsonObject("loop").deepCopy();
                                a.addProperty("loop", 5);
                                a.addProperty("then", "other");
                                trace.add("confirm: " + p.get("title").getAsString() + " [offer " + offer[0] + "]");
                            } else {
                                byHand[0]++;
                                a.addProperty("confirm", true);
                                trace.add("confirm by hand: " + p.get("title").getAsString());
                            }
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
        }, "consuls-loop-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace) + "\nnotices: " + notices;

        assertTrue(offered[0], "the fourth identical answer carries the offer" + why);
        assertEquals(1, offer[0].get("steps").getAsInt(), why);
        assertTrue(offer[0].has("flip"), "a single yes/no question can be answered one way, then the other" + why);
        assertEquals(3, byHand[0], "three by hand, then the loop" + why);
        assertEquals(0, afterOffer[0], "nobody is asked again" + why);
        assertEquals(1, notices.size(), why);
        assertTrue(notices.get(0).contains(" 5 times, then ") && notices.get(0).contains(" 52 times"), "yes for 5 more, then no for the other 52: " + notices.get(0) + why);
        assertTrue(notices.get(0).contains("nothing was left on the stack"), "it ran until the stack was empty: " + notices.get(0) + why);
        assertEquals(8, handAtEnd[0] - handAtStart[0], "eight cards drawn (3 by hand + 5)" + why);
        assertEquals(swarms - 8, lifeAtEnd[0] - lifeAtStart[0], "sixty life gained, eight paid" + why);
        assertTrue(game.getOutcome() == null || !game.getOutcome().isDraw(), "and the game is not a draw" + why);
    }
}
