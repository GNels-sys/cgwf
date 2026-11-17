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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-17: prepared spells (Secrets of Strixhaven) "could not be cast". A prepared creature
 * keeps a copy of its spell in exile; the seat may cast that copy, which unprepares the creature. Real games:
 * the human casts Blazing Firesinger (enters prepared, Seething Song), is offered the spell and casts it; Grave
 * Researcher (prepared each upkeep with three creature cards in the graveyard, Reanimate) is prepared, cast and
 * prepared again a turn later. The engine was right all along; what was missing is on the screen, so the seat's
 * view must say which creature is prepared, with which spell, and which exiled copy belongs to it.
 * Needs -Dforge.assets.
 */
class PreparedSpellTest {
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

    /** The view's card with this name in one of my zones. */
    private static JsonObject viewCard(JsonObject view, int playerId, String zone, String name) {
        for (JsonElement pe : view.getAsJsonArray("players")) {
            JsonObject p = pe.getAsJsonObject();
            if (p.get("id").getAsInt() != playerId) continue;
            for (JsonElement ce : p.getAsJsonArray(zone)) {
                JsonObject c = ce.getAsJsonObject();
                if (c.has("name") && name.equals(c.get("name").getAsString())) return c;
            }
        }
        return null;
    }

    private static int option(JsonObject priority, String name) {
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (o.toString().contains(name)) return o.get("index").getAsInt();
        }
        return -1;
    }

    @Test
    void aPreparedSpellIsOfferedAndCanBeCast() throws Exception {
        Deck deck = new Deck("Prepared");
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
        boolean[] setUp = {false};
        int[] step = {0};
        boolean[] offered = {false};
        boolean[] cast = {false};
        boolean[] unprepared = {false};
        JsonObject[] viewBefore = new JsonObject[1];
        JsonObject[] viewAfter = new JsonObject[1];
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
                                for (int i = 0; i < 8; i++) put(game, my, "Mountain");
                                my.getZone(ZoneType.Hand).add(Card.fromPaperCard(card("Blazing Firesinger"), my));
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (!myMain) { a.add("option", null); break; }
                            if (step[0] == 0) {
                                int idx = option(p, "Blazing Firesinger");
                                assertTrue(idx >= 0, "Blazing Firesinger is castable: " + p.getAsJsonArray("options"));
                                step[0] = 1;
                                a.addProperty("option", idx);
                                break;
                            }
                            if (step[0] == 1) {
                                step[0] = 2;
                                trace.add("options after it entered: " + p.getAsJsonArray("options"));
                                viewBefore[0] = SeatView.build(game, my);
                                int idx = option(p, "Seething Song");
                                offered[0] = idx >= 0;
                                if (idx >= 0) { a.addProperty("option", idx); break; }
                            }
                            if (step[0] == 2) {
                                step[0] = 3;
                                trace.add("pool after the cast: " + my.getManaPool().totalMana() + "; options: " + p.getAsJsonArray("options"));
                                cast[0] = my.getManaPool().totalMana() >= 5 || option(p, "Seething Song") < 0;
                                for (Card c : my.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals("Blazing Firesinger")) unprepared[0] = !c.isPrepared();
                                viewAfter[0] = SeatView.build(game, my);
                            }
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
        }, "prepared-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace);
        assertTrue(offered[0], "the prepared spell is offered" + why);
        assertTrue(cast[0], "the prepared spell was cast" + why);
        assertTrue(unprepared[0], "casting it unprepared the creature" + why);

        // what the screen needs: the creature says it is prepared and with what; the exiled copy names its creature
        JsonObject singer = viewCard(viewBefore[0], my.getId(), "battlefield", "Blazing Firesinger");
        assertNotNull(singer, "the creature is in the view" + why);
        JsonObject prepare = singer.getAsJsonObject("prepare");
        assertNotNull(prepare, "the creature carries its prepared spell: " + singer);
        assertEquals("Seething Song", prepare.get("name").getAsString());
        assertTrue(prepare.get("ready").getAsBoolean(), "it is prepared: " + prepare);
        JsonObject copy = viewCard(viewBefore[0], my.getId(), "exile", "Seething Song");
        assertNotNull(copy, "the spell's copy waits in exile" + why);
        assertEquals(copy.get("id").getAsInt(), prepare.get("cardId").getAsInt(), "the creature points at that copy");
        assertEquals(singer.get("id").getAsInt(), copy.get("preparedBy").getAsInt(), "and the copy at its creature");
        assertEquals("Blazing Firesinger", copy.get("preparedByName").getAsString());
        JsonObject spent = viewCard(viewAfter[0], my.getId(), "battlefield", "Blazing Firesinger").getAsJsonObject("prepare");
        assertEquals("Seething Song", spent.get("name").getAsString(), "the spell is still named once it is spent");
        assertFalse(spent.get("ready").getAsBoolean(), "but it is not prepared any more: " + spent);
        assertFalse(spent.has("cardId"), "and nothing waits in exile: " + spent);
        assertNull(viewCard(viewAfter[0], my.getId(), "exile", "Seething Song"), "the copy is gone from exile");
    }

    /**
     * The owner's card: Grave Researcher ("At the beginning of your upkeep, surveil 1. Then if there are three or
     * more creature cards in your graveyard, this creature becomes prepared", Reanimate). Prepared on one upkeep,
     * cast, and prepared again on the next.
     */
    @Test
    void graveResearcherIsPreparedCastAndPreparedAgain() throws Exception {
        Deck deck = new Deck("Researcher");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Swamp"), 99);
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
        boolean[] setUp = {false};
        List<Integer> castOnTurn = new ArrayList<>();
        List<String> returned = new ArrayList<>();
        boolean[] notPreparedBeforeUpkeep = {false};
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
                                for (int i = 0; i < 4; i++) put(game, my, "Swamp");
                                Card researcher = put(game, my, "Grave Researcher");
                                notPreparedBeforeUpkeep[0] = !researcher.isPrepared();
                                for (String name : List.of("Grizzly Bears", "Hill Giant", "Raging Goblin", "Runeclaw Bear", "Elvish Mystic", "Llanowar Elves")) {
                                    my.getZone(ZoneType.Graveyard).add(Card.fromPaperCard(card(name), my));
                                }
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (!myMain) { a.add("option", null); break; }
                            int turn = game.getPhaseHandler().getTurn();
                            int idx = option(p, "Reanimate");
                            if (idx >= 0 && !castOnTurn.contains(turn)) {
                                castOnTurn.add(turn);
                                trace.add("turn " + turn + ": Reanimate offered: " + p.getAsJsonArray("options").get(idx));
                                a.addProperty("option", idx);
                                break;
                            }
                            if (castOnTurn.size() >= 2) {
                                for (Card c : my.getCardsIn(ZoneType.Battlefield)) if (c.isCreature() && !c.getName().equals("Grave Researcher")) returned.add(c.getName());
                                a.addProperty("concede", true);
                                break;
                            }
                            if (turn > 12) { a.addProperty("concede", true); break; }
                            a.add("option", null);
                            a.addProperty("passUntilTurn", turn);
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
        }, "researcher-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        String why = "\n" + String.join("\n", trace);
        assertTrue(notPreparedBeforeUpkeep[0], "it does not enter prepared" + why);
        assertEquals(2, castOnTurn.size(), "Reanimate was offered and cast on two of my turns" + why);
        assertTrue(castOnTurn.get(1) > castOnTurn.get(0), "the second time on a later turn: " + castOnTurn);
        assertEquals(2, returned.size(), "each cast returned a creature from the graveyard: " + returned + why);
    }
}
