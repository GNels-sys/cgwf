package cgwf.engine;

import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.StaticData;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.GameLogEntry;
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
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BiFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Opening-hand and pregame actions through the real BridgeController in a real game start (Forge's
 * Match.startGame): Leyline of the Void, Gemstone Caverns (not for the starting player; luck counter;
 * exiles a card from hand), Chancellor of the Forge's reveal, Serum Powder during mulligans, and a
 * companion. Each must reach the human seat as a prompt and show in the game log; nothing here may be
 * answered by the AI fallback (the human answers every prompt). Needs -Dforge.assets.
 */
class PregameTest {
    private static List<DeckLoader.Loaded> spikeDecks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)),
                "set -Dforge.assets=/path/to/forge-gui (or FORGE_ASSETS) to run the pregame test");
        ForgeBoot.init(Path.of(assets), true);
        spikeDecks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 2);
    }

    private static PaperCard card(String name) {
        PaperCard pc = StaticData.instance().getCommonCards().getCard(name);
        assertNotNull(pc, "Forge knows " + name);
        return pc;
    }

    /** What the human saw and what the game looked like at the human's first priority (game thread parked). */
    static final class Run {
        final List<JsonObject> prompts = new ArrayList<>();
        final List<String> errors = new ArrayList<>();
        Game game;
        Player me;
        volatile boolean snapshotTaken;
        final List<String> log = new ArrayList<>();
        final List<String> battlefield = new ArrayList<>();
        final List<String> command = new ArrayList<>();
        int exiled;
        int gemstoneLuck = -1;
        int goblinTokens;
        boolean iWentFirst;
        final List<String> commandAtTurn1 = new ArrayList<>();
        final List<String> zoneMoves = new ArrayList<>();
    }

    /**
     * Plays one game: seat 0 is a human answered by {@code policy} on another thread, seat 1 is Forge's AI.
     * At the human's first priority the test snapshots the game and concedes.
     */
    private static Run play(Deck humanDeck, long seed, BiFunction<JsonObject, Run, JsonObject> policy) throws Exception {
        Run run = new Run();
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if (type.equals("prompt")) queue.add(frame);
            else if (type.equals("error")) run.errors.add(frame.toString());
        });
        List<GameFactory.Seat> seats = List.of(
                new GameFactory.Seat("Georgie", humanDeck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Blair", spikeDecks.get(0).deck(), GameFactory.ai("Blair")));
        GameFactory.Created created = GameFactory.create(seats, seed);
        run.game = created.game();
        human.setViewBuilder(p -> SeatView.build(run.game, p));
        for (Player p : run.game.getRegisteredPlayers()) if (p.getController() instanceof cgwf.engine.bridge.BridgeController) run.me = p;
        run.game.subscribeToEvents(new Object() {
            @com.google.common.eventbus.Subscribe public void onTurn(forge.game.event.GameEventTurnBegan e) {
                if (e.turnNumber() == 1) for (Card c : run.me.getCardsIn(ZoneType.Command)) run.commandAtTurn1.add(c.getName());
            }
            @com.google.common.eventbus.Subscribe public void onZone(forge.game.event.GameEventCardChangeZone e) {
                if (run.game.getPhaseHandler().getTurn() <= 1) run.zoneMoves.add(String.valueOf(e));
            }
        });
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(90, TimeUnit.SECONDS);
                    if (p == null) return;
                    run.prompts.add(p);
                    JsonObject a;
                    if ("priority".equals(p.get("prompt").getAsString())) {
                        snapshot(run);
                        a = new JsonObject();
                        a.addProperty("concede", true);
                    } else {
                        a = policy.apply(p, run);
                    }
                    a.add("promptId", p.get("promptId"));
                    human.answer(a);
                }
            } catch (Throwable t) {
                failure.set(t);
            }
        }, "pregame-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(run.game);
        answerer.interrupt();
        if (failure.get() != null) throw new AssertionError(failure.get());
        if (!run.snapshotTaken) snapshot(run);
        return run;
    }

    private static void snapshot(Run run) {
        if (run.snapshotTaken) return;
        run.snapshotTaken = true;
        Game g = run.game;
        for (GameLogEntry e : g.getGameLog().getAllEntries()) run.log.add(e.message());
        for (Card c : run.me.getCardsIn(ZoneType.Battlefield)) {
            run.battlefield.add(c.getName());
            if (c.getName().equals("Gemstone Caverns")) run.gemstoneLuck = c.getCounters(CounterEnumType.LUCK);
            if (c.isToken() && c.getName().contains("Goblin")) run.goblinTokens++;
        }
        for (Card c : run.me.getCardsIn(ZoneType.Command)) run.command.add(c.getName());
        run.exiled = run.me.getCardsIn(ZoneType.Exile).size();
        run.iWentFirst = run.log.stream().anyMatch(l -> l.equals("Turn 1 (" + run.me.getName() + ")"));
    }

    private static List<String> names(JsonObject prompt, String key) {
        List<String> out = new ArrayList<>();
        if (!prompt.has(key) || !prompt.get(key).isJsonArray()) return out;
        for (JsonElement e : prompt.getAsJsonArray(key)) {
            JsonObject o = e.getAsJsonObject();
            out.add(o.has("name") ? o.get("name").getAsString() : o.has("label") ? o.get("label").getAsString() : "");
        }
        return out;
    }

    private static JsonObject answer(String key, Object value) {
        JsonObject a = new JsonObject();
        if (value instanceof Boolean b) a.addProperty(key, b);
        else if (value instanceof Integer i) a.addProperty(key, i);
        else if (value instanceof JsonArray arr) a.add(key, arr);
        return a;
    }

    private static final Set<String> WANTED = Set.of("Leyline of the Void", "Gemstone Caverns", "Chancellor of the Forge");

    @Test
    void openingHandActionsAndSerumPowderReachTheHuman() throws Exception {
        Deck deck = new Deck("Pregame");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Serum Powder"), 50);
        deck.getMain().add(card("Leyline of the Void"), 17);
        deck.getMain().add(card("Gemstone Caverns"), 16);
        deck.getMain().add(card("Chancellor of the Forge"), 16);
        int[] powderUses = {0};
        Run run = play(deck, 2026L, (p, r) -> {
            String kind = p.get("prompt").getAsString();
            switch (kind) {
                case "choose" -> {
                    // who plays first: the other player (Gemstone Caverns is only for players who do not start)
                    JsonArray opts = p.getAsJsonArray("options");
                    for (int i = 0; i < opts.size(); i++) {
                        JsonObject o = opts.get(i).getAsJsonObject();
                        if ("player".equals(o.has("kind") ? o.get("kind").getAsString() : "") && o.get("id").getAsInt() != r.me.getId()) return answer("option", i);
                    }
                    // Gemstone Caverns' "exile a card from your hand": something we do not need
                    List<String> labels = names(p, "options");
                    for (int i = 0; i < labels.size(); i++) if (!WANTED.contains(labels.get(i))) return answer("option", i);
                    return answer("option", 0);
                }
                case "mulligan" -> {
                    Set<String> hand = new HashSet<>(names(p, "hand"));
                    if (hand.containsAll(WANTED)) return answer("keep", true);
                    if (p.has("serumPowder") && powderUses[0] < 12) {
                        powderUses[0]++;
                        return answer("serumPowder", p.getAsJsonArray("serumPowder").get(0).getAsInt());
                    }
                    return answer("keep", powderUses[0] >= 12);
                }
                case "chooseMany" -> {
                    String reason = p.has("reason") ? p.get("reason").getAsString() : "";
                    JsonArray all = new JsonArray();
                    List<String> labels = names(p, "options");
                    int min = p.get("min").getAsInt();
                    int max = p.get("max").getAsInt();
                    if (reason.equals("openingHand")) {
                        for (int i = 0; i < labels.size(); i++) all.add(i); // use every opening-hand action
                        return answer("options", all);
                    }
                    if (reason.equals("mulligan")) {
                        // bottom what we do not want
                        for (int i = 0; i < labels.size() && all.size() < min; i++) if (!WANTED.contains(labels.get(i))) all.add(i);
                        for (int i = 0; i < labels.size() && all.size() < min; i++) if (!contains(all, i)) all.add(i);
                        return answer("options", all);
                    }
                    // anything else (Gemstone's "exile a card from your hand"): the first legal pick(s)
                    for (int i = 0; i < Math.max(min, Math.min(1, max)); i++) all.add(i);
                    return answer("options", all);
                }
                default -> {
                    return ScriptedSeat.answer(p, r.me.getId());
                }
            }
        });

        List<String> kinds = new ArrayList<>();
        for (JsonObject p : run.prompts) kinds.add(p.get("prompt").getAsString() + (p.has("reason") ? ":" + p.get("reason").getAsString() : ""));
        assertEquals(List.of(), run.errors, "no illegal answers");
        assertTrue(powderUses[0] >= 1, "Serum Powder was offered in the mulligan prompt: " + kinds);
        assertTrue(run.log.stream().anyMatch(l -> l.contains("used Serum Powder")), "Serum Powder shows in the log: " + run.log);
        JsonObject opening = run.prompts.stream().filter(p -> "openingHand".equals(p.has("reason") ? p.get("reason").getAsString() : "")).findFirst().orElse(null);
        assertNotNull(opening, "the opening-hand actions reached the human as a prompt: " + kinds);
        String labels = String.join(" | ", names(opening, "options"));
        assertTrue(labels.contains("Leyline of the Void"), labels);
        assertTrue(labels.contains("Chancellor of the Forge"), labels);
        if (!run.iWentFirst) assertTrue(labels.contains("Gemstone Caverns"), "Gemstone Caverns is offered to a player who does not start: " + labels);
        else assertTrue(!labels.contains("Gemstone Caverns"), "Gemstone Caverns is never offered to the starting player: " + labels);
        assertTrue(run.battlefield.contains("Leyline of the Void"), "Leyline began the game on the battlefield: " + run.battlefield);
        assertTrue(run.log.stream().anyMatch(l -> l.contains("uses Leyline of the Void from their opening hand")), run.log.toString());
        assertTrue(run.log.stream().anyMatch(l -> l.contains("uses Chancellor of the Forge from their opening hand")), run.log.toString());
        if (!run.iWentFirst) {
            assertEquals(1, run.gemstoneLuck, "Gemstone Caverns entered with a luck counter");
            assertTrue(run.log.stream().anyMatch(l -> l.contains("uses Gemstone Caverns from their opening hand")), run.log.toString());
        }
        // the reveal's delayed trigger fires at the first upkeep (Blair's) and makes the Goblin (it may die before our snapshot)
        assertTrue(run.log.stream().anyMatch(l -> l.startsWith(run.me.getName() + " triggered Chancellor of the Forge")), "the first-upkeep trigger went on the stack: " + run.log);
        assertTrue(run.zoneMoves.stream().anyMatch(m -> m.contains("Phyrexian Goblin") && m.contains("-> [Battlefield]")), "a Phyrexian Goblin token entered: " + run.zoneMoves);
        System.out.println("[pregame] prompts=" + kinds + " wentFirst=" + run.iWentFirst + " powderUses=" + powderUses[0] + " exiled=" + run.exiled + "\n[pregame] log=" + run.log);
    }

    private static boolean contains(JsonArray a, int v) {
        for (JsonElement e : a) if (e.getAsInt() == v) return true;
        return false;
    }

    @Test
    void aCompanionIsOfferedAndRevealed() throws Exception {
        Deck deck = new Deck("Companion");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        // Jegantha: no card in the starting deck has more than one of the same mana symbol (Mountains have none)
        deck.getOrCreate(DeckSection.Sideboard).add(card("Jegantha, the Wellspring"), 1);
        Run run = play(deck, 7L, (p, r) -> {
            String kind = p.get("prompt").getAsString();
            if (kind.equals("mulligan")) return answer("keep", true);
            if (kind.equals("choose")) {
                JsonArray opts = p.getAsJsonArray("options");
                for (int i = 0; i < opts.size(); i++) {
                    JsonObject o = opts.get(i).getAsJsonObject();
                    if (o.has("name") && o.get("name").getAsString().equals("Jegantha, the Wellspring")) return answer("option", i);
                }
            }
            return ScriptedSeat.answer(p, r.me.getId());
        });
        JsonObject companion = run.prompts.stream()
                .filter(p -> "choose".equals(p.get("prompt").getAsString()) && names(p, "options").contains("Jegantha, the Wellspring"))
                .findFirst().orElse(null);
        assertNotNull(companion, "the companion reached the human as a choice");
        assertTrue(!companion.get("optional").getAsBoolean(), "never optional: Forge cannot take a declined companion");
        assertTrue(run.command.contains("Jegantha, the Wellspring"), "the companion waits in the command zone: " + run.command);
        assertTrue(run.log.stream().anyMatch(l -> l.contains("reveals Jegantha, the Wellspring as their companion")), run.log.toString());
    }
}
