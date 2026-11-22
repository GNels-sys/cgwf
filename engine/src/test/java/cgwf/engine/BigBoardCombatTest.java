package cgwf.engine;

import cgwf.engine.bridge.BigBoardCombat;
import cgwf.engine.bridge.BigBoardCombat.Target;
import cgwf.engine.bridge.BridgeAiLobbyPlayer;
import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import cgwf.engine.bridge.StartingPlayer;
import com.google.gson.JsonArray;
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
import java.util.Collections;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-22: with about 500 Scute Swarm tokens a bot spent 27 minutes in its declare-attackers step
 * and then attacked with nothing. On a very large board the bots now decide combat by a quick rule
 * ({@link BigBoardCombat}); ordinary boards keep Forge's AI. The plan is checked as plain arithmetic, and real
 * games check that a bot with a huge board attacks at once and for the kill, blocks by the rule, and that a small
 * board never takes the quick path. The real games need -Dforge.assets.
 */
class BigBoardCombatTest {
    private static List<DeckLoader.Loaded> spikeDecks;
    private static boolean assets;

    @BeforeAll
    static void boot() throws Exception {
        String dir = System.getProperty("forge.assets");
        if (dir == null || dir.isBlank() || dir.startsWith("${")) dir = System.getenv("FORGE_ASSETS");
        assets = dir != null && !dir.isBlank() && Files.isDirectory(Path.of(dir));
        if (!assets) return;
        ForgeBoot.init(Path.of(dir), true);
        spikeDecks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 2);
    }

    private static List<Integer> powers(int count, int power) {
        return new ArrayList<>(Collections.nCopies(count, power));
    }

    // ------------------------------------------------------------------ the plan

    @Test
    void anOpponentGetsJustEnoughAttackersToDieThroughTheirBlockers() {
        // ten 2/2s; A: 6 life, one blocker (stops one attacker, then three get through); B: 40 life
        int[] sent = BigBoardCombat.planAttack(powers(10, 2), List.of(new Target(6, 1, 1, false), new Target(40, 0, 0, false)));
        assertArrayEquals(new int[] {4, 0}, sent, "four at A; the six left cannot kill B, so they stay home");
    }

    @Test
    void theLowestLifeTotalIsServedFirstAndEveryoneWhoCanDieDoes() {
        // five hundred 1/1s against three opponents
        int[] sent = BigBoardCombat.planAttack(powers(500, 1), List.of(new Target(40, 10, 12, false), new Target(22, 3, 5, false), new Target(31, 0, 2, false)));
        assertArrayEquals(new int[] {50, 25, 31}, sent);
    }

    @Test
    void aPlayerWhoTaxesAttacksIsLeftAlone() {
        int[] sent = BigBoardCombat.planAttack(powers(100, 2), List.of(new Target(5, 0, 0, true), new Target(20, 0, 0, false)));
        assertArrayEquals(new int[] {0, 10}, sent);
    }

    @Test
    void whenNobodyCanBeKilledTheBotKeepsBlockersHomeAndRacesWithTheRest() {
        // a hundred 1/1s; the opponents have 50 creatures between them and too much life
        int[] sent = BigBoardCombat.planAttack(powers(100, 1), List.of(new Target(500, 30, 30, false), new Target(400, 20, 20, false)));
        assertArrayEquals(new int[] {0, 50}, sent, "fifty stay home, fifty go at the lower life total");
        // fewer attackers than creatures facing them: nobody attacks
        assertArrayEquals(new int[] {0, 0}, BigBoardCombat.planAttack(powers(40, 1), List.of(new Target(500, 30, 30, false), new Target(400, 20, 20, false))));
    }

    // ------------------------------------------------------------------ real games

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
    private record Result(int attackersAtMe, double botTurnSeconds, boolean iLost, int botLifeAfterMyAttack, int quickDecisions, List<String> trace) { }

    /**
     * The human (40 life) has `mine` copies of `myCreature`; the bot has `theirs` Grizzly Bears. With `iAttack` the
     * human attacks with everything on turn 1 (the bot blocks); otherwise the human passes and the bot attacks on
     * its turn, the human declaring no blocks.
     */
    private static Result play(int mine, String myCreature, int theirs, boolean iAttack) throws Exception {
        Assumptions.assumeTrue(assets, "set -Dforge.assets to run");
        Deck deck = new Deck("Table");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 300_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        int before = BridgeAiLobbyPlayer.bigBoardDecisions;
        GameFactory.Created created = GameFactory.create(List.of(
                new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)),
                new GameFactory.Seat("Tifa", spikeDecks.get(0).deck(), new BridgeAiLobbyPlayer("Tifa", new StartingPlayer()))), 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        Player opp = null;
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController) me = p;
            else opp = p;
        }
        final Player my = me;
        final Player bot = opp;
        boolean[] setUp = {false};
        int[] attackersAtMe = {-1}, botLife = {-1};
        long[] myTurnEnded = {0}, back = {0};
        List<String> trace = new ArrayList<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread answerer = new Thread(() -> {
            try {
                while (true) {
                    JsonObject p = queue.poll(300, TimeUnit.SECONDS);
                    if (p == null) return;
                    String kind = p.get("prompt").getAsString();
                    JsonObject a = new JsonObject();
                    boolean concede = false;
                    switch (kind) {
                        case "mulligan" -> {
                            if (!setUp[0]) {
                                setUp[0] = true;
                                for (int i = 0; i < mine; i++) put(game, my, myCreature);
                                for (int i = 0; i < theirs; i++) put(game, bot, "Grizzly Bears");
                            }
                            a.addProperty("keep", true);
                        }
                        case "attackers" -> {
                            if (iAttack) a = ScriptedSeat.answer(p, my.getId()); // everything, at the bot
                            else a.add("attacks", new JsonArray());
                            trace.add("my attack: " + a);
                        }
                        case "blockers" -> {
                            attackersAtMe[0] = game.getCombat().getAttackersOf(my).size();
                            back[0] = System.nanoTime();
                            trace.add("the bot attacks me with " + attackersAtMe[0]);
                            a.add("blocks", new JsonArray());
                        }
                        case "priority" -> {
                            String phase = p.has("phase") && !p.get("phase").isJsonNull() ? p.get("phase").getAsString() : "";
                            boolean myTurn = p.get("myTurn").getAsBoolean();
                            int turn = game.getPhaseHandler().getTurn();
                            if (myTurn && turn == 1) {
                                myTurnEnded[0] = System.nanoTime();
                                if (iAttack && ("MAIN2".equals(phase) || "END_OF_TURN".equals(phase))) {
                                    botLife[0] = bot.getLife();
                                    concede = true;
                                }
                            } else if (myTurn && turn > 1) {
                                if (back[0] == 0) back[0] = System.nanoTime();
                                concede = true; // the bot's turn is over and I am still alive
                            }
                            if (concede) a.addProperty("concede", true);
                            else a.add("option", null);
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
        }, "bigboard-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        double secs = back[0] == 0 || myTurnEnded[0] == 0 ? -1 : (back[0] - myTurnEnded[0]) / 1e9;
        return new Result(attackersAtMe[0], secs, my.hasLost() && !my.getOutcome().lossState.name().contains("Conceded"), botLife[0], BridgeAiLobbyPlayer.bigBoardDecisions - before, trace);
    }

    @Test
    void aBotWithAHugeBoardAttacksAtOnceAndWithJustEnoughToKill() throws Exception {
        // 80 bears against 40 life and five untapped blockers: five are stopped, twenty get through = 25 attackers
        Result r = play(5, "Grizzly Bears", 80, false);
        String why = "\n" + String.join("\n", r.trace());
        assertTrue(r.quickDecisions() >= 1, "the quick rule decided" + why);
        assertEquals(25, r.attackersAtMe(), "just enough to kill through five blockers" + why);
        assertTrue(r.botTurnSeconds() >= 0 && r.botTurnSeconds() < 30, "the bot's turn up to its attack took " + r.botTurnSeconds() + " s" + why);
        assertTrue(r.iLost(), "and with no blocks declared it is lethal" + why);
    }

    /** The size of the board in the owner's game: about 500 creatures on the bot's side. */
    @Test
    void aBotWithFiveHundredCreaturesDecidesItsAttackInSecondsNotMinutes() throws Exception {
        Result r = play(20, "Grizzly Bears", 500, false);
        String why = "\n" + String.join("\n", r.trace());
        assertEquals(40, r.attackersAtMe(), "twenty are stopped, twenty get through" + why);
        assertTrue(r.botTurnSeconds() >= 0 && r.botTurnSeconds() < 90, "the bot's turn up to its attack took " + r.botTurnSeconds() + " s" + why);
        System.out.println("BIGBOARD 500 creatures: the bot's turn up to its attack took " + String.format("%.1f", r.botTurnSeconds()) + " s");
    }

    @Test
    void aSmallBoardIsStillPlayedByForgesOwnCombatAi() throws Exception {
        Result r = play(2, "Grizzly Bears", 6, false);
        assertEquals(0, r.quickDecisions(), "eight creatures in play: Forge's AI decides\n" + String.join("\n", r.trace()));
    }

    @Test
    void aBotWithAHugeBoardBlocksByTheRule() throws Exception {
        // ten 6/4s attack a bot at 40 life with 70 bears: 60 would kill, so it chumps the biggest until it lives.
        // Four chump blocks leave 36 damage; a 2/2 cannot kill a 6/4, so nothing else is blocked.
        Result r = play(10, "Craw Wurm", 70, true);
        String why = "\n" + String.join("\n", r.trace());
        assertTrue(r.quickDecisions() >= 1, "the quick rule decided" + why);
        assertEquals(4, r.botLifeAfterMyAttack(), "36 of 60 damage got through" + why);
    }
}
