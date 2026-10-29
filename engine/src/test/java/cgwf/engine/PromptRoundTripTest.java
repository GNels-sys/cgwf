package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
import cgwf.engine.bridge.StackThreats;
import forge.game.spellability.SpellAbilityStackInstance;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.StaticData;
import forge.card.ColorSet;
import forge.card.MagicColor;
import forge.deck.DeckSection;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostParser;
import forge.game.cost.Cost;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.player.PlayerController.BinaryChoiceType;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.OptionalCost;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.item.PaperCard;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Every prompt kind round-trips through the real BridgeController: Forge asks, the JSON prompt
 * carries what the client needs, a scripted answer comes back, and the Java return value is what
 * the answer meant. Runs against a real (unstarted) Commander game with zones filled by hand, so
 * it needs Forge's resources like the audit (-Dforge.assets); skipped without them.
 */
@TestMethodOrder(MethodOrderer.MethodName.class)
class PromptRoundTripTest {
    private static Game game;
    private static Player me;
    private static Player opp;
    private static BridgeController ctl;
    private static final Deque<Function<JsonObject, JsonObject>> script = new ArrayDeque<>();
    private static final List<JsonObject> prompts = new ArrayList<>();
    private static final List<JsonObject> errors = new ArrayList<>();
    private static final List<JsonObject> notices = new ArrayList<>();
    /** Hidden-information problems found in each prompt's view, checked against the live game when the prompt went out. */
    private static final List<String> viewLeaks = new ArrayList<>();

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)),
                "set -Dforge.assets=/path/to/forge-gui (or FORGE_ASSETS) to run the prompt round-trip test");
        Path decksDir = Path.of(System.getProperty("cgwf.decks", "spike/decks"));
        ForgeBoot.init(Path.of(assets), true);
        List<DeckLoader.Loaded> decks = DeckLoader.loadDir(decksDir, 4);

        BridgeSession session = new BridgeSession(0, 5_000);
        session.attach(frame -> {
            String type = frame.has("type") ? frame.get("type").getAsString() : "";
            if (type.equals("prompt")) {
                prompts.add(frame);
                if (game != null && me != null && frame.has("view") && frame.get("view").isJsonObject()) {
                    for (String leak : HiddenInfoAudit.check(game, me, frame.getAsJsonObject("view"))) viewLeaks.add("prompt " + frame.get("promptId") + ": " + leak);
                }
                Function<JsonObject, JsonObject> f = script.pollFirst();
                JsonObject answer = f == null ? new JsonObject() : f.apply(frame);
                answer.add("promptId", frame.get("promptId"));
                session.answer(answer); // the game thread is inside ask(): completing the future there is fine
            } else if (type.equals("error")) {
                errors.add(frame);
            } else if (type.equals("notice")) {
                notices.add(frame);
            }
        });
        List<GameFactory.Seat> seats = new ArrayList<>();
        for (int i = 0; i < decks.size(); i++) {
            String name = "Seat " + (i + 1);
            seats.add(new GameFactory.Seat(name, decks.get(i).deck(), i == 0 ? new BridgeLobbyPlayer(name, session) : GameFactory.ai(name)));
        }
        game = GameFactory.create(seats, 11L).game();
        session.setViewBuilder(p -> SeatView.build(game, p));
        for (Player p : game.getRegisteredPlayers()) {
            if (p.getController() instanceof BridgeController bc) { me = p; ctl = bc; } else if (opp == null) opp = p;
        }
        assertNotNull(ctl);
        // Fill the human's zones by hand (the match is never started): 7 in hand, the rest in the library.
        int n = 0;
        for (Map.Entry<PaperCard, Integer> e : decks.get(0).deck().getMain()) {
            for (int k = 0; k < e.getValue(); k++) {
                Card c = Card.fromPaperCard(e.getKey(), me);
                me.getZone(n < 7 ? ZoneType.Hand : ZoneType.Library).add(c);
                n++;
            }
        }
        for (Map.Entry<PaperCard, Integer> e : decks.get(0).deck().get(DeckSection.Commander)) {
            me.getZone(ZoneType.Command).add(Card.fromPaperCard(e.getKey(), me));
        }
        // and a couple of creatures on each side of the table
        moveCreatures(me, 2);
        for (Map.Entry<PaperCard, Integer> e : decks.get(1).deck().getMain()) {
            Card c = Card.fromPaperCard(e.getKey(), opp);
            if (c.isCreature()) opp.getZone(ZoneType.Battlefield).add(c);
            if (opp.getCardsIn(ZoneType.Battlefield).size() >= 2) break;
        }
        me.setLife(40, null);
        opp.setLife(40, null);
    }

    private static void moveCreatures(Player p, int count) {
        List<Card> lib = new ArrayList<>(p.getCardsIn(ZoneType.Library));
        int moved = 0;
        for (Card c : lib) {
            if (!c.isCreature()) continue;
            p.getZone(ZoneType.Library).remove(c);
            p.getZone(ZoneType.Battlefield).add(c);
            if (++moved >= count) break;
        }
    }

    private static JsonObject lastPrompt() { return prompts.get(prompts.size() - 1); }

    private static JsonObject next(String kind) {
        JsonObject p = lastPrompt();
        assertEquals(kind, p.get("prompt").getAsString(), "prompt kind");
        assertTrue(p.has("view") && p.get("view").isJsonObject(), "every prompt carries the seat's view");
        return p;
    }

    private static JsonArray ints(int... v) { JsonArray a = new JsonArray(); for (int i : v) a.add(i); return a; }

    private static JsonObject answer(String key, Object value) {
        JsonObject a = new JsonObject();
        if (value instanceof Boolean b) a.addProperty(key, b);
        else if (value instanceof Integer i) a.addProperty(key, i);
        else if (value instanceof String s) a.addProperty(key, s);
        else if (value instanceof JsonArray arr) a.add(key, arr);
        else if (value instanceof JsonObject o) a.add(key, o);
        return a;
    }

    private static Card hand(int i) { return me.getCardsIn(ZoneType.Hand).get(i); }

    // ------------------------------------------------------------------ one land per turn (Forge's own land play)

    /** One priority decision through the real controller: the land options offered, and (if asked) the ability chosen. */
    private static List<Integer> landOptionsThenMaybePlay(Integer playCardId) {
        int before = prompts.size();
        List<Integer> lands = new ArrayList<>();
        script.add(p -> {
            JsonObject a = new JsonObject();
            for (var e : p.getAsJsonArray("options")) {
                JsonObject o = e.getAsJsonObject();
                if (!"land".equals(o.get("kind").getAsString())) continue;
                lands.add(o.get("cardId").getAsInt());
                if (playCardId != null && o.get("cardId").getAsInt() == playCardId) a.addProperty("option", o.get("index").getAsInt());
            }
            return a; // no "option" = pass
        });
        List<SpellAbility> chosen = ctl.chooseSpellAbilityToPlay();
        if (prompts.size() == before) script.pollLast(); // nothing to play: the seat auto-passed without a prompt
        if (chosen != null && !chosen.isEmpty()) ctl.playChosenSpellAbility(chosen.get(0)); // what Forge's priority loop does next
        return lands;
    }

    @Test
    void landDropsFollowForgesLimitAndExplorationGrantsOneMore() {
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, me, 5);
        me.setLandsPlayedThisTurn(0);
        // fresh cards straight into hand (libraries stay untouched for the final view audit)
        List<Card> lands = new ArrayList<>();
        PaperCard mountain = StaticData.instance().getCommonCards().getCard("Mountain");
        for (int i = 0; i < 3; i++) {
            Card c = Card.fromPaperCard(mountain, me);
            me.getZone(ZoneType.Hand).add(c);
            lands.add(c);
        }
        Card exploration = null;
        try {
            // the first land of the turn is offered and played through Forge's land ability
            List<Integer> offered = landOptionsThenMaybePlay(lands.get(0).getId());
            assertTrue(offered.contains(lands.get(0).getId()), "a land in hand is offered on my main phase");
            assertTrue(lands.get(0).isInZone(ZoneType.Battlefield), "the chosen land was played");
            assertEquals(1, me.getLandsPlayedThisTurn(), "Forge counted the land drop");
            // a second land is not offered (no prompt at all when nothing else is playable, or a prompt without lands)
            assertEquals(List.of(), landOptionsThenMaybePlay(null), "no second land drop");
            // Exploration: "You may play an additional land on each of your turns."
            PaperCard pc = StaticData.instance().getCommonCards().getCard("Exploration");
            assertNotNull(pc, "Forge knows Exploration");
            exploration = Card.fromPaperCard(pc, me);
            me.getZone(ZoneType.Battlefield).add(exploration);
            game.getAction().checkStaticAbilities();
            assertEquals(2, me.getMaxLandPlays(), "Exploration grants one more land play");
            offered = landOptionsThenMaybePlay(lands.get(1).getId());
            assertTrue(offered.contains(lands.get(1).getId()), "with Exploration the second land is offered");
            assertTrue(lands.get(1).isInZone(ZoneType.Battlefield));
            assertEquals(2, me.getLandsPlayedThisTurn());
            assertEquals(List.of(), landOptionsThenMaybePlay(null), "and a third is not");
            assertTrue(lands.get(2).isInZone(ZoneType.Hand), "the third land stayed in hand");
        } finally {
            // put everything back: later tests audit the views against the live zones
            if (exploration != null) {
                me.getZone(ZoneType.Battlefield).remove(exploration);
                game.getAction().checkStaticAbilities();
            }
            for (Card c : lands) {
                Card live = game.getCardState(c);
                if (live.getZone() != null) live.getZone().remove(live);
            }
            me.setLandsPlayedThisTurn(0);
            me.getManaPool().clearPool(false);
        }
    }

    // ------------------------------------------------------------------ "Pay with" (Stage 2 M5)

    @Test
    void payWithTapsTheChosenSourcesFirstAndSkipsWhatCannotPay() {
        // two basic lands of the human's onto the battlefield
        List<Card> lands = new ArrayList<>();
        for (Card c : new ArrayList<>(me.getCardsIn(ZoneType.Library))) {
            if (!c.isBasicLand()) continue;
            me.getZone(ZoneType.Library).remove(c);
            me.getZone(ZoneType.Battlefield).add(c);
            lands.add(c);
            if (lands.size() == 2) break;
        }
        assertEquals(2, lands.size(), "the test deck has basic lands");
        Card first = lands.get(0);
        Card second = lands.get(1);
        String colour = BridgeController.producedColours(first.getManaAbilities().get(0), first.getManaAbilities().get(0).getManaPart()).get(0);
        me.getManaPool().clearPool(false);
        Card oppCard = opp.getCardsIn(ZoneType.Battlefield).get(0);
        // the opponent's permanent and an unknown id are skipped; the first land is tapped for the colour the cost needs
        ctl.tapChosenSources(List.of(oppCard.getId(), 999_999, first.getId()), new ManaCost(new ManaCostParser("{1}{" + colour + "}")));
        assertTrue(first.isTapped(), "the chosen land is tapped");
        assertFalse(second.isTapped(), "the other land is untouched");
        assertFalse(oppCard.isTapped(), "another player's permanent is never tapped");
        assertEquals(1, me.getManaPool().totalMana(), "its mana waits in the pool for the automatic payer");
        // a tapped source is skipped on a second request
        ctl.tapChosenSources(List.of(first.getId()), new ManaCost(new ManaCostParser("{1}")));
        assertEquals(1, me.getManaPool().totalMana());
        me.getManaPool().clearPool(false);
        first.untap();
        // put the lands back: the final audit compares every recorded prompt view with the live library size
        for (Card c : lands) {
            me.getZone(ZoneType.Battlefield).remove(c);
            me.getZone(ZoneType.Library).add(c);
        }
        assertTrue(prompts.isEmpty() || !lastPrompt().get("prompt").getAsString().equals("text"), "no colour question was asked");
    }

    // ------------------------------------------------------------------ yes / no

    @Test
    void confirmCarriesTheCardAndReturnsTheAnswer() {
        Card shown = hand(0);
        script.add(p -> answer("confirm", false));
        boolean r = ctl.confirmAction(null, PlayerActionConfirmMode.OptionalChoose, "Pay 2 life so it enters untapped?", null, shown, null);
        JsonObject p = next("confirm");
        assertFalse(r);
        assertEquals("Pay 2 life so it enters untapped?", p.get("title").getAsString());
        assertEquals(shown.getId(), p.getAsJsonObject("card").get("id").getAsInt());
        assertEquals(shown.getName(), p.getAsJsonObject("card").get("name").getAsString());
        assertEquals("Yes", p.getAsJsonArray("options").get(0).getAsString());

        script.add(p2 -> answer("confirm", true));
        assertTrue(ctl.confirmAction(null, PlayerActionConfirmMode.OptionalChoose, "Again?", null, null, null));
    }

    @Test
    void binaryChoicesLabelTheTwoButtons() {
        script.add(p -> answer("option", 1));
        boolean r = ctl.chooseBinary(null, "Call it", BinaryChoiceType.HeadsOrTails, (Boolean) null);
        JsonObject p = next("confirm");
        assertFalse(r, "second option = false");
        assertEquals("Heads", p.getAsJsonArray("options").get(0).getAsString());
        assertEquals("Tails", p.getAsJsonArray("options").get(1).getAsString());
        assertEquals("HeadsOrTails", p.get("mode").getAsString());
    }

    @Test
    void unlessCostAsksBeforePayingAndDoesNotPayOnNo() {
        Card c = hand(1);
        SpellAbility sa = c.getSpellAbilities().get(0);
        Cost cost = new Cost("PayLife<2>", false);
        int life = me.getLife();
        script.add(p -> answer("confirm", false));
        boolean paid = ctl.payCostToPreventEffect(cost, sa, false, null);
        JsonObject p = next("confirm");
        assertFalse(paid);
        assertEquals(life, me.getLife(), "declining never pays");
        assertTrue(p.get("title").getAsString().toLowerCase().contains("2 life"), p.get("title").getAsString());
        assertEquals("Pay", p.getAsJsonArray("options").get(0).getAsString());
        assertEquals(c.getId(), p.getAsJsonObject("card").get("id").getAsInt());
    }

    // ------------------------------------------------------------------ numbers

    @Test
    void numbersAreClampedToTheRange() {
        script.add(p -> answer("value", 3));
        assertEquals(3, ctl.chooseNumber(null, "Choose X", 0, 5));
        JsonObject p = next("number");
        assertEquals(0, p.get("min").getAsInt());
        assertEquals(5, p.get("max").getAsInt());
        script.add(p2 -> answer("value", 99));
        assertEquals(5, ctl.chooseNumber(null, "Choose X", 0, 5), "out of range clamps");
        // a fixed list of values
        script.add(p3 -> answer("value", 4));
        assertEquals(4, ctl.chooseNumber(null, "Pick", List.of(2, 4, 6), null));
        assertEquals(3, next("number").getAsJsonArray("values").size());
        // min == max never asks
        int before = prompts.size();
        assertEquals(2, ctl.chooseNumber(null, "Fixed", 2, 2));
        assertEquals(before, prompts.size());
    }

    @Test
    void optionalCostsAreAMultipleChoiceOfTexts() {
        SpellAbility sa = hand(2).getSpellAbilities().get(0);
        List<OptionalCostValue> values = List.of(new OptionalCostValue(OptionalCost.Kicker1, new Cost("1", false)));
        script.add(p -> answer("options", ints(0)));
        List<OptionalCostValue> chosen = ctl.chooseOptionalCosts(sa, values);
        JsonObject p = next("chooseMany");
        assertEquals(1, chosen.size());
        assertEquals(0, p.get("min").getAsInt());
        assertEquals(1, p.get("max").getAsInt());
        assertEquals("text", p.getAsJsonArray("options").get(0).getAsJsonObject().get("kind").getAsString());
        assertTrue(p.getAsJsonArray("options").get(0).getAsJsonObject().get("name").getAsString().contains("Kicker"));
    }

    // ------------------------------------------------------------------ ordering

    @Test
    void scryOrdersTheTopAndSendsTheRestToTheBottom() {
        CardCollection top = new CardCollection(me.getCardsIn(ZoneType.Library).subList(0, 3));
        script.add(p -> {
            JsonObject a = answer("order", ints(2, 0, 1));
            JsonObject buckets = new JsonObject();
            buckets.addProperty("1", "bottom");
            a.add("buckets", buckets);
            return a;
        });
        ImmutablePair<CardCollection, CardCollection> r = ctl.arrangeForScry(top);
        JsonObject p = next("order");
        assertEquals(List.of("top", "bottom"), List.of(p.getAsJsonArray("buckets").get(0).getAsString(), p.getAsJsonArray("buckets").get(1).getAsString()));
        assertEquals(3, p.getAsJsonArray("items").size());
        assertEquals(top.get(0).getName(), p.getAsJsonArray("items").get(0).getAsJsonObject().get("name").getAsString(), "scry shows the card faces to the scrying seat");
        assertEquals(List.of(top.get(2), top.get(0)), new ArrayList<>(r.getLeft()));
        assertEquals(List.of(top.get(1)), new ArrayList<>(r.getRight()));
    }

    @Test
    void surveilUsesTheGraveyardBucket() {
        CardCollection top = new CardCollection(me.getCardsIn(ZoneType.Library).subList(0, 2));
        script.add(p -> {
            JsonObject a = answer("order", ints(0, 1));
            JsonObject buckets = new JsonObject();
            buckets.addProperty("0", "graveyard");
            a.add("buckets", buckets);
            return a;
        });
        ImmutablePair<CardCollection, CardCollection> r = ctl.arrangeForSurveil(top);
        assertEquals("graveyard", next("order").getAsJsonArray("buckets").get(1).getAsString());
        assertEquals(List.of(top.get(1)), new ArrayList<>(r.getLeft()));
        assertEquals(List.of(top.get(0)), new ArrayList<>(r.getRight()));
    }

    @Test
    void zoneOrderingAsksOnlyWhenItMatters() {
        CardCollection cards = new CardCollection(me.getCardsIn(ZoneType.Library).subList(0, 3));
        int before = prompts.size();
        CardCollectionView same = ctl.orderMoveToZoneList(cards, ZoneType.Graveyard, null);
        assertEquals(before, prompts.size(), "nothing in this game cares about graveyard order: no question");
        assertEquals(new ArrayList<>(cards), new ArrayList<>(same));

        script.add(p -> answer("order", ints(1, 0, 2)));
        CardCollectionView bf = ctl.orderMoveToZoneList(cards, ZoneType.Battlefield, null);
        next("order");
        assertEquals(List.of(cards.get(1), cards.get(0), cards.get(2)), new ArrayList<>(bf));

        // library: the client orders top-first, Forge wants the top card last
        script.add(p -> answer("order", ints(1, 0, 2)));
        CardCollectionView lib = ctl.orderMoveToZoneList(cards, ZoneType.Library, null);
        assertTrue(next("order").get("note").getAsString().contains("top"));
        assertEquals(List.of(cards.get(2), cards.get(0), cards.get(1)), new ArrayList<>(lib));
    }

    @Test
    void simultaneousTriggersAreOrderedFirstResolvesFirst() {
        List<SpellAbility> sas = new ArrayList<>();
        for (Card c : me.getCardsIn(ZoneType.Hand)) { if (!c.getSpellAbilities().isEmpty()) sas.add(c.getSpellAbilities().get(0)); if (sas.size() == 2) break; }
        Assumptions.assumeTrue(sas.size() == 2);
        script.add(p -> answer("order", ints(1, 0)));
        List<SpellAbility> ordered = ctl.orderSimultaneousSa(sas);
        JsonObject p = next("order");
        assertEquals(2, p.getAsJsonArray("items").size());
        assertEquals("text", p.getAsJsonArray("items").get(0).getAsJsonObject().get("kind").getAsString());
        // the seat wants sas[1] to resolve first, so Forge must put it on the stack LAST
        assertEquals(List.of(sas.get(0), sas.get(1)), ordered);
    }

    // ------------------------------------------------------------------ damage

    @Test
    void combatDamageIsSplitAsAnswered() {
        List<Card> mine = new ArrayList<>(me.getCardsIn(ZoneType.Battlefield));
        List<Card> theirs = new ArrayList<>(opp.getCardsIn(ZoneType.Battlefield));
        Assumptions.assumeTrue(!mine.isEmpty() && theirs.size() >= 2);
        Card attacker = mine.get(0);
        CardCollection blockers = new CardCollection(theirs.subList(0, 2));
        script.add(p -> answer("amounts", ints(1, 2)));
        Map<Card, Integer> r = ctl.assignCombatDamage(attacker, blockers, null, 3, opp, false);
        JsonObject p = next("assign");
        assertEquals(3, p.get("total").getAsInt());
        assertEquals(2, p.getAsJsonArray("targets").size());
        assertTrue(p.getAsJsonArray("targets").get(0).getAsJsonObject().has("lethal"));
        assertEquals(attacker.getId(), p.getAsJsonObject("card").get("id").getAsInt());
        assertEquals(1, r.get(blockers.get(0)));
        assertEquals(2, r.get(blockers.get(1)));

        // amounts that do not add up are refused with an error and asked again
        int errs = errors.size();
        int asked = prompts.size();
        script.add(p2 -> answer("amounts", ints(5, 5)));
        script.add(p2 -> answer("amounts", ints(3, 0)));
        Map<Card, Integer> again = ctl.assignCombatDamage(attacker, blockers, null, 3, opp, false);
        assertEquals(3, again.get(blockers.get(0)));
        assertEquals(asked + 2, prompts.size(), "asked twice");
        assertTrue(errors.size() > errs);

        // one blocker, no trample: never a question
        int before = prompts.size();
        ctl.assignCombatDamage(attacker, new CardCollection(blockers.get(0)), null, 3, opp, false);
        assertEquals(before, prompts.size());
    }

    // ------------------------------------------------------------------ modes, colours, types, names

    @Test
    void modesComeBackInTheChosenOrder() {
        SpellAbility modal = null;
        List<AbilitySub> subs = null;
        for (Card c : game.getCardsInGame()) {
            for (SpellAbility sa : c.getSpellAbilities()) {
                if (sa.hasParam("Choices")) {
                    List<AbilitySub> l = sa.getAdditionalAbilityList("Choices");
                    if (l != null && l.size() >= 2) { modal = sa; subs = l; break; }
                }
            }
            if (modal != null) break;
        }
        Assumptions.assumeTrue(modal != null, "no modal spell in these decks");
        script.add(p -> answer("modes", ints(1)));
        List<AbilitySub> chosen = ctl.chooseModeForAbility(modal, subs, 1, 1, false);
        JsonObject p = next("mode");
        assertEquals(subs.size(), p.getAsJsonArray("modes").size());
        assertEquals(List.of(subs.get(1)), chosen);
        // all modes required: no question
        int before = prompts.size();
        assertEquals(subs, ctl.chooseModeForAbility(modal, subs, subs.size(), subs.size(), false));
        assertEquals(before, prompts.size());
    }

    @Test
    void coloursTypesAndCounterTypesAreTextChoices() {
        script.add(p -> answer("option", 3));
        byte color = ctl.chooseColor("Choose a color", null, ColorSet.fromMask(MagicColor.ALL_COLORS));
        JsonObject p = next("choose");
        assertEquals(MagicColor.RED, color);
        assertEquals(5, p.getAsJsonArray("options").size());
        assertEquals("red", p.getAsJsonArray("options").get(3).getAsJsonObject().get("name").getAsString());

        script.add(p2 -> answer("options", ints(0, 4)));
        ColorSet set = ctl.chooseColors("Choose two", null, 2, 2, ColorSet.fromMask(MagicColor.ALL_COLORS));
        next("chooseMany");
        assertTrue(set.hasWhite() && set.hasGreen() && set.countColors() == 2);

        script.add(p3 -> answer("option", 1));
        assertEquals("Goblin", ctl.chooseSomeType("Creature", null, List.of("Elf", "Goblin", "Zombie"), false));
        assertEquals(3, next("choose").getAsJsonArray("options").size());
    }

    @Test
    void freeTextCardNamesAreValidatedAgainstTheCardDatabase() {
        int errs = errors.size();
        script.add(p -> answer("text", "Definitely Not A Card"));
        script.add(p -> answer("text", "forest"));
        String name = ctl.chooseCardName(null, f -> true, "Card", "Name a card");
        assertEquals("Forest", name, "case-insensitive match returns the canonical name");
        JsonObject p = next("text");
        assertTrue(p.get("freeText").getAsBoolean());
        assertEquals(errs + 1, errors.size(), "the bad name was refused with an error, then asked again");
    }

    // ------------------------------------------------------------------ card lists

    @Test
    void tutorsShowTheFetchListAndReturnThePick() {
        CardCollection fetch = new CardCollection(me.getCardsIn(ZoneType.Library).subList(0, 4));
        script.add(p -> answer("option", 2));
        Card got = ctl.chooseSingleCardForZoneChange(ZoneType.Hand, List.of(ZoneType.Library), null, fetch, null, "Search your library for a card", true, me);
        JsonObject p = next("choose");
        assertEquals(fetch.get(2), got);
        assertTrue(p.get("optional").getAsBoolean());
        assertEquals(fetch.get(0).getName(), p.getAsJsonArray("options").get(0).getAsJsonObject().get("name").getAsString());
        // "none" when optional
        script.add(p2 -> { JsonObject a = new JsonObject(); a.add("option", null); return a; });
        assertNull(ctl.chooseSingleCardForZoneChange(ZoneType.Hand, List.of(ZoneType.Library), null, fetch, null, "Search", true, me));
    }

    @Test
    void discardToHandSizeAndChooseCardsForEffectAreMultipleChoices() {
        script.add(p -> answer("options", ints(0, 1)));
        CardCollectionView d = ctl.chooseCardsToDiscardToMaximumHandSize(2);
        JsonObject p = next("chooseMany");
        assertEquals(2, p.get("min").getAsInt());
        assertEquals(2, p.get("max").getAsInt());
        assertEquals("discard", p.get("reason").getAsString());
        assertEquals(List.of(hand(0), hand(1)), new ArrayList<>(d));

        CardCollection pool = new CardCollection(me.getCardsIn(ZoneType.Hand).subList(0, 3));
        script.add(p2 -> answer("options", ints(2)));
        CardCollectionView e = ctl.chooseCardsForEffect(pool, null, "Choose up to one", 0, 1, true, null);
        assertEquals(List.of(pool.get(2)), new ArrayList<>(e));

        // too many picks: refused with an error and asked again
        int errs = errors.size();
        int asked = prompts.size();
        script.add(p3 -> answer("options", ints(0, 1, 2)));
        script.add(p3 -> answer("options", ints(1)));
        CardCollectionView f = ctl.chooseCardsForEffect(pool, null, "Choose up to one", 0, 1, true, null);
        assertEquals(List.of(pool.get(1)), new ArrayList<>(f));
        assertEquals(asked + 2, prompts.size(), "asked twice");
        assertTrue(errors.size() > errs);
    }

    @Test
    void targetsIncludeCardsAndPlayers() {
        SpellAbility targeting = null;
        for (Card c : me.getCardsIn(ZoneType.Hand)) for (SpellAbility sa : c.getSpellAbilities()) if (sa.usesTargeting() && sa.getTargetRestrictions().canTgtPlayer()) targeting = sa;
        if (targeting == null) for (Card c : me.getCardsIn(ZoneType.Library)) { for (SpellAbility sa : c.getSpellAbilities()) if (sa.usesTargeting()) targeting = sa; if (targeting != null) break; }
        Assumptions.assumeTrue(targeting != null, "no targeting spell in this deck");
        targeting.setActivatingPlayer(me);
        final SpellAbility sa = targeting;
        List<GameEntity> candidates = new ArrayList<>();
        script.add(p -> answer("options", ints(0)));
        boolean ok;
        try {
            ok = ctl.chooseTargetsFor(sa);
        } catch (RuntimeException e) {
            Assumptions.abort("targeting needs a running game here: " + e);
            return;
        }
        if (prompts.isEmpty() || !"targets".equals(lastPrompt().get("prompt").getAsString())) {
            Assumptions.abort("no legal targets for " + sa + " in this hand-built state");
            return;
        }
        JsonObject p = next("targets");
        assertTrue(ok);
        assertTrue(p.getAsJsonArray("options").size() >= 1);
        for (GameEntity e : sa.getTargets().getTargetEntities()) candidates.add(e);
        assertEquals(1, candidates.size());
    }

    // ------------------------------------------------------------------ counts clamped to the options (rule 701.21a, 2026-10-19)

    private static List<Card> freshOn(Player owner, String name, int count, ZoneType zone) {
        List<Card> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            Card c = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard(name), owner);
            owner.getZone(zone).add(c);
            out.add(c);
        }
        return out;
    }

    private static boolean logHas(String line) {
        for (var e : game.getGameLog().getLogEntries(null)) if (e.message().equals(line)) return true;
        return false;
    }

    /** The owner's live game: six creatures, "each player sacrifices thirteen creatures", a choose-13-of-6 prompt that could never be answered. */
    @Test
    void countClampBlasphemousEdictSacrificesEverythingWithoutAsking() {
        // only the test's creatures on the battlefield: set the others aside and put them back afterwards
        Map<Player, List<Card>> aside = new java.util.HashMap<>();
        for (Player p : game.getRegisteredPlayers()) {
            List<Card> mine = new ArrayList<>();
            for (Card c : new ArrayList<>(p.getCardsIn(ZoneType.Battlefield))) if (c.isCreature()) { p.getZone(ZoneType.Battlefield).remove(c); mine.add(c); }
            aside.put(p, mine);
        }
        List<Card> made = new ArrayList<>(freshOn(me, "Grizzly Bears", 6, ZoneType.Battlefield));
        made.addAll(freshOn(opp, "Grizzly Bears", 3, ZoneType.Battlefield));
        Card edict = fresh("Blasphemous Edict", ZoneType.Hand);
        int asked = prompts.size();
        try {
            SpellAbility sa = edict.getFirstSpellAbility();
            sa.setActivatingPlayer(me);
            forge.game.ability.AbilityUtils.resolve(sa);
            assertEquals(asked, prompts.size(), "no prompt: every creature has to go");
            assertEquals(0, me.getCreaturesInPlay().size(), "all six of the human's creatures were sacrificed");
            assertEquals(0, opp.getCreaturesInPlay().size(), "and the opponent's three likewise");
            assertTrue(logHas(me.getName() + " sacrificed all 6 creatures (Blasphemous Edict)."), "the log says so");
        } finally {
            drop(edict);
            drop(made.toArray(new Card[0]));
            for (Map.Entry<Player, List<Card>> e : aside.entrySet()) for (Card c : e.getValue()) e.getKey().getZone(ZoneType.Battlefield).add(c);
        }
    }

    @Test
    void countClampSacrificeTwoAsksOnlyWhenThereIsAChoice() {
        List<Card> two = freshOn(me, "Grizzly Bears", 2, ZoneType.Battlefield);
        List<Card> three = freshOn(me, "Llanowar Elves", 3, ZoneType.Battlefield);
        try {
            int asked = prompts.size();
            CardCollectionView both = ctl.choosePermanentsToSacrifice(null, 2, 2, new CardCollection(two), "Sacrifice two creatures");
            assertEquals(asked, prompts.size(), "exactly two creatures: no prompt");
            assertEquals(two, new ArrayList<>(both));
            assertTrue(logHas(me.getName() + " sacrificed both creatures."));

            script.add(p -> answer("options", ints(0, 2)));
            CardCollectionView picked = ctl.choosePermanentsToSacrifice(null, 2, 2, new CardCollection(three), "Sacrifice two creatures");
            JsonObject p = next("chooseMany");
            assertEquals(2, p.get("min").getAsInt());
            assertEquals(2, p.get("max").getAsInt());
            assertEquals(3, p.getAsJsonArray("options").size());
            assertEquals(List.of(three.get(0), three.get(2)), new ArrayList<>(picked));

            // the reverse edge: nothing to choose from is no question at all
            asked = prompts.size();
            assertTrue(ctl.choosePermanentsToSacrifice(null, 0, 1, new CardCollection(), "Sacrifice up to one creature").isEmpty());
            assertTrue(ctl.choosePermanentsToSacrifice(null, 2, 2, new CardCollection(), "Sacrifice two creatures").isEmpty());
            assertTrue(ctl.chooseCardsForEffect(new CardCollection(), null, "Choose up to two", 0, 2, true, null).isEmpty());
            assertEquals(asked, prompts.size(), "no prompt without options");
            // and no prompt ever goes out whose min exceeds its options
            for (JsonObject q : prompts) {
                if (!"chooseMany".equals(q.get("prompt").getAsString())) continue;
                assertTrue(q.get("min").getAsInt() <= q.getAsJsonArray("options").size(), "min within the options: " + q.get("title"));
                assertTrue(q.get("min").getAsInt() <= q.get("max").getAsInt());
            }
        } finally {
            drop(two.toArray(new Card[0]));
            drop(three.toArray(new Card[0]));
        }
    }

    /** Cards offered at a priority prompt (empty when the seat passed without being asked). */
    private static List<Integer> offeredCards() {
        int before = prompts.size();
        List<Integer> ids = new ArrayList<>();
        script.add(p -> {
            for (var e : p.getAsJsonArray("options")) {
                JsonObject o = e.getAsJsonObject();
                if (o.has("cardId")) ids.add(o.get("cardId").getAsInt());
            }
            return new JsonObject(); // pass
        });
        ctl.chooseSpellAbilityToPlay();
        if (prompts.size() == before) script.pollLast();
        return ids;
    }

    /** A cost is paid in full or not at all: "discard two cards" with one other card in hand is not castable (Forge's rule too). */
    @Test
    void countClampDiscardCostThatCannotBePaidIsNotOffered() {
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, me, 5);
        List<Card> handAside = new ArrayList<>(me.getCardsIn(ZoneType.Hand));
        for (Card c : handAside) me.getZone(ZoneType.Hand).remove(c);
        List<Card> mountains = freshOn(me, "Mountain", 2, ZoneType.Battlefield);
        Card reunion = fresh("Cathartic Reunion", ZoneType.Hand);
        List<Card> extra = freshOn(me, "Grizzly Bears", 1, ZoneType.Hand);
        try {
            assertFalse(offeredCards().contains(reunion.getId()), "one other card in hand: the discard-two cost cannot be paid");
            extra.addAll(freshOn(me, "Grizzly Bears", 1, ZoneType.Hand));
            assertTrue(offeredCards().contains(reunion.getId()), "two other cards: castable");
            // and the cost decider refuses a short payment instead of taking what there is
            assertNull(ctl.chooseCardsForCost(new CardCollection(extra.subList(0, 1)), reunion.getFirstSpellAbility(), null, 2, false, "Discard two cards"));
        } finally {
            drop(reunion);
            drop(extra.toArray(new Card[0]));
            drop(mountains.toArray(new Card[0]));
            for (Card c : handAside) me.getZone(ZoneType.Hand).add(c);
        }
    }

    // ------------------------------------------------------------------ decisions that used to be inherited from Forge's AI (2026-10-18 audit)

    private static Card fresh(String name, ZoneType zone) {
        Card c = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard(name), me);
        me.getZone(zone).add(c);
        return c;
    }

    private static void drop(Card... cards) {
        for (Card c : cards) {
            Card live = game.getCardState(c);
            if (live != null && live.getZone() != null) live.getZone().remove(live);
        }
    }

    private static int optionIndexOfPlayer(JsonObject p, Player who) {
        JsonArray opts = p.getAsJsonArray("options");
        for (int i = 0; i < opts.size(); i++) {
            JsonObject o = opts.get(i).getAsJsonObject();
            if (o.has("playerId") && o.get("playerId").getAsInt() == who.getId()) return i;
            if (o.has("kind") && "player".equals(o.get("kind").getAsString()) && o.has("id") && o.get("id").getAsInt() == who.getId()) return i;
        }
        throw new AssertionError("player " + who.getName() + " is not among the options: " + opts);
    }

    @Test
    void inheritedVoteIsTheHumansChoice() {
        int before = prompts.size();
        script.add(p -> answer("option", optionIndexOfPlayer(p, opp)));
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            List<Object> options = new ArrayList<>(List.of(me, opp));
            Object vote = ctl.vote(bolt.getFirstSpellAbility(), "vote", options, com.google.common.collect.ArrayListMultimap.create(), me, false);
            assertEquals(before + 1, prompts.size(), "the vote is asked, not decided by Forge's AI");
            assertEquals("choose", next("choose").get("prompt").getAsString());
            assertEquals(opp, vote);
        } finally { drop(bolt); }
    }

    @Test
    void inheritedCoinFlipCallsAreTheHumans() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            script.add(p -> answer("option", 1));
            assertFalse(ctl.chooseFlipResult(bolt.getFirstSpellAbility(), me, true), "option 1 = tails");
            JsonObject p = next("confirm");
            assertEquals("Heads", p.getAsJsonArray("options").get(0).getAsString());
            script.add(q -> answer("option", 0));
            assertTrue(ctl.chooseFlipResult(bolt.getFirstSpellAbility(), me, false), "keep the winning flip");
            assertEquals("Win the flip", next("confirm").getAsJsonArray("options").get(0).getAsString());
        } finally { drop(bolt); }
    }

    @Test
    void inheritedConvokeTapsWhatTheHumanPicks() {
        List<Card> creatures = new ArrayList<>();
        for (Card c : me.getCardsIn(ZoneType.Battlefield)) if (c.isCreature() && !c.isTapped()) creatures.add(c);
        assertTrue(creatures.size() >= 2, "the test seat has creatures out");
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            int before = prompts.size();
            script.add(p -> answer("options", ints(0)));
            Map<Card, forge.card.mana.ManaCostShard> map = ctl.chooseCardsForConvokeOrImprovise(bolt.getFirstSpellAbility(),
                    new ManaCost(new ManaCostParser("3")), new CardCollection(creatures), false, true, null);
            assertEquals(before + 1, prompts.size(), "convoke is asked");
            JsonObject p = next("chooseMany");
            assertEquals("convoke", p.get("reason").getAsString());
            assertEquals(1, map.size(), "only the picked creature convokes");
            assertTrue(map.containsKey(creatures.get(0)));
            // none = pay with mana
            script.add(q -> answer("options", ints()));
            assertTrue(ctl.chooseCardsForConvokeOrImprovise(bolt.getFirstSpellAbility(), new ManaCost(new ManaCostParser("3")),
                    new CardCollection(creatures), false, true, null).isEmpty());
        } finally { drop(bolt); }
    }

    @Test
    void inheritedConvokeShardsUseColoursFirst() {
        // a green creature pays the {G}, the colourless one the generic
        Card elf = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard("Llanowar Elves"), me);
        Card golem = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard("Stone Golem"), me);
        Map<Card, forge.card.mana.ManaCostShard> m = BridgeController.convokeShards(List.of(golem, elf), new ManaCost(new ManaCostParser("1 G")), false);
        assertNotNull(m);
        assertEquals(forge.card.mana.ManaCostShard.GREEN, m.get(elf));
        assertEquals(forge.card.mana.ManaCostShard.GENERIC, m.get(golem));
        Card golem2 = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard("Stone Golem"), me);
        assertNull(BridgeController.convokeShards(List.of(golem, elf, golem2), new ManaCost(new ManaCostParser("1 G")), false), "more cards than the cost cannot all pay");
    }

    @Test
    void inheritedNewTargetsForACopyAreTheHumans() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            SpellAbility original = bolt.getFirstSpellAbility();
            original.setActivatingPlayer(me);
            original.resetTargets();
            original.getTargets().add(opp);
            SpellAbility copy = forge.game.card.CardFactory.copySpellAbilityAndPossiblyHost(original, original, me);
            copy.setMayChooseNewTargets(true);
            assertTrue(copy.isCopied());
            int before = prompts.size();
            script.add(p -> answer("options", ints(optionIndexOfPlayer(p, me))));
            ctl.orderAndPlaySimultaneousSa(new ArrayList<>(List.of(copy)));
            assertEquals(before + 1, prompts.size(), "the copy's new targets are asked (Forge's AI used to pick them)");
            JsonObject p = next("targets");
            assertTrue(p.get("title").getAsString().startsWith("Choose new targets for Lightning Bolt"), p.get("title").getAsString());
            assertEquals("Keep current targets", p.get("cancelLabel").getAsString());
            assertEquals(1, game.getStack().size(), "the copy is on the stack");
            assertTrue(game.getStack().peekAbility().getTargets().contains(me), "aimed where the human chose");
            // Cancel keeps the targets as they were
            game.getStack().reset();
            SpellAbility copy2 = forge.game.card.CardFactory.copySpellAbilityAndPossiblyHost(original, original, me);
            copy2.setMayChooseNewTargets(true);
            script.add(q -> answer("cancel", true));
            ctl.orderAndPlaySimultaneousSa(new ArrayList<>(List.of(copy2)));
            assertTrue(game.getStack().peekAbility().getTargets().contains(opp), "kept the current target");
        } finally {
            game.getStack().reset();
            drop(bolt);
        }
    }

    @Test
    void inheritedRedirectAsksForTheSameNumberOfTargets() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            SpellAbility sa = bolt.getFirstSpellAbility();
            sa.setActivatingPlayer(me);
            sa.resetTargets();
            sa.getTargets().add(opp);
            // two targets for a one-target spell: asked again, then a legal answer
            script.add(p -> answer("options", ints(0, 1)));
            script.add(p -> answer("options", ints(optionIndexOfPlayer(p, me))));
            forge.game.spellability.TargetChoices tc = ctl.chooseNewTargetsFor(sa, null, false);
            assertNotNull(tc);
            assertTrue(tc.contains(me));
            assertEquals(1, next("targets").get("max").getAsInt());
        } finally { drop(bolt); }
    }

    @Test
    void inheritedCastingChoiceBetweenSeveralSpellsIsTheHumans() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        Card shock = fresh("Shock", ZoneType.Hand);
        try {
            List<SpellAbility> sas = List.of(bolt.getFirstSpellAbility(), shock.getFirstSpellAbility());
            script.add(p -> answer("option", 1));
            assertEquals(shock.getFirstSpellAbility(), ctl.getAbilityToPlay(bolt, sas, null));
            assertTrue(next("choose").get("title").getAsString().startsWith("How do you want to cast"));
        } finally { drop(bolt, shock); }
    }

    @Test
    void inheritedDiceChoicesAreTheHumans() {
        script.add(p -> answer("option", 1));
        assertEquals(5, ctl.chooseRollToIgnore(List.of(3, 5)));
        script.add(p -> answer("options", ints(0, 2)));
        assertEquals(List.of(2, 4), ctl.chooseDiceToReroll(List.of(2, 6, 4)));
        script.add(p -> new JsonObject()); // no option = none
        assertNull(ctl.chooseRollToModify(List.of(1, 2)));
        assertEquals("chooseMany", prompts.get(prompts.size() - 2).get("prompt").getAsString());
    }

    @Test
    void inheritedPreventionShieldIsDividedByTheHuman() {
        Card source = me.getCardsIn(ZoneType.Battlefield).get(0);
        Map<GameEntity, Integer> affected = new java.util.LinkedHashMap<>();
        affected.put(me, 3);
        affected.put(source, 2);
        script.add(p -> answer("amounts", ints(1, 2)));
        Map<GameEntity, Integer> out = ctl.divideShield(source, affected, 3);
        JsonObject p = next("assign");
        assertEquals(3, p.get("total").getAsInt());
        assertEquals(1, out.get(me));
        assertEquals(2, out.get(source));
    }

    @Test
    void inheritedOneOfEachGroupIsPickedPerGroup() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        Card shock = fresh("Shock", ZoneType.Hand);
        try {
            Map<String, CardCollection> groups = new java.util.LinkedHashMap<>();
            groups.put("Instant", new CardCollection(List.of(bolt, shock)));
            groups.put("Red", new CardCollection(List.of(bolt, shock)));
            int before = prompts.size();
            script.add(p -> answer("options", ints(1)));
            CardCollection got = ctl.chooseCardsForEffectMultiple(groups, bolt.getFirstSpellAbility(), "Put into your hand", false);
            // the second group has one card left after the first pick: no choice, so no question
            assertEquals(before + 1, prompts.size(), "one question per group that still has a choice");
            assertEquals(2, got.size());
            assertTrue(got.contains(bolt) && got.contains(shock), "a card picked for one group is not offered again");
        } finally { drop(bolt, shock); }
    }

    @Test
    void inheritedBidsAssistAndDungeonChoicesAreTheHumans() {
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            SpellAbility sa = bolt.getFirstSpellAbility();
            sa.setActivatingPlayer(opp);
            script.add(p -> answer("option", 1));
            assertFalse(ctl.confirmBidAction(sa, PlayerActionConfirmMode.BidLife, "Bid 3 life?", 3, opp));
            assertEquals("Stop bidding", next("confirm").getAsJsonArray("options").get(1).getAsString());
            // Assist: the human decides how much of an opponent's spell to pay; 0 = nothing is tapped
            script.add(p -> answer("value", 0));
            forge.game.mana.ManaCostBeingPaid cost = new forge.game.mana.ManaCostBeingPaid(new ManaCost(new ManaCostParser("3")));
            assertTrue(ctl.helpPayForAssistSpell(cost, sa, 3, 3));
            assertEquals("number", next("number").get("prompt").getAsString());
            assertEquals(3, cost.getGenericManaAmount(), "nothing was paid");
            // venture: which dungeon (any two faces do for the question)
            List<forge.card.ICardFace> faces = List.of(StaticData.instance().getCommonCards().getFaceByName("Mountain"),
                    StaticData.instance().getCommonCards().getFaceByName("Forest"));
            script.add(p -> answer("option", 1));
            assertEquals("Forest", ctl.chooseSingleCardFace(sa, faces, "Choose a dungeon").getName());
        } finally { drop(bolt); }
    }

    @Test
    void inheritedRevealsAndAnnouncedValuesReachTheSeatAsNotices() {
        Card oppCard = opp.getCardsIn(ZoneType.Battlefield).get(0);
        int before = notices.size();
        // through Forge's own path: revealed to every player but the owner, so this seat gets it
        game.getAction().reveal(new CardCollection(oppCard), opp);
        assertEquals(before + 1, notices.size(), "a reveal reaches the human seat as a notice (Forge's AI ignored it)");
        JsonObject n = notices.get(notices.size() - 1);
        assertEquals("reveal", n.get("kind").getAsString());
        assertTrue(n.get("title").getAsString().contains(opp.getName()), n.toString());
        assertEquals(oppCard.getName(), n.getAsJsonArray("cards").get(0).getAsJsonObject().get("name").getAsString());
        assertFalse(n.has("prompt"), "a notice asks nothing");
        // an empty reveal says so
        ctl.reveal(new CardCollection(), ZoneType.Hand, opp, null, true);
        assertTrue(notices.get(notices.size() - 1).get("text").getAsString().startsWith("There are no cards"));
        // a value Forge announces
        Card bolt = fresh("Lightning Bolt", ZoneType.Hand);
        try {
            ctl.notifyOfValue(bolt.getFirstSpellAbility(), opp, "Blue");
            JsonObject v = notices.get(notices.size() - 1);
            assertEquals("info", v.get("kind").getAsString());
            assertTrue(v.get("text").getAsString().contains("Blue"), v.toString());
            assertEquals("Lightning Bolt", v.getAsJsonArray("source").get(0).getAsJsonObject().get("name").getAsString());
        } finally { drop(bolt); }
    }

    @Test
    void zEveryPromptSoFarCarriedAPromptIdAndNoLibraryInItsView() {
        assertTrue(prompts.size() > 10);
        for (JsonObject p : prompts) assertTrue(p.get("promptId").getAsInt() > 0);
        // each view was audited against the game as it stood when the prompt went out (tests move cards between zones)
        assertEquals(List.of(), viewLeaks, "prompt view leak");
    }

    // ------------------------------------------------------------------ hold instants for threats (owner, 2026-10-29)

    private static Card oppCard(String name, ZoneType zone) {
        Card c = Card.fromPaperCard(StaticData.instance().getCommonCards().getCard(name), opp);
        opp.getZone(zone).add(c);
        return c;
    }

    private static SpellAbility aimed(Card card, Player by, forge.game.GameObject target) {
        SpellAbility sa = card.getFirstSpellAbility();
        sa.setActivatingPlayer(by);
        sa.resetTargets();
        if (target != null) sa.getTargets().add(target);
        return sa;
    }

    @Test
    void stackThreatsNameWhatAimsAtMeAndIgnoreTheRest() {
        Card bolt = oppCard("Lightning Bolt", ZoneType.Hand);
        Card wrath = oppCard("Wrath of God", ZoneType.Hand);
        Card edict = oppCard("Blasphemous Edict", ZoneType.Hand);
        Card bear = oppCard("Grizzly Bears", ZoneType.Battlefield);
        Card growth = oppCard("Rampant Growth", ZoneType.Hand);
        Card myBolt = fresh("Lightning Bolt", ZoneType.Hand);
        Card mine = me.getCardsIn(ZoneType.Battlefield).get(0);
        try {
            // their Bolt at my creature
            String why = StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(bolt, opp, mine))), me);
            assertEquals(opp.getName() + "'s Lightning Bolt targets your " + mine.getName(), why);
            // at my face
            assertEquals(opp.getName() + "'s Lightning Bolt targets you", StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(bolt, opp, me))), me));
            // at their own creature: not my business
            assertNull(StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(bolt, opp, bear))), me));
            // a creature or a ramp spell: nothing to protect against
            assertNull(StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(growth, opp, null))), me));
            // a board wipe hits everyone
            String wipe = StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(wrath, opp, null))), me);
            assertNotNull(wipe);
            assertTrue(wipe.startsWith(opp.getName() + "'s Wrath of God affects every"), wipe);
            // "each player sacrifices": everyone too
            String each = StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(edict, opp, null))), me);
            assertNotNull(each);
            assertTrue(each.contains("Blasphemous Edict affects every"), each);
            // my own spell is never a threat to me, even aimed at me
            assertNull(StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(myBolt, me, me))), me));
            // a counterspell on my spell is a threat (protect the spell)
            Card counter = oppCard("Counterspell", ZoneType.Hand);
            try {
                SpellAbility mySpell = aimed(myBolt, me, opp);
                String countered = StackThreats.describe(List.of(new SpellAbilityStackInstance(aimed(counter, opp, mySpell))), me);
                assertEquals(opp.getName() + "'s Counterspell targets your Lightning Bolt", countered);
            } finally {
                drop(counter);
            }
        } finally {
            drop(bolt, wrath, edict, bear, growth, myBolt);
        }
    }

    @Test
    void priorityPassesHarmlessOpponentSpellsAndStopsForThreatsWithTheReason() {
        game.getPhaseHandler().devModeSet(PhaseType.MAIN1, opp, 5);
        Card bear = oppCard("Grizzly Bears", ZoneType.Hand);
        Card bolt = oppCard("Lightning Bolt", ZoneType.Hand);
        Card mine = me.getCardsIn(ZoneType.Battlefield).get(0);
        JsonObject stops = new JsonObject();
        stops.add("myTurn", ints());
        stops.add("theirTurn", ints());
        stops.addProperty("autoPassEmpty", false);
        try {
            // default: "threats". A creature spell on the stack: no question, the seat passes.
            stops.addProperty("respondTo", "threats");
            ctl.session().setStops(stops);
            game.getStack().add(aimed(bear, opp, null));
            int before = prompts.size();
            assertNull(ctl.chooseSpellAbilityToPlay(), "passes without asking");
            assertEquals(before, prompts.size(), "no prompt for a harmless spell");
            game.getStack().reset();
            // their Bolt at my creature: asked, and told why
            game.getStack().add(aimed(bolt, opp, mine));
            script.add(p -> new JsonObject()); // pass
            assertNull(ctl.chooseSpellAbilityToPlay());
            assertEquals(before + 1, prompts.size(), "a threat stops");
            JsonObject p = lastPrompt();
            assertEquals("priority", p.get("prompt").getAsString());
            assertEquals(opp.getName() + "'s Lightning Bolt targets your " + mine.getName(), p.get("threat").getAsString());
            game.getStack().reset();
            // "always": the creature spell asks too
            stops.addProperty("respondTo", "always");
            ctl.session().setStops(stops);
            game.getStack().add(aimed(bear, opp, null));
            script.add(q -> new JsonObject());
            ctl.chooseSpellAbilityToPlay();
            assertEquals(before + 2, prompts.size());
            assertFalse(lastPrompt().has("threat"));
            game.getStack().reset();
            // "never": not even the Bolt
            stops.addProperty("respondTo", "never");
            ctl.session().setStops(stops);
            game.getStack().add(aimed(bolt, opp, mine));
            assertNull(ctl.chooseSpellAbilityToPlay());
            assertEquals(before + 2, prompts.size(), "never: no prompt");
            game.getStack().reset();
        } finally {
            game.getStack().reset();
            ctl.session().setStops(null);
            drop(bear, bolt);
        }
    }
}
