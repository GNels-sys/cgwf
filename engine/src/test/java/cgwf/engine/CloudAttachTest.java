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
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-10-20: Cloud, Ex-SOLDIER ("When Cloud enters, attach up to one target Equipment you control
 * to it") never got his Equipment. The engine asked correctly (a targets prompt, min 0, max 1) and the client
 * sent an empty answer. This proves the engine side end to end in a real game: the human casts Cloud with
 * Bloodforged Battle-Axe on the battlefield, the trigger asks the human (not Forge's AI), and choosing the Axe
 * leaves it attached to Cloud. Needs -Dforge.assets.
 */
class CloudAttachTest {
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

    @Test
    void cloudAttachesTheEquipmentTheHumanChooses() throws Exception {
        Deck deck = new Deck("Cloud");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair"))), 777L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) me = p;
        final Player my = me;
        Card[] axe = new Card[1];
        Card[] cloud = new Card[1];
        JsonObject[] targets = new JsonObject[1];
        Card[] attachedTo = new Card[1];
        boolean[] cast = {false};
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
                            if (axe[0] == null) { // before the first turn: the Axe and five lands out, Cloud in hand
                                axe[0] = put(game, my, "Bloodforged Battle-Axe");
                                for (String land : List.of("Plains", "Forest", "Mountain", "Mountain", "Mountain")) put(game, my, land);
                                cloud[0] = Card.fromPaperCard(card("Cloud, Ex-SOLDIER"), my);
                                my.getZone(ZoneType.Hand).add(cloud[0]);
                            }
                            a.addProperty("keep", true);
                        }
                        case "targets" -> {
                            targets[0] = p;
                            JsonArray pick = new JsonArray();
                            JsonArray opts = p.getAsJsonArray("options");
                            for (int i = 0; i < opts.size(); i++) {
                                JsonObject o = opts.get(i).getAsJsonObject();
                                if (o.has("name") && "Bloodforged Battle-Axe".equals(o.get("name").getAsString())) pick.add(i);
                            }
                            a.add("options", pick);
                        }
                        case "priority" -> {
                            boolean myMain = p.get("myTurn").getAsBoolean() && "MAIN1".equals(p.has("phase") ? p.get("phase").getAsString() : "") && p.get("stackEmpty").getAsBoolean();
                            if (myMain && !cast[0]) {
                                int idx = -1;
                                for (JsonElement e : p.getAsJsonArray("options")) {
                                    JsonObject o = e.getAsJsonObject();
                                    if ("spell".equals(o.get("kind").getAsString()) && o.get("cardId").getAsInt() == cloud[0].getId()) idx = o.get("index").getAsInt();
                                }
                                assertTrue(idx >= 0, "Cloud is castable: " + p.getAsJsonArray("options"));
                                cast[0] = true;
                                a.addProperty("option", idx);
                            } else if (myMain) { // Cloud and his trigger have resolved
                                Card live = game.getCardState(axe[0]);
                                attachedTo[0] = live.getAttachedTo() instanceof Card c ? c : null;
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
        }, "cloud-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(failure.get());

        assertTrue(cast[0], "Cloud was cast");
        assertNotNull(targets[0], "the trigger asked the human for its target");
        assertEquals(0, targets[0].get("min").getAsInt(), "up to one: min 0");
        assertEquals(1, targets[0].get("max").getAsInt());
        assertNotNull(attachedTo[0], "the Battle-Axe is attached");
        assertEquals("Cloud, Ex-SOLDIER", attachedTo[0].getName());
    }
}
