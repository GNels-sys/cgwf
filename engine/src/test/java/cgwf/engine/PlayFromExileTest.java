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
 * Owner report 2026-10-25 (Fire Lord Zuko deck): cards that may be played from exile never could be. Party
 * Thrasher ("exile the top two cards of your library, then choose one of them. You may play that card this
 * turn") and Inside Information ("exile the top X cards of target opponent's library. You may play those cards
 * this turn ... pay life equal to its mana value"). A real game: the human gets the trigger and the spell, the
 * exiled cards must show up in the priority list and in the seat's view, and casting one must put it onto the
 * battlefield. Needs -Dforge.assets.
 */
class PlayFromExileTest {
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

    private static Card onTop(Player p, String name) {
        Card c = Card.fromPaperCard(card(name), p);
        p.getZone(ZoneType.Library).add(c, 0);
        return c;
    }

    private static boolean onBattlefield(Game game, Player p, String name) {
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals(name)) return true;
        return false;
    }

    /** The priority option for a card with this name in exile, or -1. */
    private static int exileOption(JsonObject priority, String name) {
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (name.equals(o.get("cardName").getAsString()) && "Exile".equals(o.get("zone").getAsString())) return o.get("index").getAsInt();
        }
        return -1;
    }

    @Test
    void cardsExiledByPartyThrasherAndInsideInformationCanBePlayed() throws Exception {
        Deck deck = new Deck("Zuko");
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
        Player opp = null;
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) me = p;
            else opp = p;
        }
        final Player my = me;
        final Player them = opp;
        boolean[] setUp = {false};
        String[] thrasherPick = new String[1];
        boolean[] thrasherOffered = {false};
        boolean[] thrasherCast = {false};
        boolean[] thrasherLanded = {false};
        boolean[] infoCast = {false};
        boolean[] infoOffered = {false};
        String[] infoPick = new String[1];
        boolean[] infoLanded = {false};
        int[] lifeBefore = new int[1];
        int[] lifeAfter = new int[1];
        boolean[] visibleInView = {false};
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(120, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    trace.add(kind + ": " + (p.has("title") ? p.get("title").getAsString() : ""));
                    JsonObject a = new JsonObject();
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                put(game, my, "Party Thrasher");
                                for (String land : List.of("Swamp", "Swamp", "Swamp", "Swamp", "Mountain", "Mountain", "Mountain", "Mountain")) put(game, my, land);
                                my.getZone(ZoneType.Hand).add(Card.fromPaperCard(card("Inside Information"), my));
                                // the top of my library: a Mountain for a draw step, then the two cards Party Thrasher exiles
                                onTop(my, "Hill Giant");
                                onTop(my, "Raging Goblin");
                                onTop(my, "Mountain");
                                onTop(them, "Elvish Mystic");
                                onTop(them, "Llanowar Elves");
                            }
                            a.addProperty("keep", true);
                        }
                        case "choose" -> {
                            int idx = 0;
                            JsonArray opts = p.getAsJsonArray("options");
                            for (int i = 0; i < opts.size(); i++) {
                                JsonObject o = opts.get(i).getAsJsonObject();
                                String n = o.has("name") ? o.get("name").getAsString() : o.has("label") ? o.get("label").getAsString() : "";
                                if (n.contains("Raging Goblin") || n.contains("Hill Giant")) { idx = i; thrasherPick[0] = n.contains("Raging Goblin") ? "Raging Goblin" : "Hill Giant"; break; }
                            }
                            a.addProperty("option", idx);
                        }
                        case "chooseMany" -> {
                            String title = p.has("title") ? p.get("title").getAsString() : "";
                            if (!title.contains("exiled")) { a = ScriptedSeat.answer(p, my.getId()); break; }
                            trace.add("exiled choice: " + p.getAsJsonArray("options"));
                            JsonArray pick = new JsonArray();
                            JsonArray opts = p.getAsJsonArray("options");
                            for (int i = 0; i < opts.size() && pick.isEmpty(); i++) {
                                String n = opts.get(i).toString();
                                if (n.contains("Raging Goblin")) { pick.add(i); thrasherPick[0] = "Raging Goblin"; }
                                else if (n.contains("Hill Giant")) { pick.add(i); thrasherPick[0] = "Hill Giant"; }
                            }
                            a.add("options", pick);
                        }
                        case "number" -> a.addProperty("value", 2);
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (!myMain) { a.add("option", null); break; }
                            if (thrasherPick[0] != null && !thrasherCast[0]) {
                                int idx = exileOption(p, thrasherPick[0]);
                                thrasherOffered[0] = idx >= 0;
                                trace.add("options after Party Thrasher: " + p.getAsJsonArray("options"));
                                thrasherCast[0] = true;
                                if (idx >= 0) { a.addProperty("option", idx); break; }
                            }
                            if (thrasherCast[0] && !infoCast[0]) {
                                thrasherLanded[0] = onBattlefield(game, my, thrasherPick[0]);
                                int idx = -1;
                                for (JsonElement e : p.getAsJsonArray("options")) {
                                    JsonObject o = e.getAsJsonObject();
                                    if ("Inside Information".equals(o.get("cardName").getAsString())) idx = o.get("index").getAsInt();
                                }
                                assertTrue(idx >= 0, "Inside Information is castable: " + p.getAsJsonArray("options"));
                                infoCast[0] = true;
                                a.addProperty("option", idx);
                                break;
                            }
                            if (infoCast[0] && infoPick[0] == null) {
                                trace.add("options after Inside Information: " + p.getAsJsonArray("options"));
                                String view = SeatView.build(game, my).toString();
                                visibleInView[0] = view.contains("Llanowar Elves");
                                int idx = exileOption(p, "Llanowar Elves");
                                infoOffered[0] = idx >= 0;
                                infoPick[0] = "Llanowar Elves";
                                if (idx >= 0) {
                                    lifeBefore[0] = my.getLife();
                                    a.addProperty("option", idx);
                                    break;
                                }
                            }
                            infoLanded[0] = onBattlefield(game, my, "Llanowar Elves");
                            lifeAfter[0] = my.getLife();
                            a.addProperty("concede", true);
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
        }, "exile-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace);

        assertNotNull(thrasherPick[0], "Party Thrasher let the human choose an exiled card" + why);
        assertTrue(thrasherOffered[0], "the chosen card is offered from exile" + why);
        assertTrue(thrasherLanded[0], thrasherPick[0] + " is on the battlefield" + why);
        assertTrue(infoCast[0], "Inside Information was cast" + why);
        assertTrue(visibleInView[0], "the seat sees the opponent's exiled cards" + why);
        assertTrue(infoOffered[0], "the opponent's exiled card is offered" + why);
        assertTrue(infoLanded[0], "Llanowar Elves is on the battlefield under the human" + why);
        assertEquals(lifeBefore[0] - 1, lifeAfter[0], "paid 1 life (its mana value) instead of mana" + why);
    }
}
