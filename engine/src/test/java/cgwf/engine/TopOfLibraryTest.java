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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-18 (a Y'shtola deck): with Bolas's Citadel on the battlefield ("You may look at the top
 * card of your library any time. You may play lands and cast spells from the top of your library. If you cast a
 * spell this way, pay life equal to its mana value rather than pay its mana cost.") the table showed no top card
 * and offered no way to play it. A real game: the seat's view must carry the top card of its own library (and
 * nobody else's view may), the priority list must offer it for life, and casting it must put it onto the
 * battlefield for that life. Needs -Dforge.assets.
 */
class TopOfLibraryTest {
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

    private static boolean onBattlefield(Player p, String name) {
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals(name)) return true;
        return false;
    }

    /** The name of the top card of my library as my own view shows it, or null when the view does not show one. */
    private static String shownTop(JsonObject view, Player me) {
        for (JsonElement e : view.getAsJsonArray("players")) {
            JsonObject pj = e.getAsJsonObject();
            if (pj.get("id").getAsInt() != me.getId() || !pj.has("libraryKnown")) continue;
            for (JsonElement k : pj.getAsJsonArray("libraryKnown")) {
                JsonObject c = k.getAsJsonObject();
                if (c.get("position").getAsInt() == 0 && c.has("name")) return c.get("name").getAsString();
            }
        }
        return null;
    }

    private static int libraryOption(JsonObject priority, String name) {
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (name.equals(o.get("cardName").getAsString()) && "Library".equals(o.get("zone").getAsString())) return o.get("index").getAsInt();
        }
        return -1;
    }

    @Test
    void bolassCitadelShowsTheTopCardAndLetsItBePlayedForLife() throws Exception {
        Deck deck = new Deck("Citadel");
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
        int[] step = {0};
        boolean[] spellSeen = {false}, spellOffered = {false}, spellLanded = {false};
        boolean[] landSeen = {false}, landOffered = {false}, landLanded = {false};
        boolean[] leaked = {false};
        String[] cost = new String[1];
        int[] lifeBefore = new int[1], lifeAfter = new int[1];
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
                                put(game, my, "Bolas's Citadel");
                                // the top of my library: two spells (the first may be drawn for the turn), then a land
                                onTop(my, "Swamp");
                                onTop(my, "Hill Giant");
                                onTop(my, "Hill Giant");
                                onTop(them, "Shivan Dragon");
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (!myMain) { a.add("option", null); break; }
                            JsonObject mineJson = SeatView.build(game, my);
                            String mine = mineJson.toString();
                            if (mine.contains("Shivan Dragon") || SeatView.build(game, them).toString().contains("libraryKnown") || SeatView.build(game, null).toString().contains("libraryKnown")) leaked[0] = true;
                            String top = my.getCardsIn(ZoneType.Library).get(0).getName();
                            String shown = shownTop(mineJson, my);
                            trace.add("top of my library: " + top + ", shown: " + shown + ", options: " + p.getAsJsonArray("options"));
                            if (step[0] == 1) { // the Hill Giant has resolved
                                step[0] = 2;
                                spellLanded[0] = onBattlefield(my, "Hill Giant");
                                lifeAfter[0] = my.getLife();
                            }
                            int idx = libraryOption(p, top);
                            if (top.equals("Hill Giant") && idx >= 0) {
                                if (step[0] == 0) {
                                    step[0] = 1;
                                    spellSeen[0] = top.equals(shown);
                                    spellOffered[0] = true;
                                    cost[0] = p.getAsJsonArray("options").get(idx).getAsJsonObject().get("cost").getAsString();
                                    lifeBefore[0] = my.getLife();
                                }
                                a.addProperty("option", idx); // the second one is cast only to get down to the land
                                break;
                            }
                            if (top.equals("Swamp") && !landOffered[0] && idx >= 0) {
                                landSeen[0] = top.equals(shown);
                                landOffered[0] = true;
                                a.addProperty("option", idx);
                                break;
                            }
                            landLanded[0] = onBattlefield(my, "Swamp");
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
        }, "citadel-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace);

        assertTrue(spellOffered[0], "the top card is offered from the library" + why);
        assertTrue(spellSeen[0], "the seat's view shows the top card of its library" + why);
        assertTrue(cost[0] != null && cost[0].toLowerCase().contains("life"), "it costs life, not mana: " + cost[0] + why);
        assertTrue(spellLanded[0], "Hill Giant is on the battlefield" + why);
        assertEquals(lifeBefore[0] - 4, lifeAfter[0], "paid 4 life (its mana value) instead of mana" + why);
        assertTrue(landSeen[0], "the next top card (a land) shows in the view" + why);
        assertTrue(landOffered[0], "the land on top is offered" + why);
        assertTrue(landLanded[0], "Swamp was played from the top of the library" + why);
        assertFalse(leaked[0], "no other library's top card, and nobody else sees mine" + why);
    }
}
