package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
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

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner question 2026-11-25 (a Hearthull deck): Six ("During your turn, nonland permanent cards in your graveyard
 * have retrace") never seemed to offer a graveyard cast. Retrace = cast the card from the graveyard by discarding
 * a land card in addition to its other costs. A real game: with Six out on my turn, a creature in my graveyard is
 * offered from the graveyard, casting it asks for a land to discard and puts it onto the battlefield; an instant in
 * the graveyard is not offered; a card with jump-start of its own (Risk Factor) is. Needs -Dforge.assets.
 */
class SixRetraceTest {
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

    private static Card put(Game game, Player p, String name) {
        Card c = Card.fromPaperCard(card(name), p);
        p.getZone(ZoneType.Hand).add(c);
        return game.getAction().moveToPlay(c, p, null, null);
    }

    private static void toGraveyard(Player p, String name) {
        p.getZone(ZoneType.Graveyard).add(Card.fromPaperCard(card(name), p));
    }

    private static int count(Player p, ZoneType z, String name) {
        int n = 0;
        for (Card c : p.getCardsIn(z)) if (c.getName().equals(name)) n++;
        return n;
    }

    private static int graveyardOption(JsonObject priority, String name) {
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (name.equals(o.get("cardName").getAsString()) && "Graveyard".equals(o.get("zone").getAsString())) return o.get("index").getAsInt();
        }
        return -1;
    }

    @Test
    void sixGivesRetraceToPermanentCardsInMyGraveyardOnMyTurn() throws Exception {
        Deck deck = new Deck("Six");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair"))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) me = p;
        final Player my = me;
        boolean[] setUp = {false}, offered = {false}, boltOffered = {false}, jumpStartOffered = {false}, discardAsked = {false}, landed = {false};
        int[] step = {0};
        int[] landsInHandBefore = new int[1], landsInHandAfter = new int[1];
        String[] cost = new String[1];
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    String title = p.has("title") ? p.get("title").getAsString() : "";
                    trace.add(kind + ": " + title);
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                put(game, my, "Six");
                                for (int i = 0; i < 4; i++) put(game, my, "Mountain");
                                toGraveyard(my, "Hill Giant");
                                toGraveyard(my, "Lightning Bolt");
                                toGraveyard(my, "Risk Factor");
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (!myMain) { a.add("option", null); break; }
                            trace.add("options: " + p.getAsJsonArray("options"));
                            if (step[0] == 1) {
                                step[0] = 2;
                                landed[0] = count(my, ZoneType.Battlefield, "Hill Giant") == 1;
                                landsInHandAfter[0] = count(my, ZoneType.Hand, "Mountain");
                                a.addProperty("concede", true);
                                break;
                            }
                            boltOffered[0] = graveyardOption(p, "Lightning Bolt") >= 0;
                            jumpStartOffered[0] = graveyardOption(p, "Risk Factor") >= 0;
                            int idx = graveyardOption(p, "Hill Giant");
                            if (idx >= 0 && step[0] == 0) {
                                step[0] = 1;
                                offered[0] = true;
                                cost[0] = p.getAsJsonArray("options").get(idx).getAsJsonObject().get("cost").getAsString();
                                landsInHandBefore[0] = count(my, ZoneType.Hand, "Mountain");
                                a.addProperty("option", idx);
                                break;
                            }
                            a.addProperty("concede", true);
                        }
                        case "chooseMany" -> {
                            if (title.toLowerCase().contains("discard")) discardAsked[0] = true;
                            a = ScriptedSeat.answer(p, my.getId());
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
        }, "six-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace);

        assertTrue(offered[0], "Hill Giant is offered from the graveyard (retrace)" + why);
        assertTrue(cost[0] != null && cost[0].toLowerCase().contains("discard"), "the cost names the discard: " + cost[0] + why);
        assertTrue(discardAsked[0], "the seat is asked which land to discard" + why);
        assertTrue(landed[0], "Hill Giant is on the battlefield" + why);
        assertTrue(landsInHandAfter[0] == landsInHandBefore[0] - 1, "one land left the hand: " + landsInHandBefore[0] + " -> " + landsInHandAfter[0] + why);
        assertFalse(boltOffered[0], "an instant does not get retrace from Six" + why);
        assertTrue(jumpStartOffered[0], "a jump-start card in the graveyard is offered too" + why);
        assertFalse(why.contains("Optional costs"), "retrace is not offered a second time as an optional cost" + why);
    }
}
