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
import forge.game.card.CounterEnumType;
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
 * Loyalty abilities through the real BridgeController in a real game (Forge's own priority loop):
 * each planeswalker may activate one loyalty ability per turn (two walkers = two activations); a walker
 * that is blinked (Displacer Kitten, after casting a noncreature spell) returns as a new object with its
 * printed loyalty and may activate again; Oath of Teferi allows a second activation per walker. The
 * Kitten's target is the human's choice (a targets prompt), never Forge's AI. Needs -Dforge.assets.
 */
class PlaneswalkerTest {
    private static List<DeckLoader.Loaded> spikeDecks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)),
                "set -Dforge.assets=/path/to/forge-gui (or FORGE_ASSETS) to run the planeswalker test");
        ForgeBoot.init(Path.of(assets), true);
        spikeDecks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 2);
    }

    private static PaperCard card(String name) {
        PaperCard pc = StaticData.instance().getCommonCards().getCard(name);
        assertNotNull(pc, "Forge knows " + name);
        return pc;
    }

    private static JsonObject answer(String key, int value) {
        JsonObject a = new JsonObject();
        a.addProperty(key, value);
        return a;
    }

    /** Loyalty options of this card (by its live id) in a priority prompt. */
    private static List<JsonObject> loyalty(JsonObject prompt, Game game, Card c) {
        List<JsonObject> out = new ArrayList<>();
        int id = game.getCardState(c).getId();
        for (JsonElement e : prompt.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            String cost = o.get("cost").isJsonNull() ? "" : o.get("cost").getAsString();
            if ("ability".equals(o.get("kind").getAsString()) && o.get("cardId").getAsInt() == id && cost.matches("[-+]?([0-9]+|X)")) out.add(o);
        }
        return out;
    }

    private static int indexOf(List<JsonObject> opts, String text) {
        for (JsonObject o : opts) if (o.get("description").getAsString().contains(text)) return o.get("index").getAsInt();
        throw new AssertionError("no option containing '" + text + "' in " + opts);
    }

    /** Everything the scripted human saw at each of its main-phase priority decisions. */
    static final class Seen {
        final List<String> steps = new ArrayList<>();
        final List<String> errors = new ArrayList<>();
        JsonObject kittenTargets;
        int ajaniLoyaltyAfterBlink = -1;
    }

    @Test
    void eachPlaneswalkerActivatesOncePerTurnBlinkedOnesAreNewAndOathAllowsTwice() throws Exception {
        Deck deck = new Deck("Walkers");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);

        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        Seen seen = new Seen();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if (type.equals("prompt")) queue.add(frame);
            else if (type.equals("error")) seen.errors.add(frame.get("message").getAsString());
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) me = p;
        final Player my = me;
        Card[] walkers = new Card[2]; // Ajani, Garruk
        Card[] mox = new Card[1];

        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            int step = 0;
            JsonObject current = null;
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    current = p;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "choose" -> {
                            // who plays first: me, so turn 1 is mine
                            JsonArray opts = p.getAsJsonArray("options");
                            int pick = 0;
                            for (int i = 0; i < opts.size(); i++) {
                                JsonObject o = opts.get(i).getAsJsonObject();
                                if (o.has("id") && o.get("id").getAsInt() == my.getId()) pick = i;
                            }
                            a = answer("option", pick);
                        }
                        case "mulligan" -> {
                            // before the first turn (the game thread is parked in ask()): the walkers, the Kitten, a Mox in hand
                            if (walkers[0] == null) {
                                walkers[0] = put(game, my, "Ajani Goldmane");
                                walkers[1] = put(game, my, "Garruk Wildspeaker");
                                put(game, my, "Displacer Kitten");
                                mox[0] = Card.fromPaperCard(card("Mox Opal"), my);
                                my.getZone(ZoneType.Hand).add(mox[0]);
                            }
                            a.addProperty("keep", true);
                        }
                        case "targets" -> {
                            // the Kitten's "exile up to one target nonland permanent you control": Ajani
                            seen.kittenTargets = p;
                            JsonArray opts = p.getAsJsonArray("options");
                            JsonArray pick = new JsonArray();
                            for (int i = 0; i < opts.size(); i++) {
                                JsonObject o = opts.get(i).getAsJsonObject();
                                if (o.has("name") && o.get("name").getAsString().equals("Ajani Goldmane")) pick.add(i);
                            }
                            a.add("options", pick);
                        }
                        case "priority" -> {
                            boolean mainOfMine = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "")
                                    && p.get("stackEmpty").getAsBoolean();
                            if (!mainOfMine || walkers[0] == null) {
                                if (step >= 6) a.addProperty("concede", true);
                                else a.add("option", null);
                                break;
                            }
                            List<JsonObject> aj = loyalty(p, game, walkers[0]);
                            List<JsonObject> ga = loyalty(p, game, walkers[1]);
                            seen.steps.add("step " + step + ": ajani=" + aj.size() + " garruk=" + ga.size());
                            switch (step) {
                                case 0 -> { // both walkers offered: activate Ajani
                                    assertTrue(!aj.isEmpty() && !ga.isEmpty(), "both walkers are offered: " + seen.steps);
                                    a = answer("option", indexOf(aj, "gain 2 life"));
                                }
                                case 1 -> { // Ajani is done for the turn; Garruk is not
                                    assertEquals(5, game.getCardState(walkers[0]).getCounters(CounterEnumType.LOYALTY));
                                    assertTrue(aj.isEmpty(), "Ajani already activated this turn: " + seen.steps);
                                    assertTrue(!ga.isEmpty(), "a second planeswalker may still activate: " + seen.steps);
                                    a = answer("option", indexOf(ga, "Beast"));
                                }
                                case 2 -> { // neither again; cast the Mox (noncreature) to trigger the Kitten
                                    assertTrue(aj.isEmpty() && ga.isEmpty(), "neither walker a second time: " + seen.steps);
                                    int moxIdx = -1;
                                    for (JsonElement e : p.getAsJsonArray("options")) {
                                        JsonObject o = e.getAsJsonObject();
                                        if ("spell".equals(o.get("kind").getAsString()) && o.get("cardId").getAsInt() == mox[0].getId()) moxIdx = o.get("index").getAsInt();
                                    }
                                    assertTrue(moxIdx >= 0, "the Mox is castable");
                                    a = answer("option", moxIdx);
                                }
                                case 3 -> { // Ajani came back as a new object: 4 loyalty, may activate again; Garruk may not
                                    seen.ajaniLoyaltyAfterBlink = game.getCardState(walkers[0]).getCounters(CounterEnumType.LOYALTY);
                                    assertTrue(!aj.isEmpty(), "the blinked Ajani may activate again this turn: " + seen.steps);
                                    assertTrue(ga.isEmpty(), "Garruk still may not: " + seen.steps);
                                    a = answer("option", indexOf(aj, "gain 2 life"));
                                }
                                case 4 -> { // the new Ajani has used his activation; now Oath of Teferi (straight in: its static only)
                                    assertTrue(aj.isEmpty() && ga.isEmpty(), "both used: " + seen.steps);
                                    Card oath = Card.fromPaperCard(card("Oath of Teferi"), my);
                                    my.getZone(ZoneType.Battlefield).add(oath);
                                    game.getAction().checkStaticAbilities();
                                    a = answer("option", 9999); // out of range: Forge asks again with a fresh list
                                }
                                case 5 -> { // Oath: one more each
                                    assertTrue(!ga.isEmpty() && !aj.isEmpty(), "Oath of Teferi allows a second activation each: " + seen.steps);
                                    a = answer("option", indexOf(ga, "Beast"));
                                }
                                default -> { // Garruk has now used both; then stop the game
                                    assertTrue(ga.isEmpty(), "not a third time: " + seen.steps);
                                    a.addProperty("concede", true);
                                }
                            }
                            step++;
                        }
                        default -> a = ScriptedSeat.answer(p, my.getId());
                    }
                    a.add("promptId", p.get("promptId"));
                    human.answer(a);
                }
            } catch (InterruptedException stop) {
                // the game is over and the test stopped this thread
            } catch (Throwable t) {
                failure.set(t);
                // concede on the prompt being answered, then keep conceding so a failed run ends at once
                try {
                    JsonObject p = current;
                    while (p != null) {
                        JsonObject c = new JsonObject();
                        c.addProperty("concede", true);
                        c.add("promptId", p.get("promptId"));
                        human.answer(c);
                        p = queue.poll(5, TimeUnit.SECONDS);
                    }
                } catch (InterruptedException ignored) { }
            }
        }, "walker-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError("steps " + seen.steps, failure.get());

        assertTrue(seen.steps.size() >= 7, "the scripted turn ran through: " + seen.steps);
        assertNotNull(seen.kittenTargets, "the human chose the Kitten's target (not Forge's AI)");
        assertEquals(4, seen.ajaniLoyaltyAfterBlink, "the blinked Ajani is a new object with his printed loyalty");
        assertTrue(seen.errors.stream().allMatch(m -> m.contains("out of range")), "no other errors: " + seen.errors);
    }

    private static Card put(Game game, Player p, String name) {
        Card c = Card.fromPaperCard(card(name), p);
        p.getZone(ZoneType.Hand).add(c);
        return game.getAction().moveToPlay(c, p, null, null);
    }
}
