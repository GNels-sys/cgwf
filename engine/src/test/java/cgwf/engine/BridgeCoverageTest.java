package cgwf.engine;

import cgwf.engine.bridge.BridgeController;
import forge.game.player.PlayerController;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * BridgeController extends Forge's PlayerControllerAi, so every PlayerController method it does not override is
 * decided by Forge's AI for a human seat. This test lists every non-static, non-private method Forge's
 * PlayerController declares and fails when one is neither declared by BridgeController nor in {@link #ALLOWED}
 * with a verdict and a reason. A Forge bump that adds a decision method therefore fails here until someone routes
 * it to the human or writes down why not (docs/FORGE-ENGINE.md, "Inherited decisions").
 *
 * Verdicts: (c) legitimately automatic: no player choice exists in a CGwF game, or Forge's own human controller
 * (forge-gui PlayerControllerHuman) also decides it without asking; (d) deliberately left to Forge's AI, with the
 * reason; (b) needs a new kind of message to the human (pending, see the doc). Plain reflection, no Forge assets.
 */
class BridgeCoverageTest {
    record Allowed(char verdict, String reason) { }

    private static Allowed c(String reason) { return new Allowed('c', reason); }
    private static Allowed d(String reason) { return new Allowed('d', reason); }
    private static Allowed b(String reason) { return new Allowed('b', reason); }

    /** Key: method name + simple parameter type names, as {@link #key} builds it. */
    static final Map<String, Allowed> ALLOWED = new TreeMap<>();
    static {
        // ---- Forge plumbing: accessors and UI hooks, no decision
        ALLOWED.put("getGame()", c("accessor; no decision"));
        ALLOWED.put("getMatch()", c("accessor; no decision"));
        ALLOWED.put("getPlayer()", c("accessor; no decision"));
        ALLOWED.put("getLobbyPlayer()", c("accessor; no decision"));
        ALLOWED.put("getAnteResult()", c("ante is not played in CGwF"));
        ALLOWED.put("isGuiPlayer()", c("false: no Forge desktop GUI is attached; CGwF's client is reached through prompts"));
        ALLOWED.put("tempShowCards(Iterable)", c("UI hook (no-op); options in prompts already carry the cards the seat may see"));
        ALLOWED.put("endTempShowCards()", c("UI hook (no-op)"));
        ALLOWED.put("autoPassCancel()", c("Forge GUI auto-yield bookkeeping; CGwF stops/auto-pass live in chooseSpellAbilityToPlay"));
        ALLOWED.put("awaitNextInput()", c("Forge GUI input timer; no decision"));
        ALLOWED.put("cancelAwaitNextInput()", c("Forge GUI input timer; no decision"));
        ALLOWED.put("resetAtEndOfTurn()", c("AI per-turn memory reset; no decision"));
        ALLOWED.put("complainCardsCantPlayWell(Deck)", c("message to an AI player about its own deck; never shown to humans"));
        ALLOWED.put("revealAISkipCards(String, Map)", c("message about cards the AI removes from its own deck; rules.setWarnAboutAICards(false)"));
        ALLOWED.put("revealUnsupported(Map)", c("message about unsupported cards; decks are checked before the game"));
        ALLOWED.put("isOrderedZone()", c("Forge desktop preference to sort the hand; no rules effect"));
        ALLOWED.put("orderedMoveToTopOfLibrary(ZoneType, SpellAbility)", c("protected helper of Forge's ordering code; the ordering itself is orderMoveToZoneList (overridden)"));
        ALLOWED.put("getFullControl()", c("Forge's 'full control' flags are empty: the same defaults as Forge's human controller"));
        ALLOWED.put("isFullControl(FullControlFlag)", c("empty set, as Forge's human controller by default: Forge then skips the same optional questions for humans"));
        ALLOWED.put("canPlayUnlimitedLands()", c("developer cheat, false; land drops follow Forge's limits"));
        ALLOWED.put("cheatShuffle(CardCollectionView)", c("AI cheat; returns the shuffle untouched because GameRules.allowCheatShuffle is false"));

        // ---- final overloads that only delegate to a method BridgeController overrides
        ALLOWED.put("addKeywordCost(SpellAbility, Cost, KeywordInterface, String)", c("delegates to chooseNumberForKeywordCost (overridden)"));
        ALLOWED.put("chooseBinary(SpellAbility, String, BinaryChoiceType)", c("final; delegates to chooseBinary(.., Boolean) (overridden)"));
        ALLOWED.put("chooseCardsToDiscardFrom(Player, SpellAbility, CardCollection, int, int)", c("delegates to the 6-argument version (overridden)"));
        ALLOWED.put("chooseSingleEntityForEffect(FCollectionView, SpellAbility, String, Map)", c("final; delegates to the 7-argument version (overridden)"));
        ALLOWED.put("chooseSingleEntityForEffect(FCollectionView, SpellAbility, String, boolean, Map)", c("final; delegates to the 7-argument version (overridden)"));
        ALLOWED.put("chooseSomeType(String, SpellAbility, Collection)", c("final; delegates to the 4-argument version (overridden)"));
        ALLOWED.put("confirmAction(SpellAbility, PlayerActionConfirmMode, String, Map)", c("final; delegates to the 6-argument version (overridden)"));
        ALLOWED.put("confirmAction(SpellAbility, PlayerActionConfirmMode, String, Card, Map)", c("final; delegates to the 6-argument version (overridden)"));
        ALLOWED.put("getAbilityToPlay(Card, List)", c("final; delegates to the 3-argument version (overridden)"));
        ALLOWED.put("getCostDecisionMaker(Player, SpellAbility, boolean)", c("delegates to the 4-argument version (overridden: BridgeCostDecision)"));
        ALLOWED.put("payManaCost(CostPartMana, SpellAbility, String, ManaConversionMatrix, boolean)", c("final; delegates to the 6-argument version (overridden)"));
        ALLOWED.put("chooseSector(Card, String)", c("final; delegates to the 3-argument version (see there)"));
        ALLOWED.put("chooseSprocket(Card)", c("final; delegates to the 2-argument version (see there)"));
        ALLOWED.put("reveal(CardCollectionView, ZoneType, Player)", c("final; delegates to reveal(.., boolean) (see there)"));
        ALLOWED.put("reveal(CardCollectionView, ZoneType, Player, String)", c("final; delegates to reveal(.., boolean) (see there)"));
        ALLOWED.put("reveal(List, ZoneType, PlayerView, String)", c("final; delegates to reveal(.., boolean) (see there)"));
        ALLOWED.put("reveal(DelayedReveal)", c("final; delegates to reveal(.., boolean) (see there)"));

        // ---- Forge's human controller does not ask either
        ALLOWED.put("chooseNumberForCostReduction(SpellAbility, int, int)", c("PlayerControllerHuman returns max unless 'full control' is on: the largest reduction applies"));
        ALLOWED.put("chooseSingleStaticAbility(List)", c("only cost-reduction order calls it; PlayerControllerHuman takes the first unless 'full control' is on"));
        ALLOWED.put("orderCosts(List)", c("PlayerControllerHuman keeps Forge's order unless 'full control' is on"));
        ALLOWED.put("chooseSingleCardFace(SpellAbility, String, Predicate, String)", c("only PlayerControllerHuman's own name picker calls it; the bridge's chooseCardName replaces that picker"));
        ALLOWED.put("orderBlockers(Card, CardCollection)", c("damage assignment order no longer exists (Foundations rules); GameRules.orderCombatants is false, Forge never calls it"));
        ALLOWED.put("orderBlocker(Card, Card, CardCollection)", c("damage assignment order no longer exists; never called with orderCombatants false"));
        ALLOWED.put("orderAttackers(Card, CardCollection)", c("damage assignment order no longer exists; never called with orderCombatants false"));

        // ---- unreachable in a CGwF game
        ALLOWED.put("sideboard(Deck, GameType, String)", c("between games of a match only; CGwF plays one game (gamesPerMatch 1)"));
        ALLOWED.put("chooseCardsYouWonToAddToDeck(List)", c("ante; not played in CGwF"));
        ALLOWED.put("revealAnte(String, Multimap)", c("ante; not played in CGwF"));
        ALLOWED.put("choosePDRollToIgnore(List)", c("planar die; Planechase is not enabled"));
        ALLOWED.put("chooseStartingHand(List)", c("only Backup Plan (a Conspiracy card, not a deck card) creates extra opening hands"));

        // ---- deliberately left to Forge's AI
        ALLOWED.put("applyManaToCost(ManaCostBeingPaid, SpellAbility, String, ManaConversionMatrix, boolean)", d("mana payment stays automatic by the owner's choice (Stage 2 M5 option 1); 'Pay with' steers which sources are tapped first"));
        ALLOWED.put("chooseManaFromPool(List)", d("automatic mana payment (owner's option 1): which pool mana pays a shard"));
        ALLOWED.put("specifyManaCombo(SpellAbility, ColorSet, int, boolean)", d("automatic mana payment (owner's option 1): colours of 'any combination' mana; 'Pay with' steers it toward what the cost needs"));
        ALLOWED.put("chooseSector(Card, String, List)", d("Un-set Attractions/sectors: not Commander-legal"));
        ALLOWED.put("chooseSprocket(Card, List)", d("Un-set Contraptions: not Commander-legal"));
        ALLOWED.put("chooseContraptionsToCrank(List)", d("Un-set Contraptions: not Commander-legal"));
        ALLOWED.put("isAI()", d("stays true: Forge only branches on it for engine-internal paths (one-at-a-time library picks, the 999-action loop guard, AI-unplayable cards left out of random pools, sideboarding); false would take GUI-only paths with no GUI attached"));

        // ---- needs a new message kind (pending: information shown to the seat, no decision)
        ALLOWED.put("reveal(CardCollectionView, ZoneType, Player, String, boolean)", b("revealed cards (Forge's human shows them in a dialog): a per-seat notice is pending"));
        ALLOWED.put("reveal(List, ZoneType, PlayerView, String, boolean)", b("revealed cards to this seat: a per-seat notice is pending"));
        ALLOWED.put("notifyOfValue(SpellAbility, GameObject, String)", b("Forge's human sees a message (chosen colour, number, vote); a per-seat notice is pending"));
    }

    static String key(Method m) {
        return m.getName() + "(" + String.join(", ", Arrays.stream(m.getParameterTypes()).map(Class::getSimpleName).toList()) + ")";
    }

    private static boolean overridden(Method m) {
        try {
            BridgeController.class.getDeclaredMethod(m.getName(), m.getParameterTypes());
            return true;
        } catch (NoSuchMethodException e) {
            return false;
        }
    }

    static List<Method> playerControllerMethods() {
        List<Method> out = new ArrayList<>();
        for (Method m : PlayerController.class.getDeclaredMethods()) {
            int mod = m.getModifiers();
            if (Modifier.isStatic(mod) || Modifier.isPrivate(mod) || m.isSynthetic()) continue;
            out.add(m);
        }
        return out;
    }

    @Test
    void everyPlayerControllerDecisionIsRoutedOrAllowListed() {
        TreeSet<String> unaccounted = new TreeSet<>();
        for (Method m : playerControllerMethods()) {
            if (overridden(m)) continue;
            if (!ALLOWED.containsKey(key(m))) unaccounted.add(key(m) + (Modifier.isAbstract(m.getModifiers()) ? " (abstract: Forge's AI decides it)" : ""));
        }
        assertTrue(unaccounted.isEmpty(), "PlayerController methods BridgeController leaves to Forge's AI with no allow-list entry. "
                + "Route each to the human (override it in BridgeController) or add it to ALLOWED with its verdict and reason, "
                + "and update docs/FORGE-ENGINE.md: " + unaccounted);
    }

    @Test
    void theAllowListHasNoStaleEntries() {
        TreeSet<String> live = new TreeSet<>();
        TreeSet<String> nowOverridden = new TreeSet<>();
        for (Method m : playerControllerMethods()) {
            live.add(key(m));
            if (overridden(m) && ALLOWED.containsKey(key(m))) nowOverridden.add(key(m));
        }
        TreeSet<String> gone = new TreeSet<>(ALLOWED.keySet());
        gone.removeAll(live);
        assertTrue(gone.isEmpty(), "allow-list entries for methods PlayerController no longer has: " + gone);
        assertTrue(nowOverridden.isEmpty(), "allow-list entries for methods BridgeController now overrides (remove them): " + nowOverridden);
        for (Map.Entry<String, Allowed> e : ALLOWED.entrySet()) {
            assertTrue("bcd".indexOf(e.getValue().verdict()) >= 0 && e.getValue().reason().length() > 10, "verdict and reason for " + e.getKey());
        }
    }
}
