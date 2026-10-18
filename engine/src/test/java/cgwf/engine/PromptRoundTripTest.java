package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import cgwf.engine.bridge.BridgeLobbyPlayer;
import cgwf.engine.bridge.BridgeSession;
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

    @Test
    void zEveryPromptSoFarCarriedAPromptIdAndNoLibraryInItsView() {
        assertTrue(prompts.size() > 10);
        for (JsonObject p : prompts) assertTrue(p.get("promptId").getAsInt() > 0);
        // each view was audited against the game as it stood when the prompt went out (tests move cards between zones)
        assertEquals(List.of(), viewLeaks, "prompt view leak");
    }
}
