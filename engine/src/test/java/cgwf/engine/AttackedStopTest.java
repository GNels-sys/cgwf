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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-21: attacked for lethal by ten creatures while holding Tangle ("prevent all combat damage
 * that would be dealt this turn") with the mana untapped, the table asked only about blockers and the damage was
 * dealt. An attack does not use the stack and another player's combat steps are not stops by default, so the seat's
 * priority was passed for it. Real games: with the default stops the seat is asked after attackers and again after
 * blocks, Tangle cast there prevents the damage; with "ask me when I am attacked" off nothing is asked, as before.
 * Needs -Dforge.assets.
 */
class AttackedStopTest {
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

    /** What one game showed. */
    private record Result(List<String> attackPrompts, boolean blockersAsked, boolean tangleOffered, boolean tangleCast, int lifeBefore, int lifeAfter, boolean attacked, List<String> trace) { }

    /**
     * The AI has five Craw Wurms, the human a Grizzly Bears, two Forests and Tangle in hand. On the AI's turn the
     * wurms attack; the human declares no blocks and casts Tangle at the priority that follows, if one is offered.
     */
    private static Result attackedWithTangleInHand(boolean askWhenAttacked) throws Exception {
        Deck deck = new Deck("Tangle");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        if (!askWhenAttacked) {
            JsonObject stops = human.stops().toJson();
            stops.addProperty("attacked", false);
            human.setStops(stops);
        }
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Hazel", spikeDecks.get(0).deck(), GameFactory.ai("Hazel"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        Player opp = null;
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) me = p;
            else opp = p;
        }
        final Player my = me;
        final Player them = opp;
        boolean[] setUp = {false}, blockersAsked = {false}, offered = {false}, cast = {false}, attacked = {false}, done = {false};
        int[] lifeBefore = {0}, lifeAfter = {-1}, combatTurn = {-1};
        List<String> attackPrompts = new ArrayList<>();
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
                                put(game, my, "Forest");
                                put(game, my, "Forest");
                                put(game, my, "Grizzly Bears");
                                my.getZone(ZoneType.Hand).add(Card.fromPaperCard(card("Tangle"), my));
                                for (int i = 0; i < 5; i++) put(game, them, "Craw Wurm");
                                lifeBefore[0] = my.getLife();
                            }
                            a.addProperty("keep", true);
                        }
                        case "attackers" -> a.add("attacks", new JsonArray()); // the Bears stay home, untapped, to be able to block
                        case "blockers" -> {
                            blockersAsked[0] = true;
                            attacked[0] = true;
                            combatTurn[0] = game.getPhaseHandler().getTurn();
                            a.add("blocks", new JsonArray()); // "I declared no blockers"
                            trace.add("blockers: none declared");
                        }
                        case "priority" -> {
                            String phase = p.has("phase") && !p.get("phase").isJsonNull() ? p.get("phase").getAsString() : "";
                            boolean myTurn = p.get("myTurn").getAsBoolean();
                            if (p.has("attack")) {
                                attacked[0] = true;
                                combatTurn[0] = game.getPhaseHandler().getTurn();
                                attackPrompts.add(phase + ": " + p.get("attack").getAsString());
                            }
                            int tangle = optionNamed(p, "Tangle");
                            trace.add("priority " + phase + (myTurn ? " (mine)" : " (theirs)") + (p.has("attack") ? " attack='" + p.get("attack").getAsString() + "'" : "") + " tangle=" + (tangle >= 0));
                            if (!myTurn && "COMBAT_DECLARE_BLOCKERS".equals(phase) && tangle >= 0 && !cast[0]) {
                                offered[0] = true;
                                cast[0] = true;
                                a.addProperty("option", tangle);
                            } else if (combatTurn[0] > 0 && game.getPhaseHandler().getTurn() > combatTurn[0] && !done[0]) {
                                done[0] = true; // the turn after the attack: read the result, stop the game
                                lifeAfter[0] = my.getLife();
                                a.addProperty("concede", true);
                            } else {
                                a.add("option", null);
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
        }, "tangle-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        if (lifeAfter[0] < 0) lifeAfter[0] = my.getLife(); // the game ended before the next turn (the damage was lethal)
        return new Result(attackPrompts, blockersAsked[0], offered[0], cast[0], lifeBefore[0], lifeAfter[0], attacked[0], trace);
    }

    @Test
    void anAttackedSeatIsAskedAfterAttackersAndAfterBlocksAndCanPreventTheDamage() throws Exception {
        Result r = attackedWithTangleInHand(true);
        String why = "\n" + String.join("\n", r.trace());
        assertTrue(r.attacked(), "the AI attacked" + why);
        assertTrue(r.blockersAsked(), "blockers were asked" + why);
        assertEquals(2, r.attackPrompts().size(), "asked once after attackers and once after blocks: " + r.attackPrompts() + why);
        assertTrue(r.attackPrompts().get(0).startsWith("COMBAT_DECLARE_ATTACKERS: Hazel attacks you with "), r.attackPrompts().get(0) + why);
        assertTrue(r.attackPrompts().get(1).startsWith("COMBAT_DECLARE_BLOCKERS: Blocks are declared: Hazel's "), r.attackPrompts().get(1) + why);
        assertTrue(r.tangleCast(), "Tangle was offered after the blocks and cast" + why);
        assertEquals(r.lifeBefore(), r.lifeAfter(), "all combat damage was prevented" + why);
    }

    @Test
    void withTheSettingOffTheSeatIsNotAskedDuringAnotherPlayersCombat() throws Exception {
        Result r = attackedWithTangleInHand(false);
        String why = "\n" + String.join("\n", r.trace());
        assertTrue(r.attacked(), "the AI attacked" + why);
        assertEquals(0, r.attackPrompts().size(), "no priority during the attack: " + r.attackPrompts() + why);
        assertFalse(r.tangleCast(), why);
        assertTrue(r.lifeAfter() < r.lifeBefore(), "and the damage was dealt" + why);
    }

    @Test
    void theSettingIsOnByDefaultAndAnOlderRelayThatDoesNotSendItKeepsItOn() {
        BridgeSession s = new BridgeSession(0, 1_000);
        assertTrue(s.stops().toJson().get("attacked").getAsBoolean());
        assertTrue(s.attackStops("5:COMBAT_DECLARE_ATTACKERS"));
        s.attackAsked("5:COMBAT_DECLARE_ATTACKERS");
        assertFalse(s.attackStops("5:COMBAT_DECLARE_ATTACKERS"), "once per combat step");
        assertTrue(s.attackStops("5:COMBAT_DECLARE_BLOCKERS"), "and again after blocks");
        JsonObject older = s.stops().toJson();
        older.remove("attacked");
        s.setStops(older);
        assertTrue(s.stops().toJson().get("attacked").getAsBoolean());
        JsonObject off = s.stops().toJson();
        off.addProperty("attacked", false);
        s.setStops(off);
        assertFalse(s.attackStops("6:COMBAT_DECLARE_ATTACKERS"));
    }
}
