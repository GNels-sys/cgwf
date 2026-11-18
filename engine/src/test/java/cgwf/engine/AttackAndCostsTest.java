package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.StaticData;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CounterEnumType;
import forge.game.combat.Combat;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Owner report 2026-11-18 (room Q9HPXF, turn 34). Three things went wrong for the human seat in one turn:
 *
 *  1. Phyrexian Triniform's encore made three token copies, each of which "attacks that opponent this turn if
 *     able". The attack screen did not say which copy had to attack whom, the first declaration sent all
 *     three at one player, Forge refused it ("Attack declaration invalid"), and the bridge kept the refused
 *     attackers in the combat, so no later answer could re-aim or remove them: sixteen refusals, then the
 *     prompt timed out and Forge's AI attacked with the three copies alone.
 *  2. Darksteel Monolith ("Once each turn, you may pay {0} rather than pay the mana cost for a colorless spell
 *     that you cast from your hand") was never offered: the bridge's list of legal plays dropped every
 *     alternative cost of a card that can also be cast the ordinary way.
 *  3. The Eternity Elevator at 20+ charge counters ("{T}: Add X mana of any one color") was counted and tapped
 *     for its first ability only ({C}{C}{C}), so spells it could pay for were not offered.
 *
 * Each test plays a real game through Forge with a scripted human. Needs -Dforge.assets.
 */
class AttackAndCostsTest {
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

    private static Card toHand(Player p, String name) {
        Card c = Card.fromPaperCard(card(name), p);
        p.getZone(ZoneType.Hand).add(c);
        return c;
    }

    private static List<JsonObject> options(JsonObject priority, String name) {
        List<JsonObject> out = new ArrayList<>();
        for (JsonElement e : priority.getAsJsonArray("options")) {
            JsonObject o = e.getAsJsonObject();
            if (name.equals(o.get("cardName").getAsString())) out.add(o);
        }
        return out;
    }

    private static boolean onBattlefield(Player p, String name) {
        for (Card c : p.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals(name)) return true;
        return false;
    }

    /** What a test does with the prompts of its human seat. */
    private interface Script {
        /** Board set-up, once, while the first mulligan question is open (nothing has happened yet). */
        void setUp(Game game, Player me);

        /** Fill `a` for a priority prompt in my first main phase with an empty stack; anything else passes. */
        void main(Game game, Player me, JsonObject prompt, JsonObject a);

        /** Fill `a` for an attackers prompt. */
        default void attackers(Game game, Player me, JsonObject prompt, JsonObject a) { a.add("attacks", new JsonArray()); }

        /** A priority prompt in my first main phase with something on the stack; the default lets it resolve. */
        default void stacked(Game game, Player me, JsonObject prompt, JsonObject a) { a.add("option", null); }

        /** A priority prompt in my declare-attackers step (the attack has been accepted). */
        default void attacked(Game game, Player me, JsonObject prompt) { }
    }

    /** One game: the human against `opponents` AI seats, driven by `script` until it concedes. */
    private static List<String> play(int opponents, Script script) throws Exception {
        Deck deck = new Deck("Owner report");
        deck.getOrCreate(DeckSection.Commander).add(card("Krenko, Mob Boss"), 1);
        deck.getMain().add(card("Mountain"), 99);
        LinkedBlockingQueue<JsonObject> queue = new LinkedBlockingQueue<>();
        BridgeSession human = new BridgeSession(0, 60_000);
        human.attach(frame -> {
            if (frame.has("type") && "prompt".equals(frame.get("type").getAsString())) queue.add(frame);
        });
        // Ask at every priority, so the tests see the board right after each step instead of an automatic pass.
        human.setStops(JsonParser.parseString("{\"myTurn\":[\"MAIN1\",\"COMBAT_DECLARE_ATTACKERS\"],\"theirTurn\":[],\"autoPassEmpty\":false}").getAsJsonObject());
        List<GameFactory.Seat> seats = new ArrayList<>();
        seats.add(new GameFactory.Seat("Georgie", deck, new BridgeLobbyPlayer("Georgie", human)));
        for (int i = 0; i < opponents; i++) seats.add(new GameFactory.Seat("Bot" + (i + 1), spikeDecks.get(i % spikeDecks.size()).deck(), GameFactory.ai("Bot" + (i + 1))));
        GameFactory.Created created = GameFactory.create(seats, 4242L);
        Game game = created.game();
        human.setViewBuilder(p -> SeatView.build(game, p));
        Player me = null;
        for (Player p : game.getRegisteredPlayers()) if (p.getController() instanceof BridgeController) me = p;
        final Player my = me;
        boolean[] setUp = {false};
        int[] attackerPrompts = {0};
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
                                script.setUp(game, my);
                            }
                            a.addProperty("keep", true);
                        }
                        case "priority" -> {
                            String phase = p.has("phase") && !p.get("phase").isJsonNull() ? p.get("phase").getAsString() : "";
                            boolean mine = p.get("myTurn").getAsBoolean() && p.get("stackEmpty").getAsBoolean();
                            if (mine && "COMBAT_DECLARE_ATTACKERS".equals(phase)) {
                                script.attacked(game, my, p);
                                a.addProperty("concede", true);
                            } else if (mine && "MAIN1".equals(phase)) {
                                script.main(game, my, p, a);
                            } else if (p.get("myTurn").getAsBoolean() && "MAIN1".equals(phase)) {
                                script.stacked(game, my, p, a);
                            } else {
                                a.add("option", null);
                            }
                        }
                        case "attackers" -> {
                            // A seat that is refused over and over would loop for ever: after five tries the seat leaves.
                            if (++attackerPrompts[0] > 5) {
                                trace.add("gave up after five attack prompts");
                                human.setAbsent(true);
                                a.add("attacks", new JsonArray());
                            } else {
                                script.attackers(game, my, p, a);
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
                human.requestConcede();
                human.setAbsent(true);
            }
        }, "owner-report-human");
        answerer.setDaemon(true);
        answerer.start();
        created.match().startGame(game);
        answerer.interrupt();
        answerer.join(10_000);
        if (failure.get() != null) throw new AssertionError(String.join("\n", trace), failure.get());
        return trace;
    }

    private static JsonObject attack(int cardId, JsonObject defender) {
        JsonObject j = new JsonObject();
        j.addProperty("cardId", cardId);
        j.add("defender", defender);
        return j;
    }

    private static String notes(JsonObject prompt) {
        return prompt.has("notes") ? prompt.getAsJsonArray("notes").toString() : "";
    }

    // ------------------------------------------------------------------ 1. the refused attack

    /**
     * The owner's turn: encore Phyrexian Triniform against three opponents. The prompt must say which copy
     * attacks whom; a wrong first declaration is refused with the reason, and the next answer REPLACES it.
     */
    @Test
    void encoreCopiesSayWhomTheyMustAttackAndARefusedAttackCanBeCorrected() throws Exception {
        List<JsonObject> prompts = new ArrayList<>();
        Map<String, String> declared = new LinkedHashMap<>();
        boolean[] encored = {false};
        List<String> trace = play(3, new Script() {
            @Override public void setUp(Game game, Player me) {
                for (int i = 0; i < 12; i++) put(game, me, "Mountain");
                me.getZone(ZoneType.Graveyard).add(Card.fromPaperCard(card("Phyrexian Triniform"), me));
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                List<JsonObject> encore = options(p, "Phyrexian Triniform");
                if (!encored[0] && !encore.isEmpty()) {
                    encored[0] = true;
                    a.addProperty("option", encore.get(0).get("index").getAsInt());
                } else {
                    a.add("option", null);
                }
            }

            @Override public void attackers(Game game, Player me, JsonObject p, JsonObject a) {
                prompts.add(p);
                JsonArray attacks = new JsonArray();
                JsonObject first = p.getAsJsonArray("defenders").get(0).getAsJsonObject();
                for (JsonElement e : p.getAsJsonArray("candidates")) {
                    JsonObject c = e.getAsJsonObject();
                    if (prompts.size() == 1) {
                        attacks.add(attack(c.get("id").getAsInt(), first)); // the owner's mistake: all three at one player
                    } else if (c.has("mustAttack") && c.getAsJsonArray("mustAttack").size() > 0) {
                        attacks.add(attack(c.get("id").getAsInt(), c.getAsJsonArray("mustAttack").get(0).getAsJsonObject()));
                    }
                }
                a.add("attacks", attacks);
            }

            @Override public void attacked(Game game, Player me, JsonObject p) {
                Combat combat = game.getCombat();
                if (combat == null) return;
                for (Card c : combat.getAttackers()) {
                    GameEntity d = combat.getDefenderByAttacker(c);
                    declared.put(c.getName() + "#" + c.getId(), d == null ? "nobody" : d.getName());
                }
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertTrue(encored[0], "encore was offered from the graveyard" + why);
        assertEquals(2, prompts.size(), "one refusal, then the corrected attack is accepted" + why);

        // the first prompt already says which copy must attack whom
        JsonObject first = prompts.get(0);
        Set<Integer> forced = new HashSet<>();
        int copies = 0;
        for (JsonElement e : first.getAsJsonArray("candidates")) {
            JsonObject c = e.getAsJsonObject();
            if (!"Phyrexian Triniform".equals(c.get("name").getAsString())) continue;
            copies++;
            assertTrue(c.has("mustAttack"), "a copy names the player it must attack: " + c);
            JsonArray must = c.getAsJsonArray("mustAttack");
            assertEquals(1, must.size(), "exactly one player: " + c);
            forced.add(must.get(0).getAsJsonObject().get("id").getAsInt());
        }
        assertEquals(3, copies, "three copies can attack" + why);
        assertEquals(3, forced.size(), "each copy must attack a different opponent");
        assertTrue(notes(first).contains("must attack"), "the prompt says so in words: " + notes(first));
        assertFalse(first.has("refused"), "nothing was refused yet");

        // the second prompt says why the first answer was refused
        JsonObject second = prompts.get(1);
        assertTrue(second.has("refused"), "the refusal is explained: " + second.keySet());
        assertTrue(second.get("refused").getAsString().contains("must attack"), second.get("refused").getAsString());

        // and the corrected attack went through as declared
        assertEquals(3, declared.size(), "three attackers: " + declared + why);
        assertEquals(3, new HashSet<>(declared.values()).size(), "one at each opponent: " + declared);
    }

    /** A limit on attackers (Silent Arbiter): told up front, refused with the reason, and the retry replaces the attack. */
    @Test
    void anAttackOverTheLimitIsRefusedWithTheReasonAndTheRetryReplacesIt() throws Exception {
        List<JsonObject> prompts = new ArrayList<>();
        List<String> declared = new ArrayList<>();
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                put(game, me, "Silent Arbiter");
                put(game, me, "Grizzly Bears");
                put(game, me, "Hill Giant");
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) { a.add("option", null); }

            @Override public void attackers(Game game, Player me, JsonObject p, JsonObject a) {
                prompts.add(p);
                JsonArray attacks = new JsonArray();
                JsonObject defender = p.getAsJsonArray("defenders").get(0).getAsJsonObject();
                for (JsonElement e : p.getAsJsonArray("candidates")) {
                    JsonObject c = e.getAsJsonObject();
                    String name = c.get("name").getAsString();
                    boolean send = prompts.size() == 1 ? !name.equals("Silent Arbiter") : name.equals("Hill Giant");
                    if (send) attacks.add(attack(c.get("id").getAsInt(), defender));
                }
                a.add("attacks", attacks);
            }

            @Override public void attacked(Game game, Player me, JsonObject p) {
                Combat combat = game.getCombat();
                if (combat != null) for (Card c : combat.getAttackers()) declared.add(c.getName());
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertEquals(2, prompts.size(), "one refusal, then the single attacker is accepted" + why);
        assertTrue(notes(prompts.get(0)).contains("No more than one creature can attack"), "the limit is on the prompt: " + notes(prompts.get(0)));
        assertTrue(prompts.get(1).has("refused"), "the refusal is explained" + why);
        assertTrue(prompts.get(1).get("refused").getAsString().contains("No more than one creature can attack"), prompts.get(1).get("refused").getAsString());
        assertEquals(List.of("Hill Giant"), declared, "the second answer replaced the first" + why);
    }

    // ------------------------------------------------------------------ a long stack

    /**
     * The same game later: a stack of triggers took the better part of an hour, one "Let it resolve" at a time.
     * "Resolve all" passes until the stack is empty: three spells on the stack, one answer, no more questions.
     */
    @Test
    void resolveAllPassesUntilTheStackIsEmpty() throws Exception {
        int[] cast = {0};
        int[] askedAfter = {0};
        boolean[] asked = {false};
        int[] shocksInGraveyard = {-1};
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                for (int i = 0; i < 3; i++) put(game, me, "Mountain");
                for (int i = 0; i < 3; i++) toHand(me, "Shock");
            }

            private boolean castOne(JsonObject p, JsonObject a) {
                List<JsonObject> shock = options(p, "Shock");
                if (cast[0] >= 3 || shock.isEmpty()) return false;
                cast[0]++;
                a.addProperty("option", shock.get(0).get("index").getAsInt());
                return true;
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                if (!asked[0] && castOne(p, a)) return;
                shocksInGraveyard[0] = 0;
                for (Card c : me.getCardsIn(ZoneType.Graveyard)) if (c.getName().equals("Shock")) shocksInGraveyard[0]++;
                a.addProperty("concede", true);
            }

            @Override public void stacked(Game game, Player me, JsonObject p, JsonObject a) {
                if (asked[0]) {
                    askedAfter[0]++;
                    a.add("option", null);
                } else if (!castOne(p, a)) {
                    asked[0] = true;
                    a.add("option", null);
                    a.addProperty("passStack", true);
                }
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertEquals(3, cast[0], "three spells were put on the stack" + why);
        assertTrue(asked[0], "Resolve all was sent with the three on the stack" + why);
        assertEquals(0, askedAfter[0], "no priority question while the stack emptied" + why);
        assertEquals(3, shocksInGraveyard[0], "all three resolved before the next question" + why);
    }

    /** Platinum Angel's line (and any other replaced effect) goes out once a turn, not at every state check. */
    @Test
    void aReplacedEffectIsLoggedOnceATurn() {
        cgwf.engine.bridge.RepeatedLogLines lines = new cgwf.engine.bridge.RepeatedLogLines();
        String angel = "You can't lose the game and your opponents can't win the game.";
        assertTrue(lines.keep("EFFECT_REPLACED", angel, 30));
        assertFalse(lines.keep("EFFECT_REPLACED", angel, 30));
        assertFalse(lines.keep("EFFECT_REPLACED", angel, 30));
        assertTrue(lines.keep("EFFECT_REPLACED", "Prevent all combat damage.", 30), "a different effect in the same turn");
        assertTrue(lines.keep("EFFECT_REPLACED", angel, 31), "again on the next turn");
        assertTrue(lines.keep("STACK_RESOLVE", "Shock", 31));
        assertTrue(lines.keep("STACK_RESOLVE", "Shock", 31), "other log lines are never dropped");
    }

    // ------------------------------------------------------------------ 2. Darksteel Monolith

    /** With no mana at all, a colourless spell in hand is offered for {0}, once a turn. */
    @Test
    void darksteelMonolithOffersAColourlessSpellForZeroOnceATurn() throws Exception {
        int[] step = {0};
        List<String> offered = new ArrayList<>();
        boolean[] angelLanded = {false};
        boolean[] secondOffered = {true};
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                put(game, me, "Darksteel Monolith");
                toHand(me, "Platinum Angel");
                toHand(me, "Steel Hellkite");
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                if (step[0] == 0) {
                    step[0] = 1;
                    List<JsonObject> angel = options(p, "Platinum Angel");
                    for (JsonObject o : angel) offered.add(o.get("description").getAsString());
                    if (!angel.isEmpty()) {
                        a.addProperty("option", angel.get(0).get("index").getAsInt());
                        return;
                    }
                } else if (step[0] == 1) {
                    step[0] = 2;
                    angelLanded[0] = onBattlefield(me, "Platinum Angel");
                    secondOffered[0] = !options(p, "Steel Hellkite").isEmpty();
                }
                a.addProperty("concede", true);
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertEquals(1, offered.size(), "the Angel is offered once, through the Monolith: " + offered + why);
        assertTrue(offered.get(0).contains("Darksteel Monolith"), "the option names the Monolith: " + offered);
        assertTrue(angelLanded[0], "the Angel was cast for {0}" + why);
        assertFalse(secondOffered[0], "only once each turn: the second colourless spell is not offered" + why);
    }

    /** With the mana for it too, both ways to cast are offered, and they read differently. */
    @Test
    void darksteelMonolithIsOfferedBesideTheOrdinaryCast() throws Exception {
        List<String> offered = new ArrayList<>();
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                put(game, me, "Darksteel Monolith");
                for (int i = 0; i < 7; i++) put(game, me, "Mountain");
                toHand(me, "Platinum Angel");
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                for (JsonObject o : options(p, "Platinum Angel")) offered.add(o.get("description").getAsString());
                a.addProperty("concede", true);
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertEquals(2, offered.size(), "the ordinary cast and the Monolith's: " + offered + why);
        assertEquals(1, offered.stream().filter(d -> d.contains("Darksteel Monolith")).count(), "one of them names the Monolith: " + offered);
    }

    // ------------------------------------------------------------------ 3. The Eternity Elevator

    private static Card elevator(Game game, Player me, int counters) {
        Card c = put(game, me, "The Eternity Elevator");
        c.addCounterInternal(CounterEnumType.CHARGE, counters, me, false, null, null);
        return c;
    }

    /** 23 charge counters and nothing else: a seven-mana spell is offered and paid for by the Elevator. */
    @Test
    void theEternityElevatorPaysWithItsStationAbility() throws Exception {
        int[] step = {0};
        boolean[] offered = {false};
        boolean[] landed = {false};
        boolean[] tapped = {false};
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                elevator(game, me, 23);
                toHand(me, "Platinum Angel");
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                if (step[0] == 0) {
                    step[0] = 1;
                    List<JsonObject> angel = options(p, "Platinum Angel");
                    offered[0] = !angel.isEmpty();
                    if (offered[0]) {
                        a.addProperty("option", angel.get(0).get("index").getAsInt());
                        return;
                    }
                } else if (step[0] == 1) {
                    step[0] = 2;
                    landed[0] = onBattlefield(me, "Platinum Angel");
                    for (Card c : me.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals("The Eternity Elevator")) tapped[0] = c.isTapped();
                }
                a.addProperty("concede", true);
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertTrue(offered[0], "the spell is offered: the Elevator makes 23 mana" + why);
        assertTrue(landed[0], "and it was cast" + why);
        assertTrue(tapped[0], "by tapping the Elevator" + why);
    }

    /** "Pay with" the Elevator: the chosen source is tapped for its best ability, not for {C}{C}{C}. */
    @Test
    void payWithTapsTheElevatorForAllItsMana() throws Exception {
        int[] step = {0};
        boolean[] landed = {false};
        int[] floating = {-1};
        List<String> trace = play(1, new Script() {
            @Override public void setUp(Game game, Player me) {
                elevator(game, me, 23);
                for (int i = 0; i < 7; i++) put(game, me, "Mountain");
                toHand(me, "Platinum Angel");
            }

            @Override public void main(Game game, Player me, JsonObject p, JsonObject a) {
                if (step[0] == 0) {
                    step[0] = 1;
                    List<JsonObject> angel = options(p, "Platinum Angel");
                    if (!angel.isEmpty()) {
                        a.addProperty("option", angel.get(0).get("index").getAsInt());
                        JsonArray pay = new JsonArray();
                        for (Card c : me.getCardsIn(ZoneType.Battlefield)) if (c.getName().equals("The Eternity Elevator")) pay.add(c.getId());
                        a.add("paySources", pay);
                        return;
                    }
                } else if (step[0] == 1) {
                    step[0] = 2;
                    landed[0] = onBattlefield(me, "Platinum Angel");
                    floating[0] = me.getManaPool().totalMana();
                }
                a.addProperty("concede", true);
            }
        });
        String why = "\n" + String.join("\n", trace);
        assertTrue(landed[0], "the spell was cast" + why);
        assertEquals(16, floating[0], "23 mana from the Elevator, 7 spent, 16 floating" + why);
    }
}
