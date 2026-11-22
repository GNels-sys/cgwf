package cgwf.engine.bridge;

import cgwf.engine.SeatView;
import com.google.common.collect.ListMultimap;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.StaticData;
import forge.ai.ComputerUtilAbility;
import forge.ai.ComputerUtilCombat;
import forge.ai.ComputerUtil;
import forge.ai.ComputerUtilCost;
import forge.ai.ComputerUtilMana;
import forge.ai.PlayerControllerAi;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.GameActionUtil;
import forge.game.ability.ApiType;
import forge.game.GameLogEntryType;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardState;
import forge.game.card.CardUtil;
import forge.game.card.CounterType;
import forge.game.combat.AttackConstraints;
import forge.game.combat.AttackRequirement;
import forge.game.combat.AttackRestriction;
import forge.game.combat.AttackRestrictionType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.combat.GlobalAttackRestrictions;
import forge.game.cost.Cost;
import forge.game.cost.CostDecisionMakerBase;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartMana;
import forge.game.cost.CostPartWithList;
import forge.game.mana.ManaConversionMatrix;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.ability.effects.RollDiceEffect;
import forge.game.keyword.Keyword;
import forge.game.keyword.KeywordInterface;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetChoices;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.MagicStack;
import forge.game.zone.ZoneType;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Predicate;

/**
 * The human seat. Forge asks a {@code PlayerController} ~110 kinds of questions; this class turns
 * the ones modelled so far into JSON prompts and blocks until the seat answers. Everything it does
 * not model (and every prompt nobody answers: absent seat, timeout) falls through to Forge's own
 * AI, which is what {@code super} is.
 *
 * Casting goes through Forge's own human play flow ({@link PlaySpellAbility}): optional costs
 * (kicker), X and other announcements, targets, then the cost, decided by {@link BridgeCostDecision}
 * (mana is still paid automatically by the AI's mana payer; everything else that picks cards asks
 * the seat). Prompt kinds on the wire: priority, targets, attackers, blockers, choose, chooseMany,
 * confirm, mulligan, number, order, assign, mode, text.
 */
public final class BridgeController extends PlayerControllerAi {
    private final BridgeSession session;
    private final Game game;

    public BridgeController(Game game, Player p, LobbyPlayer lp, BridgeSession session) {
        super(game, p, lp);
        this.game = game;
        this.session = session;
        session.setLoopLog(text -> game.getGameLog().add(GameLogEntryType.INFORMATION, player.getName() + " " + text));
        session.setLoopStackMark(() -> {
            int newest = -1;
            for (SpellAbilityStackInstance si : game.getStack()) newest = Math.max(newest, si.getId());
            return newest;
        });
    }

    public BridgeSession session() { return session; }

    boolean autopilot() { return session.isAbsent(); }

    /** CGWF_DEBUG_PRIORITY=1 prints every priority decision (stops, legal plays) to stderr: for chasing "it never asked me". */
    private static final boolean DEBUG_PRIORITY = "1".equals(System.getenv("CGWF_DEBUG_PRIORITY"));

    /**
     * True while the bridge only asks Forge "could the seat pay this?" (the priority list, X caps, assist).
     * Forge's cost adjustment runs the convoke chooser inside such probes too; the seat must never be asked
     * then (owner, 2026-11-04: the convoke question came up at every priority with Sprout Swarm in hand).
     */
    private boolean probing;

    private <T> T probe(java.util.function.Supplier<T> s) {
        boolean was = probing;
        probing = true;
        try {
            return s.get();
        } finally {
            probing = was;
        }
    }

    private JsonObject prompt(String kind, String title) {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", kind);
        p.addProperty("title", title == null ? "" : title);
        p.add("view", session.viewFor(player));
        return p;
    }

    private static String sourceOf(SpellAbility sa) {
        return sa == null || sa.getHostCard() == null ? null : sa.getHostCard().getName();
    }

    // ------------------------------------------------------------------ priority

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        if (session.concedeRequested() && !player.hasLost()) {
            player.concede();
            return null;
        }
        if (autopilot()) return super.chooseSpellAbilityToPlay();

        PhaseHandler ph = game.getPhaseHandler();
        PhaseType phase = ph.getPhase();
        MagicStack stack = game.getStack();
        // "Repeat this cast N times": cast again while the recording holds, letting each copy resolve in between
        CastReplay replay = session.replay();
        if (replay != null) {
            if (replay.active()) {
                if (!stack.isEmpty()) {
                    SpellAbilityStackInstance top = stack.peek();
                    if (top != null && top.getActivatingPlayer() == player) return null; // my copy resolves first
                    replay.stop("an opponent responded");
                } else {
                    SpellAbility again = repeatable(legalAbilities(), replay.recording());
                    if (again != null) {
                        again.setActivatingPlayer(player);
                        List<SpellAbility> chosen = new ArrayList<>(1);
                        chosen.add(again);
                        return chosen;
                    }
                    replay.stop("it could not be cast again");
                }
            }
            if (!replay.active()) endReplay(replay);
        }
        // "Run the loop": while my own trigger or spell is on top it resolves and the loop goes on. So does an
        // opponent's trigger that was on the stack before the loop began (2026-11-21: an opponent's 120 Scute
        // Swarm triggers, each of which set off the seat's own): the seat had its say on those already. An
        // opponent's spell or activated ability on top ends the loop, and so does an empty stack. A NEW trigger
        // of an opponent's is left to the seat's own stops: asked about it, the loop ends; passed, it goes on.
        LoopReplay running = session.loop();
        boolean loopOverNewTrigger = false;
        if (running != null && running.active()) {
            SpellAbilityStackInstance top = stack.isEmpty() ? null : stack.peek();
            if (top == null) {
                session.stopLoop("nothing was left on the stack");
            } else if (top.getActivatingPlayer() == player) {
                return null;
            } else if (!top.isTrigger()) {
                session.stopLoop(top.getId() > running.stackMark() ? "an opponent responded" : "an opponent's spell or ability is next on the stack");
            } else if (top.getId() <= running.stackMark()) {
                return null;
            } else {
                loopOverNewTrigger = true;
            }
        }
        boolean stackTopNotMine = false;
        if (!stack.isEmpty()) {
            SpellAbilityStackInstance top = stack.peek();
            stackTopNotMine = top == null || top.getActivatingPlayer() != player;
        }
        // Does an opponent's stack item aim at this seat, their cards or their spells, or hit everyone? (2026-10-29)
        String threat = stackTopNotMine ? StackThreats.describe(stack, player) : null;
        // "Resolve all": the seat asked to let the whole stack resolve. Pass until it is empty; an opponent's item
        // that arrived since, and that the seat's own setting would stop for, hands priority back.
        if (session.passingStack()) {
            if (stack.isEmpty() || session.holding(ph.getTurn())) {
                session.clearPassStack();
            } else {
                SpellAbilityStackInstance top = stack.peek();
                boolean fresh = stackTopNotMine && top != null && top.getId() > session.passStackMark();
                String mode = session.stops().respondTo;
                if (fresh && ("always".equals(mode) || ("threats".equals(mode) && threat != null))) session.clearPassStack();
                else return null;
            }
        }
        boolean stop = session.stopsAt(phase == null ? "" : phase.name(), ph.isPlayerTurn(player), stackTopNotMine, threat != null, ph.getTurn());
        // Creatures are attacking this seat: a chance to act once after attackers and once after blocks (2026-11-21),
        // whatever the phase stops say. "End turn" and a running "Resolve all" were dealt with above.
        String attack = attackOnMe(ph, phase);
        String attackStep = attack == null ? null : ph.getTurn() + ":" + phase.name();
        if (!stop && attackStep != null && session.attackStops(attackStep)) stop = true;
        if (DEBUG_PRIORITY) System.err.println("[priority] seat=" + session.seat() + " turn=" + ph.getTurn() + " phase=" + phase + " myTurn=" + ph.isPlayerTurn(player) + " stackTopNotMine=" + stackTopNotMine + " threat=" + threat + " stop=" + stop + " stops=" + session.stops().toJson());
        if (!stop) return null; // auto-pass

        List<SpellAbility> legal = legalAbilities();
        if (DEBUG_PRIORITY) System.err.println("[priority] seat=" + session.seat() + " legal=" + legal.size() + " autoPassEmpty=" + session.autoPassesEmpty(ph.getTurn()));
        // Nothing to play or activate: pass without asking (Arena-style), unless the seat holds this turn.
        if (legal.isEmpty() && session.autoPassesEmpty(ph.getTurn())) return null;
        if (loopOverNewTrigger) session.stopLoop("an opponent's trigger needs your answer");
        if (attackStep != null) session.attackAsked(attackStep);
        JsonObject p = prompt("priority", "You have priority");
        JsonArray opts = new JsonArray();
        for (int i = 0; i < legal.size(); i++) opts.add(abilityJson(i, legal.get(i)));
        p.add("options", opts);
        p.addProperty("phase", phase == null ? null : phase.name());
        p.addProperty("myTurn", ph.isPlayerTurn(player));
        p.addProperty("stackEmpty", stack.isEmpty());
        p.addProperty("stackTopMine", !stack.isEmpty() && !stackTopNotMine);
        p.addProperty("holding", session.holding(ph.getTurn()));
        if (threat != null) p.addProperty("threat", threat); // why the engine stopped: "Blair's Swords to Plowshares targets your Krenko, Mob Boss"
        if (attack != null) p.addProperty("attack", attack); // "Hazel attacks you with 10 creatures"
        // the last spell this seat cast is castable again from the same zone: offer to repeat it N times
        CastReplay.Recording last = session.lastCast();
        SpellAbility againSa = stack.isEmpty() ? repeatable(legal, last) : null;
        int repeatIndex = againSa == null ? -1 : legal.indexOf(againSa);
        if (repeatIndex >= 0) {
            JsonObject rep = new JsonObject();
            rep.addProperty("option", repeatIndex);
            rep.addProperty("cardName", last.cardName());
            rep.addProperty("last", session.lastRepeat());
            rep.addProperty("max", CastReplay.MAX_TIMES);
            p.add("repeat", rep);
        }

        JsonObject a = session.ask(p);
        if (a == null) return super.chooseSpellAbilityToPlay();
        if (isTrue(a, "concede")) {
            player.concede();
            return null;
        }
        if (a.has("passUntilTurn") && !a.get("passUntilTurn").isJsonNull()) {
            session.passUntilTurn(a.get("passUntilTurn").getAsInt());
            return null;
        }
        if (isTrue(a, "passStack") && !stack.isEmpty()) {
            int mark = 0;
            for (SpellAbilityStackInstance si : stack) mark = Math.max(mark, si.getId());
            session.passStack(mark);
            return null;
        }
        if (!a.has("option") || a.get("option").isJsonNull()) return null; // pass
        int idx = a.get("option").getAsInt();
        if (idx < 0 || idx >= legal.size()) {
            session.sendError("option " + idx + " is out of range");
            return Collections.emptyList(); // Forge asks again without passing
        }
        SpellAbility sa = legal.get(idx);
        sa.setActivatingPlayer(player);
        if (idx == repeatIndex && a.has("repeat") && !a.get("repeat").isJsonNull()) {
            int times = 1;
            try { times = a.get("repeat").getAsInt(); } catch (RuntimeException e) { times = 1; }
            if (times > 1) session.startReplay(times); // this cast is the first of them; its prompts replay too
        }
        // Stage 2 M5: "Pay with": the seat may name the mana sources to tap first (the rest is automatic).
        List<Integer> sources = indices(a, "paySources");
        setPaySources(sa.getHostCard(), sources.isEmpty() ? null : sources);
        List<SpellAbility> chosen = new ArrayList<>(1);
        chosen.add(sa);
        return chosen;
    }

    /**
     * In another player's declare-attackers or declare-blockers step: who attacks this seat (or its planeswalkers and
     * battles) and with how many creatures, as a sentence for the prompt; null when nobody does.
     */
    private String attackOnMe(PhaseHandler ph, PhaseType phase) {
        if (phase != PhaseType.COMBAT_DECLARE_ATTACKERS && phase != PhaseType.COMBAT_DECLARE_BLOCKERS) return null;
        if (ph.isPlayerTurn(player)) return null;
        Combat combat = game.getCombat();
        if (combat == null) return null;
        int n = 0;
        for (Card a : combat.getAttackers()) if (combat.getDefenderPlayerByAttacker(a) == player) n++;
        if (n == 0) return null;
        Player attacker = combat.getAttackingPlayer();
        String who = attacker == null ? "An opponent" : attacker.getName();
        String count = n == 1 ? "1 creature" : n + " creatures";
        if (phase == PhaseType.COMBAT_DECLARE_BLOCKERS) return "Blocks are declared: " + who + "'s " + count + " attacking you " + (n == 1 ? "deals" : "deal") + " damage next";
        return who + " attacks you with " + count;
    }

    /** Everything this seat could legally play or activate right now, mana permitting. */
    private List<SpellAbility> legalAbilities() {
        CardCollection cards = ComputerUtilAbility.getAvailableCards(game, player);
        List<SpellAbility> out = new ArrayList<>();
        for (SpellAbility sa : withAlternativeCosts(ComputerUtilAbility.getSpellAbilities(cards, player))) {
            if (sa.isManaAbility()) continue; // paid automatically
            Card host = sa.getHostCard();
            if (host == null) continue;
            // the AI's candidate list includes the top card of EVERY library (for "play from the top" effects);
            // never offer a card the seat may not see
            if (host.isInZone(ZoneType.Library) && !host.getView().canBeShownTo(player.getView())) continue;
            if (host.isInZone(ZoneType.Hand) && host.getController() != player) continue;
            boolean ok;
            try {
                sa.setActivatingPlayer(player);
                boolean canPlay = sa.canPlay();
                boolean canPay = canPlay && (probe(() -> ComputerUtilCost.canPayCost(sa, player, false)) || canPayWithRichSources(sa) || canPayThroughFilters(sa));
                boolean hasTargets = canPay && (!sa.usesTargeting() || sa.getMinTargets() == 0 || !targetCandidates(sa).isEmpty());
                ok = canPlay && canPay && hasTargets;
                if (DEBUG_PRIORITY && host.isInZone(ZoneType.Hand)) System.err.println("[priority]   " + host.getName() + ": canPlay=" + canPlay + " canPay=" + canPay + " targets=" + hasTargets);
            } catch (RuntimeException e) {
                if (DEBUG_PRIORITY) System.err.println("[priority]   " + host.getName() + ": " + e);
                ok = false;
            }
            if (ok) out.add(sa);
        }
        return out;
    }

    /**
     * Forge's list for its AI leaves out a spell's alternative costs whenever the card can also be cast the
     * ordinary way, and the AI adds them back afterwards (`getOriginalAndAltCostAbilities`). The seat needs them
     * as choices of their own: Darksteel Monolith's "pay {0} rather than pay the mana cost", Omniscience-style
     * permissions. (Owner report 2026-11-18: the Monolith's cast was never offered.) Each one is listed once, by
     * its card and wording; whether it may be cast now is decided by the same checks as every other entry.
     */
    private List<SpellAbility> withAlternativeCosts(List<SpellAbility> basic) {
        List<SpellAbility> out = new ArrayList<>(basic);
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (SpellAbility sa : basic) if (sa.getHostCard() != null) seen.add(sa.getHostCard().getId() + "|" + sa);
        for (SpellAbility sa : basic) {
            Card host = sa.getHostCard();
            if (host == null || !sa.isSpell() || sa.isManaAbility()) continue;
            try {
                sa.setActivatingPlayer(player);
                for (SpellAbility alt : GameActionUtil.getAlternativeCosts(sa, player, false)) {
                    if (alt != null && alt.getHostCard() != null && seen.add(alt.getHostCard().getId() + "|" + alt)) out.add(alt);
                }
            } catch (RuntimeException e) {
                if (DEBUG_PRIORITY) System.err.println("[priority]   " + host.getName() + " alternative costs: " + e);
            }
        }
        return out;
    }

    private static JsonObject abilityJson(int index, SpellAbility sa) {
        JsonObject j = new JsonObject();
        Card host = sa.getHostCard();
        j.addProperty("index", index);
        j.addProperty("cardId", host.getId());
        j.addProperty("cardName", host.getName());
        j.addProperty("zone", host.getZone() == null ? null : host.getZone().getZoneType().name());
        j.addProperty("kind", sa.isLandAbility() ? "land" : sa.isSpell() ? "spell" : "ability");
        j.addProperty("description", sa.toString());
        j.addProperty("cost", sa.getPayCosts() == null ? null : sa.getPayCosts().toSimpleString());
        j.addProperty("targets", sa.usesTargeting());
        return j;
    }

    // ------------------------------------------------------------------ mana: automatic, with "Pay with" (Stage 2 M5)

    /** Card ids the seat asked to tap for the next payment of {@link #paySourcesHost}, in the order given. */
    private List<Integer> paySources;
    private Card paySourcesHost;

    void setPaySources(Card host, List<Integer> sources) {
        paySources = sources;
        paySourcesHost = sources == null ? null : host;
    }

    /**
     * Mana stays automatic (Forge's AI payer), but when the seat chose sources for this cast those are
     * activated first, their mana goes to the pool, and the payer draws on the pool before tapping
     * anything else. Sources that cannot pay (tapped, gone, not a mana source) are skipped; leftover
     * mana floats in the pool like any other floating mana.
     */
    @Override
    public boolean payManaCost(ManaCost toPay, CostPartMana costPartMana, SpellAbility sa, String prompt, ManaConversionMatrix matrix, boolean effect) {
        List<Integer> sources = paySources;
        Card host = paySourcesHost;
        if (sources != null && !autopilot() && sa != null && sa.getHostCard() != null && host != null && sa.getHostCard().getId() == host.getId()) {
            paySources = null;
            paySourcesHost = null;
            try {
                tapChosenSources(sources, toPay);
            } catch (RuntimeException e) {
                session.sendError("could not tap the chosen sources: " + e.getMessage());
            }
        }
        if (!autopilot() && sa != null && toPay != null) {
            try {
                tapRichSourcesIfNeeded(toPay, sa, effect);
            } catch (RuntimeException e) {
                session.sendError("could not tap for the larger amount of mana: " + e.getMessage());
            }
        }
        if (super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect)) return true;
        if (autopilot() || sa == null || toPay == null) return false;
        // Forge's payer could not do it. When the board has mana abilities that cost mana themselves (Signets,
        // filter lands) the reason is usually that it cannot chain them: float the mana in a workable order
        // (ManaFloat) and let it pay from the pool. Owner report 2026-11-18: the commander could not be cast.
        try {
            ManaCostBeingPaid need = new ManaCostBeingPaid(toPay);
            Integer x = sa.getXManaCostPaid();
            if (need.getXcounter() > 0 && x != null && x > 0) need.increaseGenericMana(x * need.getXcounter());
            if (ManaFloat.floatFor(player, game, need, 20_000)) return super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect);
        } catch (RuntimeException e) {
            session.sendError("could not pay through the mana abilities: " + e.getMessage());
        }
        return false;
    }

    /** The legal list: could a chain of mana abilities that cost mana themselves pay for this? (ManaFloat; nothing is activated.) */
    private boolean canPayThroughFilters(SpellAbility sa) {
        if (sa == null || sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()) return false;
        return probe(() -> {
            ManaCostBeingPaid cost = ComputerUtilMana.calculateManaCost(sa.getPayCosts(), sa, player, true, 0, false);
            return cost != null && ManaFloat.couldPay(player, cost, 3_000);
        });
    }

    /**
     * A permanent with two mana abilities for the same cost where one makes more mana than the other (The
     * Eternity Elevator at 20 charge counters: {C}{C}{C}, or X mana of any one colour). Forge's automatic payer
     * takes the first ability of a card and never looks at the second, so it counted the Elevator as three mana.
     * (Owner report 2026-11-18: spells the Elevator could pay for were not offered.)
     */
    private record RichSource(Card card, SpellAbility best, int amount, List<String> colours) { }

    private List<RichSource> richSources() {
        List<RichSource> out = new ArrayList<>();
        for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
            if (c.isTapped() || c.getManaAbilities().size() < 2) continue;
            SpellAbility best = null;
            int bestAmount = 0;
            int least = Integer.MAX_VALUE;
            for (SpellAbility ma : c.getManaAbilities()) {
                AbilityManaPart mp = ma.getManaPart();
                if (mp == null || ma.getApi() != ApiType.Mana) continue;
                Cost cost = ma.getPayCosts();
                // only plain "{T}: Add ..." abilities whose mana may be spent on anything
                if (cost == null || !cost.hasTapCost() || cost.hasManaCost() || cost.getCostParts().size() != 1) continue;
                String limits = mp.getManaRestrictions();
                if (limits != null && !limits.isEmpty()) continue;
                int amount;
                try {
                    ma.setActivatingPlayer(player);
                    if (!ma.canPlay()) continue;
                    amount = ma.amountOfManaGenerated(true);
                } catch (RuntimeException e) {
                    continue;
                }
                least = Math.min(least, amount);
                if (amount > bestAmount) { best = ma; bestAmount = amount; }
            }
            if (best != null && bestAmount > least) out.add(new RichSource(c, best, bestAmount, producedColours(best, best.getManaPart())));
        }
        return out;
    }

    private static ManaCostShard shardOf(String letter) {
        return switch (letter) {
            case "W" -> ManaCostShard.WHITE;
            case "U" -> ManaCostShard.BLUE;
            case "B" -> ManaCostShard.BLACK;
            case "R" -> ManaCostShard.RED;
            case "G" -> ManaCostShard.GREEN;
            case "C" -> ManaCostShard.COLORLESS;
            default -> null;
        };
    }

    /** The colour of this source the cost needs most (null = none of its colours is asked for by name). */
    private static String colourFor(RichSource r, ManaCostBeingPaid cost) {
        String pick = null;
        int most = 0;
        List<String> colours = r.colours().contains("any") ? List.of("W", "U", "B", "R", "G") : r.colours();
        for (String col : colours) {
            ManaCostShard shard = shardOf(col);
            int n = shard == null ? 0 : cost.getUnpaidShards(shard);
            if (n > most) { most = n; pick = col; }
        }
        return pick;
    }

    /** Take what one rich source would pay off a cost: pips of its one colour first, then generic mana. */
    private static void payOff(RichSource r, ManaCostBeingPaid cost) {
        int left = r.amount();
        String col = colourFor(r, cost);
        if (col != null) {
            ManaCostShard shard = shardOf(col);
            int n = Math.min(left, cost.getUnpaidShards(shard));
            if (n > 0) { cost.decreaseShard(shard, n); left -= n; }
        }
        int generic = Math.min(left, cost.getGenericManaAmount());
        if (generic > 0) cost.decreaseGenericMana(generic);
    }

    /**
     * Could the cost be paid if the rich sources were tapped for their larger ability and the automatic payer
     * covered the rest from everything else? Nothing is activated: the sources are set aside (shown to the payer
     * as tapped) only while it is asked, and put back.
     */
    private boolean canPayWithRichSources(SpellAbility sa) {
        if (sa == null || sa.getPayCosts() == null || !sa.getPayCosts().hasManaCost()) return false;
        List<RichSource> rich = richSources();
        if (rich.isEmpty()) return false;
        return probe(() -> {
            ManaCostBeingPaid cost = ComputerUtilMana.calculateManaCost(sa.getPayCosts(), sa, player, true, 0, false);
            if (cost == null) return false;
            for (RichSource r : rich) payOff(r, cost);
            for (RichSource r : rich) r.card().setTapped(true);
            try {
                return cost.isPaid() || ComputerUtilMana.canPayManaCost(cost, sa, player, false);
            } finally {
                for (RichSource r : rich) r.card().setTapped(false);
            }
        });
    }

    /**
     * Right before the automatic payer runs: when it cannot cover the cost the way it taps (a rich source for
     * its first ability), tap the rich sources for their larger ability first, one at a time, until it can. The
     * mana goes to the pool, the payer draws on the pool before tapping anything else, and what is left floats.
     * A colour the cost asks for is chosen for the seat; otherwise Forge asks the seat which colour to make.
     */
    private void tapRichSourcesIfNeeded(ManaCost toPay, SpellAbility sa, boolean effect) {
        List<RichSource> rich = richSources();
        if (rich.isEmpty()) return;
        Cost cost = new Cost(toPay, effect);
        for (RichSource r : rich) {
            if (probe(() -> ComputerUtilMana.canPayManaCost(cost, sa, player, 0, effect))) return;
            AbilityManaPart mp = r.best().getManaPart();
            ManaCostBeingPaid need = new ManaCostBeingPaid(toPay);
            String col = colourFor(r, need);
            if (col != null && (mp.isAnyMana() || mp.isComboMana())) mp.setExpressChoice(col);
            r.best().setActivatingPlayer(player);
            ComputerUtil.playNoStack(player, r.best(), game, false);
        }
    }

    /** Activates one mana ability per chosen source, steering colour choices toward what the cost still needs. */
    public void tapChosenSources(List<Integer> sources, ManaCost toPay) {
        List<String> needColours = new ArrayList<>();
        int generic = toPay == null ? 0 : toPay.getGenericCost();
        if (toPay != null) {
            for (char ch : toPay.toString().toCharArray()) {
                if ("WUBRGC".indexOf(ch) >= 0) needColours.add(String.valueOf(ch));
            }
        }
        for (int id : sources) {
            Card c = game.findById(id);
            if (c == null || c.getController() != player || !c.isInZone(ZoneType.Battlefield) || c.isTapped()) continue;
            SpellAbility pick = null;
            String pickColour = null;
            int pickAmount = 0;
            for (SpellAbility ma : c.getManaAbilities()) {
                ma.setActivatingPlayer(player);
                AbilityManaPart mp = ma.getManaPart();
                if (mp == null) continue;
                boolean playable;
                try { playable = ma.canPlay() && probe(() -> ComputerUtilCost.canPayCost(ma, player, false)); } catch (RuntimeException e) { playable = false; }
                if (!playable) continue;
                List<String> produces = producedColours(ma, mp);
                String match = null;
                for (String col : produces) if (needColours.contains(col)) { match = col; break; }
                int amount;
                try { amount = ma.amountOfManaGenerated(true); } catch (RuntimeException e) { amount = 1; }
                // no colour decides: the ability that makes the most mana (The Eternity Elevator's X, not its {C}{C}{C})
                if (pick == null || amount > pickAmount) { pick = ma; pickAmount = amount; }
                if (match != null) { pick = ma; pickColour = match; break; }
                if (produces.contains("any") && !needColours.isEmpty()) { pick = ma; pickColour = needColours.get(0); break; }
            }
            if (pick == null) continue;
            AbilityManaPart mp = pick.getManaPart();
            if (pickColour != null && (mp.isAnyMana() || mp.isComboMana())) mp.setExpressChoice(pickColour);
            if (!ComputerUtil.playNoStack(player, pick, game, false)) continue;
            if (pickColour != null) needColours.remove(pickColour);
            else if (generic > 0) generic--;
        }
    }

    /** The colour letters a mana ability can make ("any" for any-colour sources). */
    public static List<String> producedColours(SpellAbility ma, AbilityManaPart mp) {
        List<String> out = new ArrayList<>();
        if (mp.isAnyMana()) { out.add("any"); return out; }
        String spec = mp.isComboMana() ? mp.getComboColors(ma) : mp.getOrigProduced();
        if (spec == null) return out;
        for (String part : spec.split(" ")) {
            String p = part.trim();
            if (p.isEmpty()) continue;
            if (p.equalsIgnoreCase("Any")) { out.add("any"); continue; }
            String letter = switch (p.toUpperCase(Locale.ROOT)) {
                case "W", "WHITE" -> "W";
                case "U", "BLUE" -> "U";
                case "B", "BLACK" -> "B";
                case "R", "RED" -> "R";
                case "G", "GREEN" -> "G";
                case "C", "COLORLESS" -> "C";
                default -> null;
            };
            if (letter != null && !out.contains(letter)) out.add(letter);
        }
        return out;
    }

    // ------------------------------------------------------------------ playing: Forge's human flow

    /** The seat picked an ability: cast it the way Forge casts for a human (optional costs, X, targets, costs). */
    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (autopilot()) return super.playChosenSpellAbility(sa);
        if (sa.isLandAbility()) {
            if (sa.canPlay()) sa.resolve();
            return true;
        }
        Card host = sa.getHostCard();
        boolean record = sa.isSpell() && host != null;
        if (record) session.startRecording(host.getName(), host.getZone() == null ? "" : host.getZone().getZoneType().name());
        boolean ok;
        try {
            ok = PlaySpellAbility.playSpellAbility(this, player, sa);
        } catch (RuntimeException e) {
            if (record) session.finishRecording(false);
            throw e;
        }
        if (record) session.finishRecording(ok);
        return ok;
    }

    /** The legal spell that repeats `rec` (same card name, cast from the same zone), or null. */
    private static SpellAbility repeatable(List<SpellAbility> legal, CastReplay.Recording rec) {
        if (rec == null) return null;
        for (SpellAbility sa : legal) {
            Card host = sa.getHostCard();
            if (!sa.isSpell() || host == null || !rec.cardName().equals(host.getName())) continue;
            String zone = host.getZone() == null ? "" : host.getZone().getZoneType().name();
            if (zone.equals(rec.zone())) return sa;
        }
        return null;
    }

    /** A repeat ended (all done, or stopped early): tell the seat and the log, forget the replay. */
    private void endReplay(CastReplay r) {
        String text = r.finished()
            ? "Repeated " + r.cardName() + " " + r.done() + (r.done() == 1 ? " time." : " times.")
            : "Repeated " + r.cardName() + " " + r.done() + " of " + r.wanted() + " times; stopped: " + r.stopReason() + ".";
        game.getGameLog().add(GameLogEntryType.INFORMATION, player.getName() + " repeated " + r.cardName() + " " + r.done() + (r.done() == 1 ? " time." : " times."));
        JsonObject n = notice("info", "Repeat");
        n.addProperty("text", text);
        session.send(n);
        session.clearReplay();
    }

    @Override
    public boolean playTrigger(Card host, WrappedAbility wrapperAbility, boolean isMandatory) {
        if (autopilot()) return super.playTrigger(host, wrapperAbility, isMandatory);
        return PlaySpellAbility.playSpellAbilityNoStack(this, player, wrapperAbility, false);
    }

    @Override
    public boolean playSaFromPlayEffect(SpellAbility tgtSA) {
        if (autopilot()) return super.playSaFromPlayEffect(tgtSA);
        return PlaySpellAbility.playSpellAbility(this, player, tgtSA);
    }

    @Override
    public void playSpellAbilityNoStack(SpellAbility effectSA, boolean canSetupTargets) {
        if (openingHandPicks.remove(effectSA) && effectSA.getHostCard() != null) {
            game.getGameLog().add(GameLogEntryType.INFORMATION, player.getName() + " uses " + effectSA.getHostCard().getName() + " from their opening hand.");
        }
        if (autopilot()) { super.playSpellAbilityNoStack(effectSA, canSetupTargets); return; }
        PlaySpellAbility.playSpellAbilityNoStack(this, player, effectSA, !canSetupTargets);
    }

    @Override
    public CostDecisionMakerBase getCostDecisionMaker(Player p, SpellAbility ability, boolean effect, String prompt) {
        return new BridgeCostDecision(this, p, ability, effect);
    }

    @Override
    public CardCollectionView chooseCardsForCost(CardCollectionView optionList, SpellAbility sa, CostPartWithList cpl, int amount, boolean isOptional, String prompt) {
        List<Card> valid = new ArrayList<>();
        for (Card c : optionList) valid.add(c);
        if (valid.size() < amount) return null; // a cost is paid in full or not at all (Forge's human controller: null)
        List<Card> chosen = autopilot() ? null : chooseCards(prompt == null || prompt.isBlank() ? "Pay the cost of " + sourceOf(sa) : prompt, sourceOf(sa), valid, isOptional ? 0 : amount, amount, "cost");
        if (chosen == null) return super.chooseCardsForCost(optionList, sa, cpl, amount, isOptional, prompt);
        return new CardCollection(chosen);
    }

    // ------------------------------------------------------------------ targets

    /** Legal targets of one ability: cards, players and spells/abilities on the stack. */
    private List<GameObject> targetCandidates(SpellAbility sa) {
        List<GameObject> candidates = new ArrayList<>(CardUtil.getValidCardsToTarget(sa));
        if (sa.getTargetRestrictions() != null && sa.getTargetRestrictions().canTgtPlayer()) {
            for (Player p : game.getPlayers()) if (sa.canTarget(p)) candidates.add(p);
        }
        for (SpellAbilityStackInstance si : game.getStack()) {
            SpellAbility onStack = si.getSpellAbility();
            if (onStack != null && onStack != sa && sa.canTargetSpellAbility(onStack)) candidates.add(onStack);
        }
        return candidates;
    }

    /** Forge calls this for every targeting ability in a chain while casting (setupTargets). */
    @Override
    public boolean chooseTargetsFor(SpellAbility sa) {
        if (autopilot()) return super.chooseTargetsFor(sa);
        sa.resetTargets();
        List<GameObject> candidates = targetCandidates(sa);
        int min = sa.getMinTargets();
        int max = sa.getMaxTargets();
        if (candidates.isEmpty()) return min == 0;
        JsonObject p = prompt("targets", "Choose targets for " + sa.getHostCard().getName());
        p.addProperty("ability", sa.toString());
        p.addProperty("source", sourceOf(sa));
        p.addProperty("min", min);
        p.addProperty("max", max);
        p.add("options", objectsJson(candidates));
        JsonObject a = session.ask(p);
        if (a == null) return super.chooseTargetsFor(sa);
        if (isTrue(a, "cancel")) return false;
        for (int idx : indices(a, "options")) {
            if (idx >= 0 && idx < candidates.size()) sa.getTargets().add(candidates.get(idx));
        }
        if (!sa.isTargetNumberValid()) {
            session.sendError("that is not a legal set of targets");
            return false;
        }
        return divideAmongTargets(sa);
    }

    /** "Divided as you choose" (Fireball, Electrolyze): how much goes where. */
    private boolean divideAmongTargets(SpellAbility sa) {
        int amount = sa.getStillToDivide();
        List<GameEntity> targets = new ArrayList<>();
        for (GameEntity e : sa.getTargets().getTargetEntities()) targets.add(e);
        if (amount <= 0 || targets.isEmpty()) return true;
        if (sa.hasParam("DividedUpTo")) {
            Integer n = number("How much in total?", sourceOf(sa), targets.size(), amount, null);
            amount = n == null ? amount : n;
        }
        if (targets.size() == 1) {
            sa.addDividedAllocation(targets.get(0), amount);
            return true;
        }
        if (targets.size() == amount) {
            for (GameEntity e : targets) sa.addDividedAllocation(e, 1);
            return true;
        }
        if (targets.size() > amount) return false;
        List<Integer> amounts = assign("Divide " + amount + " among the targets", sourceOf(sa), null, targets, amount, null);
        if (amounts == null) {
            // even split, remainder on the first
            int each = amount / targets.size();
            int rest = amount - each * targets.size();
            for (int i = 0; i < targets.size(); i++) sa.addDividedAllocation(targets.get(i), each + (i == 0 ? rest : 0));
            return true;
        }
        for (int i = 0; i < targets.size(); i++) sa.addDividedAllocation(targets.get(i), amounts.get(i));
        return sa.getStillToDivide() <= 0;
    }

    // ------------------------------------------------------------------ combat

    /**
     * Declare attackers. Each ask is the WHOLE declaration: the combat is emptied first, because Forge calls
     * again after it refuses an attack (and after an unpaid attack cost) with the earlier attackers still in
     * it. Until 2026-11-18 a refused attacker stayed there and no later answer could re-aim or remove it, so one
     * wrong declaration could never be put right (owner report: sixteen refusals in a row).
     *
     * The prompt says what the rules require before anything is declared: `mustAttack` on a creature (the
     * players or planeswalkers it has to attack if able: an encore copy, a goaded creature, "attacks each combat
     * if able") and `notes` in words (those, plus limits such as "No more than one creature can attack"). An
     * answer the rules refuse comes back with `refused` saying why; after three refusals only the attackers the
     * rules require are declared.
     */
    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        if (autopilot()) { super.declareAttackers(attacker, combat); return; }
        String refused = null;
        for (int tries = 0; ; tries++) {
            if (!combat.getAttackers().isEmpty()) combat.clearAttackers();
            List<GameEntity> defenders = new ArrayList<>();
            for (GameEntity d : combat.getDefenders()) defenders.add(d);
            AttackConstraints rules = combat.getAttackConstraints();
            List<String> notes = new ArrayList<>();
            Map<Card, String> mustText = new LinkedHashMap<>();
            List<Card> candidates = new ArrayList<>();
            JsonArray cands = new JsonArray();
            for (Card c : attacker.getCreaturesInPlay()) {
                if (!CombatUtil.canAttack(c)) continue;
                List<GameEntity> allowedList = new ArrayList<>();
                JsonArray allowed = new JsonArray();
                for (GameEntity d : defenders) if (CombatUtil.canAttack(c, d)) { allowed.add(SeatView.entityRef(d)); allowedList.add(d); }
                if (allowed.isEmpty()) continue;
                JsonObject cj = SeatView.card(c, player);
                cj.add("canAttack", allowed);
                List<GameEntity> must = mustAttack(rules, c, allowedList);
                if (!must.isEmpty()) {
                    JsonArray mj = new JsonArray();
                    for (GameEntity d : must) mj.add(SeatView.entityRef(d));
                    cj.add("mustAttack", mj);
                    String text = c.getName() + " must attack " + (must.size() < allowedList.size() ? orList(must) + " " : "") + "this combat if able.";
                    mustText.put(c, text);
                    if (!notes.contains(text)) notes.add(text);
                }
                cands.add(cj);
                candidates.add(c);
            }
            if (candidates.isEmpty()) return;
            List<String> limits = attackLimits(rules);
            notes.addAll(limits);
            JsonObject p = prompt("attackers", "Declare attackers");
            p.add("candidates", cands);
            JsonArray defs = new JsonArray();
            for (GameEntity d : defenders) {
                JsonObject dj = SeatView.entityRef(d);
                if (d instanceof Player pl) dj.addProperty("life", pl.getLife());
                if (d instanceof Card dc) {
                    dj.addProperty("name", dc.getName());
                    dj.addProperty("controller", dc.getController() == null ? null : dc.getController().getId());
                }
                defs.add(dj);
            }
            p.add("defenders", defs);
            if (!notes.isEmpty()) {
                JsonArray nj = new JsonArray();
                for (String n : notes) nj.add(n);
                p.add("notes", nj);
            }
            if (refused != null) p.addProperty("refused", refused);
            JsonObject a = session.ask(p);
            if (a == null) { super.declareAttackers(attacker, combat); return; }
            if (a.has("attacks") && a.get("attacks").isJsonArray()) {
                for (JsonElement e : a.getAsJsonArray("attacks")) {
                    JsonObject att = e.getAsJsonObject();
                    Card c = byId(candidates, att.get("cardId").getAsInt());
                    GameEntity d = defenderOf(defenders, att.getAsJsonObject("defender"));
                    if (c != null && d != null && CombatUtil.canAttack(c, d) && !combat.isAttacking(c)) combat.addAttacker(c, d);
                }
            }
            if (CombatUtil.validateAttackers(combat)) return;
            // refused by the rules: say why, and ask again from an empty attack
            Map<Card, GameEntity> declared = new LinkedHashMap<>(combat.getAttackersAndDefenders());
            List<String> problems = new ArrayList<>();
            if (!rules.getGlobalRestrictions().isLegal(declared)) problems.addAll(limits);
            for (Map.Entry<Card, GameEntity> e : declared.entrySet()) {
                AttackRestriction r = rules.getRestrictions().get(e.getKey());
                if (r == null) continue;
                for (AttackRestrictionType t : r.getViolation(declared)) {
                    String text = e.getKey().getName() + " " + restrictionWords(t) + ".";
                    if (!problems.contains(text)) problems.add(text);
                }
            }
            for (Map.Entry<Card, String> e : mustText.entrySet()) {
                AttackRequirement req = rules.getRequirements().get(e.getKey());
                if (req != null && req.countViolations(declared.get(e.getKey()), declared) > 0 && !problems.contains(e.getValue())) problems.add(e.getValue());
            }
            combat.clearAttackers();
            if (tries >= 2) {
                for (Map.Entry<Card, GameEntity> e : rules.getLegalAttackers().getLeft().entrySet()) combat.addAttacker(e.getKey(), e.getValue());
                JsonObject n = notice("info", "Attack");
                n.addProperty("text", "Three attacks in a row were not legal, so only the attackers the rules require were declared.");
                session.send(n);
                return;
            }
            refused = "That attack is not legal. " + (problems.isEmpty() ? "It breaks a rule about which creatures must or may attack." : String.join(" ", problems));
        }
    }

    /** Whom this creature has to attack if able: the defenders its requirements weigh highest; empty = no requirement. */
    private static List<GameEntity> mustAttack(AttackConstraints rules, Card c, List<GameEntity> allowed) {
        List<GameEntity> out = new ArrayList<>();
        AttackRequirement req = rules.getRequirements().get(c);
        if (req == null || !req.hasRequirement()) return out;
        int most = 0;
        for (Pair<GameEntity, Integer> e : req.getSortedRequirements()) if (allowed.contains(e.getLeft())) most = Math.max(most, e.getRight());
        if (most <= 0) return out;
        for (Pair<GameEntity, Integer> e : req.getSortedRequirements()) if (e.getRight() == most && allowed.contains(e.getLeft())) out.add(e.getLeft());
        return out;
    }

    private static String orList(List<GameEntity> entities) {
        List<String> names = new ArrayList<>();
        for (GameEntity e : entities) names.add(e.getName());
        if (names.size() <= 1) return names.isEmpty() ? "" : names.get(0);
        return String.join(", ", names.subList(0, names.size() - 1)) + " or " + names.get(names.size() - 1);
    }

    private static String creatureCount(int n) {
        String[] words = {"no", "one", "two", "three", "four", "five", "six"};
        return (n >= 0 && n < words.length ? words[n] : String.valueOf(n)) + (n == 1 ? " creature" : " creatures");
    }

    /** Limits on the whole attack, in words (Silent Arbiter, Crawlspace, Dueling Grounds). */
    private static List<String> attackLimits(AttackConstraints rules) {
        List<String> out = new ArrayList<>();
        GlobalAttackRestrictions g = rules.getGlobalRestrictions();
        if (g == null) return out;
        if (g.getMax() != null) out.add("No more than " + creatureCount(g.getMax()) + " can attack this combat.");
        for (Map.Entry<GameEntity, Integer> e : g.getDefenderMax().entrySet()) {
            if (e.getValue() == null) continue;
            out.add("No more than " + creatureCount(e.getValue()) + " can attack " + e.getKey().getName() + " this combat.");
        }
        return out;
    }

    private static String restrictionWords(AttackRestrictionType t) {
        return switch (t) {
            case ONLY_ALONE -> "can only attack alone";
            case NOT_ALONE -> "can't attack alone";
            case NEED_TWO_OTHERS -> "can't attack unless at least two other creatures attack";
            case NEED_GREATER_POWER -> "can't attack unless a creature with greater power also attacks";
            case NEED_BLACK_OR_GREEN -> "can't attack unless a black or green creature also attacks";
            default -> "can't attack";
        };
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        if (autopilot()) { super.declareBlockers(defender, combat); return; }
        List<Card> attackers = new ArrayList<>();
        for (Card att : combat.getAttackers()) {
            GameEntity d = combat.getDefenderByAttacker(att);
            if (d == defender || (d instanceof Card dc && dc.getController() == defender)) attackers.add(att);
        }
        if (attackers.isEmpty()) return;
        List<Card> blockers = new ArrayList<>();
        List<Card> untapped = new ArrayList<>();
        JsonArray bj = new JsonArray();
        for (Card b : defender.getCreaturesInPlay()) {
            if (!b.isTapped() && !b.isPhasedOut()) untapped.add(b);
            if (!CombatUtil.canBlock(b, combat)) continue;
            JsonArray can = new JsonArray();
            for (Card att : attackers) if (CombatUtil.canBlock(att, b, combat)) can.add(att.getId());
            if (can.isEmpty()) continue;
            JsonObject cj = SeatView.card(b, player);
            cj.add("canBlock", can);
            bj.add(cj);
            blockers.add(b);
        }
        // Owner report 2026-11-17 (a Knights deck with Herald of Hoofbeats: every Knight has horsemanship): the
        // seat was never asked to block and never told why. The rules were right; the reason now travels.
        List<String> notes = blockNotes(attackers, untapped, combat);
        if (blockers.isEmpty()) {
            if (!notes.isEmpty()) {
                JsonObject n = notice("info", "You could not block");
                n.addProperty("text", String.join(" ", notes));
                JsonArray src = new JsonArray();
                src.add(SeatView.card(attackers.get(0), player));
                n.add("source", src);
                session.send(n);
            }
            return;
        }
        JsonArray aj = new JsonArray();
        for (Card att : attackers) {
            JsonObject j = SeatView.card(att, player);
            GameEntity d = combat.getDefenderByAttacker(att);
            if (d != null) j.add("attacking", SeatView.entityRef(d));
            aj.add(j);
        }
        JsonArray nj = new JsonArray();
        for (String note : notes) nj.add(note);
        // An illegal set of blocks (one blocker on a creature with menace) is asked again with the reason, like
        // every other illegal answer; it used to end the question with no blocks at all.
        for (int attempt = 0; attempt < MAX_BLOCK_ATTEMPTS; attempt++) {
            JsonObject p = prompt("blockers", "Declare blockers");
            p.add("attackers", aj);
            p.add("blockers", bj);
            if (!nj.isEmpty()) p.add("notes", nj);
            JsonObject a = session.ask(p);
            if (a == null) { super.declareBlockers(defender, combat); return; }
            if (!a.has("blocks") || !a.get("blocks").isJsonArray()) return;
            for (JsonElement e : a.getAsJsonArray("blocks")) {
                JsonObject blk = e.getAsJsonObject();
                Card b = byId(blockers, blk.get("blockerId").getAsInt());
                Card att = byId(attackers, blk.get("attackerId").getAsInt());
                if (b != null && att != null && CombatUtil.canBlock(att, b, combat)) combat.addBlocker(att, b);
            }
            String problem = CombatUtil.validateBlocks(combat, defender);
            if (problem == null) return;
            for (Card b : CardLists.filterControlledBy(combat.getAllBlockers(), defender)) combat.removeFromCombat(b);
            boolean last = attempt == MAX_BLOCK_ATTEMPTS - 1;
            session.sendError("blocks rejected: " + problem + (last ? " (no blocks declared)" : " Declare your blocks again."));
        }
    }

    private static final int MAX_BLOCK_ATTEMPTS = 3;

    /**
     * Why blocks are impossible, in plain words, for the blockers prompt and the "You could not block" notice:
     * attackers that none of the seat's untapped creatures may block (with the evasion keyword that stops
     * them), and untapped creatures that may not block at all. Empty when the seat has no untapped creature
     * (nothing to explain) or every attacker has a possible blocker.
     */
    static List<String> blockNotes(List<Card> attackers, List<Card> untapped, Combat combat) {
        List<String> notes = new ArrayList<>();
        if (untapped.isEmpty()) return notes;
        List<Card> able = new ArrayList<>();
        List<String> idle = new ArrayList<>();
        for (Card b : untapped) {
            if (CombatUtil.canBlock(b, combat)) able.add(b);
            else idle.add(b.getName());
        }
        if (!able.isEmpty()) {
            Map<String, List<String>> byReason = new LinkedHashMap<>();
            for (Card att : attackers) {
                boolean any = false;
                for (Card b : able) if (CombatUtil.canBlock(att, b, combat)) { any = true; break; }
                if (!any) byReason.computeIfAbsent(evasionOf(att, able), k -> new ArrayList<>()).add(att.getName());
            }
            for (Map.Entry<String, List<String>> e : byReason.entrySet()) {
                boolean one = e.getValue().size() == 1;
                String names = nameList(e.getValue());
                if (e.getKey().isEmpty()) notes.add("None of your untapped creatures can block " + names + ".");
                else notes.add(names + (one ? " has " : " have ") + e.getKey() + ", so none of your untapped creatures can block " + (one ? "it" : "them") + ".");
            }
        }
        if (!idle.isEmpty()) notes.add(nameList(idle) + " can't block right now (" + (idle.size() == 1 ? "its" : "their") + " own text or another card's effect says so).");
        return notes;
    }

    /** The evasion keywords of an attacker that none of these possible blockers answers, each with its rule in brackets. */
    private static String evasionOf(Card att, List<Card> able) {
        List<String> out = new ArrayList<>();
        if (att.hasKeyword(Keyword.FLYING) && able.stream().noneMatch(b -> b.hasKeyword(Keyword.FLYING) || b.hasKeyword(Keyword.REACH))) out.add("flying (only creatures with flying or reach can block it)");
        if (att.hasKeyword(Keyword.HORSEMANSHIP) && able.stream().noneMatch(b -> b.hasKeyword(Keyword.HORSEMANSHIP))) out.add("horsemanship (only creatures with horsemanship can block it)");
        if (att.hasKeyword(Keyword.SHADOW) && able.stream().noneMatch(b -> b.hasKeyword(Keyword.SHADOW))) out.add("shadow (only creatures with shadow can block it)");
        if (att.hasKeyword(Keyword.FEAR) && able.stream().noneMatch(b -> b.isArtifact() || b.isBlack())) out.add("fear (only artifact or black creatures can block it)");
        if (att.hasKeyword(Keyword.INTIMIDATE)) out.add("intimidate (only artifact creatures or creatures that share a colour with it can block it)");
        if (att.hasKeyword(Keyword.SKULK) && able.stream().noneMatch(b -> b.getNetPower() <= att.getNetPower())) out.add("skulk (creatures with greater power can't block it)");
        return String.join(" and ", out);
    }

    /** "A", "A and B", "A, B and C"; repeated names are counted ("Warrior Token (x3)"). */
    private static String nameList(List<String> names) {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String n : names) counts.merge(n, 1, Integer::sum);
        List<String> parts = new ArrayList<>();
        for (Map.Entry<String, Integer> e : counts.entrySet()) parts.add(e.getValue() > 1 ? e.getKey() + " (x" + e.getValue() + ")" : e.getKey());
        if (parts.size() == 1) return parts.get(0);
        return String.join(", ", parts.subList(0, parts.size() - 1)) + " and " + parts.get(parts.size() - 1);
    }

    /** Trample, several blockers: how the attacker's damage is split. */
    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers, CardCollectionView remaining, int damageDealt, GameEntity defender, boolean overrideOrder) {
        boolean trample = (attacker.hasKeyword(Keyword.TRAMPLE) && defender != null) || (attacker.hasKeyword("Trample:Planeswalker") && defender instanceof Card);
        boolean needsChoice = trample || blockers.size() > 1
                || (attacker.hasKeyword("You may assign CARDNAME's combat damage divided as you choose among defending player and/or any number of creatures they control.") && overrideOrder && !blockers.isEmpty());
        if (autopilot()) return super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
        if (!needsChoice || damageDealt <= 0) {
            Map<Card, Integer> simple = new HashMap<>();
            simple.put(blockers.isEmpty() ? null : blockers.get(0), damageDealt);
            return simple;
        }
        List<GameEntity> targets = new ArrayList<>();
        Map<GameEntity, Integer> lethal = new HashMap<>();
        for (Card b : blockers) {
            targets.add(b);
            lethal.put(b, Math.max(0, lethalDamage(b, attacker, damageDealt)));
        }
        if (trample) targets.add(defender);
        List<Integer> amounts = null;
        for (int attempt = 0; attempt < ATTEMPTS && amounts == null; attempt++) {
            amounts = assign("Assign " + attacker.getName() + "'s " + damageDealt + " damage", attacker.getName(), attacker, targets, damageDealt, lethal);
            if (amounts == null) return super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
            if (trample && amounts.get(targets.size() - 1) > 0) {
                // the defender may only take what is left after lethal damage to every blocker
                for (int i = 0; i < blockers.size(); i++) {
                    if (amounts.get(i) < lethal.getOrDefault(blockers.get(i), 0)) {
                        session.sendError("every blocker needs lethal damage before the rest tramples over");
                        amounts = null;
                        break;
                    }
                }
            }
        }
        if (amounts == null) return super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
        Map<Card, Integer> map = new HashMap<>();
        for (int i = 0; i < blockers.size(); i++) if (amounts.get(i) > 0) map.put(blockers.get(i), amounts.get(i));
        if (trample && amounts.get(targets.size() - 1) > 0) map.put(null, amounts.get(targets.size() - 1));
        if (map.isEmpty()) map.put(blockers.isEmpty() ? null : blockers.get(0), damageDealt);
        return map;
    }

    private static int lethalDamage(Card blocker, Card attacker, int maxDamage) {
        try {
            return ComputerUtilCombat.getEnoughDamageToKill(blocker, maxDamage, attacker, true, false);
        } catch (RuntimeException e) {
            return attacker.hasKeyword(Keyword.DEATHTOUCH) ? 1 : blocker.getLethalDamage();
        }
    }

    // ------------------------------------------------------------------ yes / no

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow, Map<String, Object> params) {
        Boolean r = autopilot() ? null : confirm(message, null, cardToShow != null ? cardToShow : (sa == null ? null : sa.getHostCard()), options, sourceOf(sa), mode == null ? null : mode.name());
        return r != null ? r : super.confirmAction(sa, mode, message, options, cardToShow, params);
    }

    @Override
    public boolean confirmStaticApplication(Card hostCard, PlayerActionConfirmMode mode, String message, String logic) {
        Boolean r = autopilot() ? null : confirm(message, null, hostCard, null, hostCard == null ? null : hostCard.getName(), mode == null ? null : mode.name());
        return r != null ? r : super.confirmStaticApplication(hostCard, mode, message, logic);
    }

    /** "You may ..." triggers: Forge asks when the trigger resolves. */
    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        if (wrapper.isMandatory()) return true;
        if (autopilot()) return super.confirmTrigger(wrapper);
        Card host = wrapper.getTrigger() == null ? wrapper.getHostCard() : wrapper.getTrigger().getHostCard();
        String name = host == null ? "this" : host.getName();
        String detail = wrapper.getTrigger() == null ? "" : wrapper.getTrigger().toString();
        Object triggeredBy = wrapper.getTriggeringObject(forge.game.ability.AbilityKey.Card);
        if (triggeredBy instanceof Card tc && (tc.getController() == player || game.getZoneOf(tc) == null || game.getZoneOf(tc).getZoneType().isKnown())) {
            detail = detail + (detail.isEmpty() ? "" : " ") + "(triggered by " + tc.getName() + ")";
        }
        Boolean r = confirm("Use " + name + "'s triggered ability?", detail, host, null, name, "TRIGGER");
        return r != null ? r : super.confirmTrigger(wrapper);
    }

    @Override
    public boolean confirmPayment(CostPart costPart, String question, SpellAbility sa) {
        String q = question == null ? "Pay?" : question.replace("{0}", costPart == null ? "" : costPart.toString());
        Boolean r = autopilot() ? null : confirm(q, null, sa == null ? null : sa.getHostCard(), null, sourceOf(sa), "PAYMENT");
        return r != null ? r : super.confirmPayment(costPart, question, sa);
    }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA, GameEntity affected, String question) {
        if (autopilot()) return super.confirmReplacementEffect(replacementEffect, effectSA, affected, question);
        Card host = replacementEffect == null ? null : replacementEffect.getHostCard();
        Boolean r = confirm(question, null, host, null, host == null ? null : host.getName(), "REPLACEMENT");
        return r != null ? r : super.confirmReplacementEffect(replacementEffect, effectSA, affected, question);
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Boolean defaultVal) {
        if (autopilot()) return super.chooseBinary(sa, question, kindOfChoice, defaultVal);
        List<String> labels = switch (kindOfChoice) {
            case HeadsOrTails -> List.of("Heads", "Tails");
            case TapOrUntap -> List.of("Tap", "Untap");
            case OddsOrEvens -> List.of("Odds", "Evens");
            case UntapOrLeaveTapped -> List.of("Untap", "Leave tapped");
            case PlayOrDraw -> List.of("Play", "Draw");
            case LeftOrRight -> List.of("Left", "Right");
            case AddOrRemove -> List.of("Add a counter", "Remove a counter");
            case IncreaseOrDecrease -> List.of("Increase", "Decrease");
            default -> List.of(kindOfChoice.toString().split("Or"));
        };
        Boolean r = confirm(question, null, sa == null ? null : sa.getHostCard(), labels, sourceOf(sa), kindOfChoice.name());
        return r != null ? r : super.chooseBinary(sa, question, kindOfChoice, defaultVal);
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Map<String, Object> params) {
        if (autopilot()) return super.chooseBinary(sa, question, kindOfChoice, params);
        return chooseBinary(sa, question, kindOfChoice, (Boolean) null);
    }

    /** "Unless its controller pays ..." / "you may pay 2 life": the question, then the payment. */
    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid, FCollectionView<Player> allPayers) {
        if (autopilot()) return super.payCostToPreventEffect(cost, sa, alreadyPaid, allPayers);
        String prompt = null;
        if (sa.isKeyword(Keyword.ECHO)) prompt = "Pay the echo cost";
        else if (sa.isKeyword(Keyword.CUMULATIVE_UPKEEP)) prompt = "Cumulative upkeep for " + sa.getHostCard();
        return payOptionalCost(cost, sa, prompt);
    }

    @Override
    public boolean payCombatCost(Card c, Cost cost, SpellAbility sa, String prompt) {
        if (autopilot()) return super.payCombatCost(c, cost, sa, prompt);
        return payOptionalCost(cost, sa, prompt);
    }

    @Override
    public boolean payCostDuringRoll(Cost cost, SpellAbility sa) {
        if (autopilot()) return super.payCostDuringRoll(cost, sa);
        return payOptionalCost(cost, sa, null);
    }

    private boolean payOptionalCost(Cost cost, SpellAbility sa, String prompt) {
        if (cost == null) return true;
        List<CostPart> parts = cost.getCostParts();
        boolean trivial = parts.isEmpty() || (parts.size() < 2 && "0".equals(parts.get(0).getAmount()));
        if (!trivial) {
            if (!probe(() -> ComputerUtilCost.canPayCost(cost, sa, player, true))) return false;
            String what = cost.toSimpleString();
            String pay = what.regionMatches(true, 0, "pay ", 0, 4) ? what : "Pay " + what; // "Pay 2 life" already says pay
            String title = (prompt == null || prompt.isBlank() ? pay : prompt + ": " + pay.substring(0, 1).toLowerCase(Locale.ROOT) + pay.substring(1)) + "?";
            String detail = describeUnless(sa);
            Boolean yes = confirm(title, detail, sa.getHostCard(), List.of("Pay", "Don't pay"), sourceOf(sa), "UNLESS");
            if (yes == null) return super.payCostToPreventEffect(cost, sa, false, null);
            if (!yes) return false;
        }
        // Forge's own resolve-time payment (life, mana, sacrifices ...), decided by BridgeCostDecision.
        return PlaySpellAbility.payCostDuringAbilityResolve(this, player, cost, sa, prompt);
    }

    private static String describeUnless(SpellAbility sa) {
        if (sa == null) return "";
        String desc = sa.getStackDescription();
        if (desc == null || desc.isBlank()) desc = sa.getDescription();
        if (desc == null || desc.isBlank()) return "";
        desc = desc.trim();
        return "If you don't: " + desc;
    }

    // ------------------------------------------------------------------ optional costs, X, numbers

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility chosen, List<OptionalCostValue> optionalCostValues) {
        if (autopilot() || optionalCostValues == null || optionalCostValues.isEmpty()) return super.chooseOptionalCosts(chosen, optionalCostValues);
        List<String> labels = new ArrayList<>();
        for (OptionalCostValue v : optionalCostValues) labels.add(v.toString());
        List<Integer> picks = chooseManyText("Optional costs for " + sourceOf(chosen), sourceOf(chosen), labels, 0, labels.size(), "optionalCosts");
        if (picks == null) return super.chooseOptionalCosts(chosen, optionalCostValues);
        List<OptionalCostValue> out = new ArrayList<>();
        for (int i : picks) out.add(optionalCostValues.get(i));
        return out;
    }

    @Override
    public int chooseNumberForKeywordCost(SpellAbility sa, Cost cost, KeywordInterface keyword, String prompt, int max) {
        if (autopilot() || max <= 0) return super.chooseNumberForKeywordCost(sa, cost, keyword, prompt, max);
        Integer n = number(prompt == null || prompt.isBlank() ? "How many times?" : prompt, sourceOf(sa), 0, max, null);
        return n == null ? super.chooseNumberForKeywordCost(sa, cost, keyword, prompt, max) : n;
    }

    /** X (and other announced values) when casting; the cap is what the seat can actually pay. */
    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        if (autopilot()) return super.announceRequirements(ability, min, max, announce);
        Card host = ability.getHostCard();
        Cost cost = ability.getPayCosts();
        if ("X".equals(announce) && cost != null) {
            Integer costX = probe(() -> cost.getMaxForNonManaX(ability, player, false));
            if (costX != null) max = Math.min(max, costX);
            if (cost.getCostMana() != null && cost.getCostMana().getAmountOfX() > 0) {
                int affordable = probe(() -> ComputerUtilMana.determineLeftoverMana(ability, player, false));
                max = Math.min(max, affordable);
            }
        }
        if (min > max) return null;
        String title = "X".equals(announce) ? ability.getParamOrDefault("XAnnounceTitle", "X") : ability.getParamOrDefault("AnnounceTitle", announce);
        if ("NumTimes".equals(announce)) title = "How many times to pay " + (ability.getPayCosts() == null ? "" : ability.getPayCosts().getTotalMana()) + " for " + host.getName() + "?";
        else title = "Choose " + title + " for " + host.getName();
        Integer n = number(title, host.getName(), min, max, null);
        return n == null ? Integer.valueOf(min) : n;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        if (autopilot() || min >= max) return min >= max ? min : super.chooseNumber(sa, title, min, max);
        Integer n = number(title, sourceOf(sa), min, max, null);
        return n == null ? super.chooseNumber(sa, title, min, max) : n;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String string, int min, int max, Map<String, Object> params) {
        if (autopilot() || min >= max) return min >= max ? min : super.chooseNumber(sa, string, min, max, params);
        Integer n = number(string, sourceOf(sa), min, max, null);
        return n == null ? super.chooseNumber(sa, string, min, max, params) : n;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> options, Player relatedPlayer) {
        if (autopilot() || options == null || options.size() <= 1) return super.chooseNumber(sa, title, options, relatedPlayer);
        Integer n = number(title, sourceOf(sa), Collections.min(options), Collections.max(options), options);
        return n == null || !options.contains(n) ? super.chooseNumber(sa, title, options, relatedPlayer) : n;
    }

    // ------------------------------------------------------------------ modes

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        if (!allowRepeat && min == num && num == possible.size()) return possible;
        if (autopilot()) return super.chooseModeForAbility(sa, possible, min, num, allowRepeat);
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("mode", "Choose " + (min == num ? String.valueOf(num) : min + " to " + num) + (num == 1 ? " mode" : " modes") + " for " + sourceOf(sa));
            p.addProperty("source", sourceOf(sa));
            p.addProperty("min", min);
            p.addProperty("max", num);
            p.addProperty("allowRepeat", allowRepeat);
            JsonArray modes = new JsonArray();
            for (int i = 0; i < possible.size(); i++) {
                JsonObject m = new JsonObject();
                m.addProperty("index", i);
                m.addProperty("text", possible.get(i).toUnsuppressedString());
                modes.add(m);
            }
            p.add("modes", modes);
            JsonObject a = session.ask(p);
            if (a == null) break;
            List<Integer> picks = indices(a, "modes");
            List<AbilitySub> out = new ArrayList<>();
            for (int i : picks) {
                if (i < 0 || i >= possible.size()) continue;
                if (!allowRepeat && out.contains(possible.get(i))) continue;
                out.add(possible.get(i));
            }
            if (out.size() >= min && out.size() <= num) return out;
            session.sendError("choose " + (min == num ? String.valueOf(num) : min + " to " + num) + (num == 1 ? " mode" : " modes"));
        }
        return super.chooseModeForAbility(sa, possible, min, num, allowRepeat);
    }

    // ------------------------------------------------------------------ ordering

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        if (autopilot() || topN.isEmpty()) return super.arrangeForScry(topN);
        Ordered o = order("Scry " + topN.size(), null, new ArrayList<GameObject>(topN), List.of("top", "bottom"), "top", "Order the cards that stay on top (first = top).");
        if (o == null) return super.arrangeForScry(topN);
        CardCollection toTop = new CardCollection();
        CardCollection toBottom = new CardCollection();
        for (int i : o.order) if ("bottom".equals(o.bucket.get(i))) toBottom.add(topN.get(i)); else toTop.add(topN.get(i));
        return ImmutablePair.of(toTop, toBottom);
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        if (autopilot() || topN.isEmpty()) return super.arrangeForSurveil(topN);
        Ordered o = order("Surveil " + topN.size(), null, new ArrayList<GameObject>(topN), List.of("top", "graveyard"), "top", "Order the cards that stay on top (first = top).");
        if (o == null) return super.arrangeForSurveil(topN);
        CardCollection toTop = new CardCollection();
        CardCollection toGrave = new CardCollection();
        for (int i : o.order) if ("graveyard".equals(o.bucket.get(i))) toGrave.add(topN.get(i)); else toTop.add(topN.get(i));
        return ImmutablePair.of(toTop, toGrave);
    }

    @Override
    public boolean willPutCardOnTop(Card c) {
        Boolean r = autopilot() ? null : confirm("Put " + c.getName() + " on top or on the bottom of your library?", null, c, List.of("Top", "Bottom"), c.getName(), "TOP_OR_BOTTOM");
        return r != null ? r : super.willPutCardOnTop(c);
    }

    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone, SpellAbility source) {
        if (autopilot() || cards.size() < 2) return super.orderMoveToZoneList(cards, destinationZone, source);
        boolean toTopOfLibrary = false;
        String title;
        String note;
        switch (destinationZone) {
            case Library -> {
                toTopOfLibrary = source == null || !"-1".equals(source.getParam("LibraryPosition"));
                title = "Order the cards going into your library";
                note = toTopOfLibrary ? "First = closest to the top." : "First = closest to the bottom.";
            }
            case Graveyard -> {
                if (source == null || source.getApi() != forge.game.ability.ApiType.ReorderZone) {
                    if (!game.isGraveyardOrdered(player)) return cards; // nothing in the game cares about graveyard order
                }
                title = "Order the cards going into the graveyard";
                note = "First = closest to the bottom.";
            }
            case Battlefield -> { title = "Order the permanents entering the battlefield"; note = "First enters first."; }
            case Exile -> { title = "Order the cards going into exile"; note = "First goes first."; }
            case Stack -> { title = "Order the copies"; note = "First is put on the stack first (resolves last)."; }
            case None -> { title = "Order the cards"; note = "First goes first."; }
            default -> { return super.orderMoveToZoneList(cards, destinationZone, source); }
        }
        Ordered o = order(title, sourceOf(source), new ArrayList<GameObject>(cards), null, null, note);
        if (o == null) return super.orderMoveToZoneList(cards, destinationZone, source);
        List<Card> list = new ArrayList<>();
        for (int i : o.order) list.add(cards.get(i));
        if (toTopOfLibrary) Collections.reverse(list); // Forge wants the top-most card LAST
        return new CardCollection(list);
    }

    /** Several of this seat's triggers at once: which resolves first. */
    @Override
    public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (autopilot() || activePlayerSAs.size() < 2) return super.orderSimultaneousSa(activePlayerSAs);
        List<String> labels = new ArrayList<>();
        for (SpellAbility sa : activePlayerSAs) labels.add(describeSa(sa));
        Ordered o = orderText("Order your triggered abilities", null, labels, "First = resolves first.");
        if (o == null) return super.orderSimultaneousSa(activePlayerSAs);
        List<SpellAbility> out = new ArrayList<>();
        for (int i : o.order) out.add(activePlayerSAs.get(i));
        Collections.reverse(out); // Forge puts the first of this list on the stack first, so it resolves last
        return out;
    }

    /**
     * This seat's triggered abilities going on the stack. The inherited AI version let Forge's AI pick their
     * targets and modes (brains.doTrigger): Displacer Kitten's "exile up to one target nonland permanent you
     * control" was chosen for the human. Triggers now go through Forge's human play flow (the one Forge's own
     * human controller uses), so targets, modes, X and costs are asked through this controller; copies of
     * spells and anything else keep Forge's AI handling. Same direction as the AI loop: the first of the
     * ordered list goes on the stack first (orderSimultaneousSa already accounts for that).
     */
    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (autopilot()) { super.orderAndPlaySimultaneousSa(activePlayerSAs); return; }
        for (SpellAbility sa : orderSimultaneousSa(activePlayerSAs)) {
            if (sa.isTrigger() && !sa.isCopied()) {
                PlaySpellAbility.playSpellAbility(this, player, sa);
            } else {
                // as PlayerControllerHuman: a copy goes on the stack and, when it may, its controller chooses new targets
                if (sa.isCopied()) {
                    if (sa.isSpell()) {
                        if (!sa.getHostCard().isInZone(ZoneType.Stack)) sa.setHostCard(game.getAction().moveToStack(sa.getHostCard(), sa));
                        else game.getStackZone().add(sa.getHostCard());
                    }
                    if (sa.isMayChooseNewTargets()) sa.setupNewTargets(player);
                }
                game.getStack().add(sa);
            }
        }
    }

    /** Opening-hand actions the seat picked and Forge has not played yet (Forge skips any whose card left the hand). */
    private final java.util.Set<SpellAbility> openingHandPicks = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());

    /** "Leyline of the Void: begin the game with it on the battlefield" style labels for opening-hand actions. */
    private static String openingHandLabel(SpellAbility sa) {
        Card host = sa.getHostCard();
        String name = host == null ? "" : host.getName();
        String d = sa.getDescription();
        if (d == null || d.isBlank()) d = sa.toUnsuppressedString();
        d = d.replace("CARDNAME", name).replace("NICKNAME", name).trim();
        return name.isEmpty() ? d : name + ": " + d;
    }

    private static String describeSa(SpellAbility sa) {
        String host = sa.getHostCard() == null ? "" : sa.getHostCard().getName() + ": ";
        String d = sa.isWrapper() ? ((WrappedAbility) sa).getWrappedAbility().toUnsuppressedString() : sa.toUnsuppressedString();
        return host + (d == null ? sa.toString() : d);
    }

    // ------------------------------------------------------------------ named things: colours, types, names

    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        if (autopilot() || colors.countColors() < 2) return super.chooseColor(message, sa, colors);
        List<String> names = colorNames(colors, false);
        Integer i = chooseText(message == null || message.isBlank() ? "Choose a color" : message, sourceOf(sa), names, false);
        return i == null ? super.chooseColor(message, sa, colors) : MagicColor.fromName(names.get(i));
    }

    @Override
    public byte chooseColorAllowColorless(String message, Card card, ColorSet colors) {
        if (autopilot()) return super.chooseColorAllowColorless(message, card, colors);
        List<String> names = colorNames(colors, true);
        if (names.size() < 2) return super.chooseColorAllowColorless(message, card, colors);
        Integer i = chooseText(message == null || message.isBlank() ? "Choose a color" : message, card == null ? null : card.getName(), names, false);
        return i == null ? super.chooseColorAllowColorless(message, card, colors) : MagicColor.fromName(names.get(i));
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        if (autopilot()) return super.chooseColors(message, sa, min, max, options);
        List<String> names = colorNames(options, false);
        List<Integer> picks = chooseManyText(message == null || message.isBlank() ? "Choose colors" : message, sourceOf(sa), names, min, Math.min(max, names.size()), "colors");
        if (picks == null) return super.chooseColors(message, sa, min, max, options);
        List<String> chosen = new ArrayList<>();
        for (int i : picks) chosen.add(names.get(i));
        return ColorSet.fromNames(chosen);
    }

    private static List<String> colorNames(ColorSet set, boolean allowColorless) {
        List<String> out = new ArrayList<>();
        for (MagicColor.Color c : MagicColor.Color.values()) {
            if (c == MagicColor.Color.COLORLESS) { if (allowColorless) out.add("colorless"); continue; }
            if (set.hasAnyColor(c.getColorMask())) out.add(c.getName().toLowerCase(Locale.ROOT));
        }
        return out;
    }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        if (autopilot() || validTypes == null || validTypes.isEmpty()) return super.chooseSomeType(kindOfType, sa, validTypes, isOptional);
        List<String> list = new ArrayList<>(validTypes);
        Integer i = chooseText("Choose a " + (kindOfType == null ? "" : kindOfType.toLowerCase(Locale.ROOT) + " ") + "type", sourceOf(sa), list, isOptional);
        if (i == null) return super.chooseSomeType(kindOfType, sa, validTypes, isOptional);
        return i < 0 ? null : list.get(i);
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        if (autopilot() || options == null || options.size() <= 1) return super.chooseCounterType(options, sa, prompt, params);
        List<String> names = new ArrayList<>();
        for (CounterType t : options) names.add(t.getName());
        Integer i = chooseText(prompt == null || prompt.isBlank() ? "Choose a counter type" : prompt, sourceOf(sa), names, false);
        return i == null ? super.chooseCounterType(options, sa, prompt, params) : options.get(i);
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        if (autopilot() || options == null || options.size() <= 1) return super.chooseKeywordForPump(options, sa, prompt, tgtCard);
        Integer i = chooseText(prompt == null || prompt.isBlank() ? "Choose a keyword" : prompt, sourceOf(sa), options, false);
        return i == null ? super.chooseKeywordForPump(options, sa, prompt, tgtCard) : options.get(i);
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        if (autopilot() || choices == null || choices.size() <= 1) return super.chooseProtectionType(sa, choices);
        Integer i = chooseText("Choose what to protect from", sourceOf(sa), choices, false);
        return i == null ? super.chooseProtectionType(sa, choices) : choices.get(i);
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        if (autopilot() || faces == null || faces.isEmpty()) return super.chooseCardName(sa, faces, message);
        List<String> names = new ArrayList<>();
        for (ICardFace f : faces) names.add(f.getName());
        Integer i = chooseText(message == null || message.isBlank() ? "Name a card" : message, sourceOf(sa), names, false);
        return i == null ? super.chooseCardName(sa, faces, message) : names.get(i);
    }

    /** Free-text card name (Pithing Needle, Cavern of Souls ...), validated against Forge's card database. */
    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        if (autopilot()) return super.chooseCardName(sa, cpp, valid, message);
        String title = message == null || message.isBlank() ? "Name a card" : message;
        for (int attempt = 0; attempt < 3; attempt++) {
            JsonObject p = prompt("text", title);
            p.addProperty("source", sourceOf(sa));
            p.addProperty("freeText", true);
            p.addProperty("hint", valid == null || valid.isBlank() ? "Any card name" : valid);
            JsonObject a = session.ask(p);
            if (a == null) return super.chooseCardName(sa, cpp, valid, message);
            String text = a.has("text") && !a.get("text").isJsonNull() ? a.get("text").getAsString().trim() : "";
            ICardFace face = text.isEmpty() ? null : StaticData.instance().getCommonCards().getFaceByName(text);
            if (face != null && (cpp == null || cpp.test(face))) return face.getName();
            session.sendError(text.isEmpty() ? "name a card" : "\"" + text + "\" is not a card name that fits here");
        }
        return super.chooseCardName(sa, cpp, valid, message);
    }

    @Override
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa, String title, Map<String, Object> params) {
        if (autopilot() || spells == null || spells.size() <= 1) return super.chooseSingleSpellForEffect(spells, sa, title, params);
        List<String> labels = new ArrayList<>();
        for (SpellAbility s : spells) labels.add(describeSa(s));
        Integer i = chooseText(title == null || title.isBlank() ? "Choose one" : title, sourceOf(sa), labels, false);
        return i == null ? super.chooseSingleSpellForEffect(spells, sa, title, params) : spells.get(i);
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa, String title, int num, Map<String, Object> params) {
        if (autopilot() || spells == null || spells.isEmpty()) return super.chooseSpellAbilitiesForEffect(spells, sa, title, num, params);
        List<String> labels = new ArrayList<>();
        for (SpellAbility s : spells) labels.add(describeSa(s));
        List<Integer> picks = chooseManyText(title == null || title.isBlank() ? "Choose" : title, sourceOf(sa), labels, 0, Math.min(num, labels.size()), "abilities");
        if (picks == null) return super.chooseSpellAbilitiesForEffect(spells, sa, title, num, params);
        List<SpellAbility> out = new ArrayList<>();
        for (int i : picks) out.add(spells.get(i));
        return out;
    }

    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possibleReplacers) {
        if (autopilot() || possibleReplacers == null || possibleReplacers.size() <= 1) return super.chooseSingleReplacementEffect(possibleReplacers);
        List<String> labels = new ArrayList<>();
        for (ReplacementEffect re : possibleReplacers) labels.add((re.getHostCard() == null ? "" : re.getHostCard().getName() + ": ") + re.toString());
        Integer i = chooseText("Which replacement effect applies first?", null, labels, false);
        return i == null ? super.chooseSingleReplacementEffect(possibleReplacers) : possibleReplacers.get(i);
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        Player fixed = session.startingPlayer();
        if (fixed != null) return fixed; // decided at the table (D20 roll / random pick): no question, no re-flip
        if (autopilot()) return super.chooseStartingPlayer(isFirstGame);
        List<Player> players = new ArrayList<>(game.getPlayersInTurnOrder());
        Integer i = chooseIndex("Who plays first?", null, new ArrayList<GameObject>(players), false);
        return i == null || i < 0 ? super.chooseStartingPlayer(isFirstGame) : players.get(i);
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2, String faceUp) {
        if (autopilot()) return super.chooseCardsPile(sa, pile1, pile2, faceUp);
        List<String> labels = List.of("Pile 1: " + names(pile1), "Pile 2: " + names(pile2));
        Integer i = chooseText("Choose a pile", sourceOf(sa), labels, false);
        return i == null ? super.chooseCardsPile(sa, pile1, pile2, faceUp) : i == 0;
    }

    private static String names(CardCollectionView cards) {
        List<String> n = new ArrayList<>();
        for (Card c : cards) n.add(c.getName());
        return n.isEmpty() ? "(empty)" : String.join(", ", n);
    }

    // ------------------------------------------------------------------ generic card choices

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal,
            SpellAbility sa, String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot()) return super.chooseSingleEntityForEffect(optionList, null, sa, title, isOptional, targetedPlayer, params);
        List<T> opts = new ArrayList<>();
        for (T t : optionList) opts.add(t);
        if (opts.isEmpty()) return null;
        // Forge's Player.assignCompanion moves whatever comes back to the command zone without a null check,
        // so the companion question is never optional here (a revealed companion that is never used is harmless).
        boolean companion = sa != null && sa.getApi() == ApiType.CompanionChoose;
        Integer i = chooseIndex(companion ? "Reveal your companion (it starts outside the game; {3}: put it into your hand)" : title, sourceOf(sa), new ArrayList<GameObject>(opts), isOptional && !companion);
        if (i == null) return super.chooseSingleEntityForEffect(optionList, null, sa, title, isOptional, targetedPlayer, params);
        T picked = i < 0 ? (isOptional && !companion ? null : opts.get(0)) : opts.get(i);
        if (companion && picked instanceof Card c) game.getGameLog().add(GameLogEntryType.INFORMATION, player.getName() + " reveals " + c.getName() + " as their companion.");
        return picked;
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max, DelayedReveal delayedReveal,
            SpellAbility sa, String title, Player targetedPlayer, Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot()) return super.chooseEntitiesForEffect(optionList, min, max, null, sa, title, targetedPlayer, params);
        List<T> opts = new ArrayList<>();
        for (T t : optionList) opts.add(t);
        List<Integer> picks = chooseManyIndex(title, sourceOf(sa), new ArrayList<GameObject>(opts), min, max, null);
        if (picks == null) return super.chooseEntitiesForEffect(optionList, min, max, null, sa, title, targetedPlayer, params);
        List<T> out = new ArrayList<>();
        for (int i : picks) out.add(opts.get(i));
        return out;
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min, int max, boolean isOptional, Map<String, Object> params) {
        if (autopilot()) return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
        List<Card> chosen = chooseCards(title, sourceOf(sa), new ArrayList<>(sourceList), isOptional ? 0 : min, max, null);
        return chosen == null ? super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params) : new CardCollection(chosen);
    }

    /** Tutors and "search your library": the seat sees the fetch list, which may be its own library. */
    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, DelayedReveal delayedReveal,
            String selectPrompt, boolean isOptional, Player decider) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot()) return super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, null, selectPrompt, isOptional, decider);
        if (fetchList == null || fetchList.isEmpty()) return null;
        Integer i = chooseIndex(selectPrompt == null || selectPrompt.isBlank() ? "Choose a card" : selectPrompt, sourceOf(sa), new ArrayList<GameObject>(fetchList), isOptional);
        if (i == null) return super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, null, selectPrompt, isOptional, decider);
        return i < 0 ? null : fetchList.get(i);
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, int min, int max,
            DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot() || fetchList == null) return super.chooseCardsForZoneChange(destination, origin, sa, fetchList, min, max, null, selectPrompt, decider);
        List<Card> chosen = chooseCards(selectPrompt == null || selectPrompt.isBlank() ? "Choose cards" : selectPrompt, sourceOf(sa), new ArrayList<>(fetchList), min, max, null);
        return chosen == null ? super.chooseCardsForZoneChange(destination, origin, sa, fetchList, min, max, null, selectPrompt, decider) : chosen;
    }

    @Override
    public CardCollection chooseCardsToDiscardFrom(Player p, SpellAbility sa, CardCollection validCards, int min, int max, CardCollectionView visibleToChooser) {
        if (autopilot() || validCards == null || validCards.isEmpty()) return super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
        if (p != player) {
            // choosing from someone else's hand: only when those cards are shown to us
            for (Card c : validCards) if (visibleToChooser == null || !visibleToChooser.contains(c)) return super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
        }
        String who = p == player ? "Discard" : "Choose " + p.getName() + "'s cards to discard";
        List<Card> chosen = chooseCards(who + (min == max ? " " + min : " " + min + " to " + max), sourceOf(sa), new ArrayList<>(validCards), min, max, "discard");
        return chosen == null ? super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser) : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        if (autopilot() || numDiscard <= 0) return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
        List<Card> hand = new ArrayList<>(player.getCardsIn(ZoneType.Hand));
        List<Card> chosen = chooseCards("Discard down to your hand size: choose " + numDiscard, null, hand, numDiscard, numDiscard, "discard");
        return chosen == null ? super.chooseCardsToDiscardToMaximumHandSize(numDiscard) : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int num, CardCollectionView hand, String[] uTypes, SpellAbility sa) {
        if (autopilot()) return super.chooseCardsToDiscardUnlessType(num, hand, uTypes, sa);
        String types = String.join(" or ", uTypes);
        List<Card> all = new ArrayList<>(hand);
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            List<Card> chosen = chooseCards("Discard a " + types + " card, or " + num + " other cards", sourceOf(sa), all, 1, Math.max(1, num), "discard");
            if (chosen == null) break;
            if (chosen.size() == 1 && CardLists.getValidCards(new CardCollection(chosen), uTypes, player, sa.getHostCard(), sa).size() == 1) return new CardCollection(chosen);
            if (chosen.size() == Math.min(num, all.size())) return new CardCollection(chosen);
            session.sendError("choose one " + types + " card or " + num + " cards");
        }
        return super.chooseCardsToDiscardUnlessType(num, hand, uTypes, sa);
    }

    @Override
    public CardCollectionView chooseCardsToRevealFromHand(int min, int max, CardCollectionView valid) {
        if (autopilot() || valid == null || valid.isEmpty()) return super.chooseCardsToRevealFromHand(min, max, valid);
        List<Card> chosen = chooseCards("Reveal " + (min == max ? String.valueOf(min) : min + " to " + max) + " from your hand", null, new ArrayList<>(valid), min, Math.min(max, valid.size()), "reveal");
        return chosen == null ? super.chooseCardsToRevealFromHand(min, max, valid) : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        if (autopilot() || validTargets == null) return super.choosePermanentsToSacrifice(sa, min, max, validTargets, message);
        List<Card> chosen = chooseCards(message == null || message.isBlank() ? "Sacrifice" : message, sourceOf(sa), new ArrayList<>(validTargets), min, Math.min(max, validTargets.size()), "sacrifice");
        return chosen == null ? super.choosePermanentsToSacrifice(sa, min, max, validTargets, message) : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        if (autopilot() || validTargets == null) return super.choosePermanentsToDestroy(sa, min, max, validTargets, message);
        List<Card> chosen = chooseCards(message == null || message.isBlank() ? "Destroy" : message, sourceOf(sa), new ArrayList<>(validTargets), min, Math.min(max, validTargets.size()), "destroy");
        return chosen == null ? super.choosePermanentsToDestroy(sa, min, max, validTargets, message) : new CardCollection(chosen);
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        if (autopilot() || grave == null || grave.isEmpty() || genericAmount <= 0) return super.chooseCardsToDelve(genericAmount, grave);
        List<Card> chosen = chooseCards("Delve: exile cards from your graveyard to pay generic mana", null, new ArrayList<>(grave), 0, Math.min(genericAmount, grave.size()), "delve");
        return chosen == null ? super.chooseCardsToDelve(genericAmount, grave) : new CardCollection(chosen);
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        if (autopilot() || attackers == null || attackers.isEmpty()) return super.exertAttackers(attackers);
        List<Card> chosen = chooseCards("Exert attackers?", null, attackers, 0, attackers.size(), "exert");
        return chosen == null ? super.exertAttackers(attackers) : chosen;
    }

    @Override
    public List<Card> enlistAttackers(List<Card> attackers) {
        if (autopilot() || attackers == null || attackers.isEmpty()) return super.enlistAttackers(attackers);
        List<Card> chosen = chooseCards("Enlist?", null, attackers, 0, attackers.size(), "enlist");
        return chosen == null ? super.enlistAttackers(attackers) : chosen;
    }

    @Override
    public List<SpellAbility> chooseSaToActivateFromOpeningHand(List<SpellAbility> usableFromOpeningHand) {
        if (autopilot() || usableFromOpeningHand == null || usableFromOpeningHand.isEmpty()) return super.chooseSaToActivateFromOpeningHand(usableFromOpeningHand);
        List<String> labels = new ArrayList<>();
        for (SpellAbility s : usableFromOpeningHand) labels.add(openingHandLabel(s));
        // Rule 103.6: each player in turn order may take these actions; the order picked is the order they happen.
        List<Integer> picks = chooseManyText("From your opening hand: use which of these before the game begins?", null, labels, 0, labels.size(), "openingHand");
        if (picks == null) return super.chooseSaToActivateFromOpeningHand(usableFromOpeningHand);
        List<SpellAbility> out = new ArrayList<>();
        for (int i : picks) out.add(usableFromOpeningHand.get(i));
        openingHandPicks.addAll(out); // logged when Forge actually plays each one (an earlier pick may exile a later card)
        return out;
    }

    // ------------------------------------------------------------------ mulligan

    @Override
    public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
        OpeningHand rule = session.openingHand();
        if (rule.drawTen()) { // no mulligans: everyone puts three of their ten back instead (once, all seats at the same time)
            rule.ensurePutBack();
            return true;
        }
        if (rule.ownsFreeMulligans()) cardsToReturn = rule.bottomSoFar(player);
        if (autopilot()) return super.mulliganKeepHand(firstPlayer, cardsToReturn);
        JsonObject a;
        while (true) {
            JsonObject p = prompt("mulligan", "Keep this hand?");
            p.addProperty("cardsToReturn", cardsToReturn);
            p.addProperty("mulligans", player.getStats().getMulliganCount());
            if (rule.ownsFreeMulligans()) {
                p.addProperty("freeMulligans", rule.freeMulligans);
                p.addProperty("nextBottom", rule.bottomNow(player));
            }
            List<Card> hand = new ArrayList<>(player.getCardsIn(ZoneType.Hand));
            p.add("hand", objectsJson(hand));
            // Serum Powder: "Any time you could mulligan and Serum Powder is in your hand, you may exile all the cards
            // from your hand, then draw that many cards." Forge implements it only in its desktop UI, so the bridge does.
            JsonArray powders = new JsonArray();
            for (Card c : hand) if ("Serum Powder".equals(c.getName())) powders.add(c.getId());
            if (powders.size() > 0) p.add("serumPowder", powders);
            a = session.ask(p);
            if (a == null) return super.mulliganKeepHand(firstPlayer, cardsToReturn);
            if (!a.has("serumPowder") || a.get("serumPowder").isJsonNull()) break;
            Card powder = byId(hand, a.get("serumPowder").getAsInt());
            if (powder == null || !"Serum Powder".equals(powder.getName())) {
                session.sendError("that is not a Serum Powder in your hand");
                continue;
            }
            useSerumPowder();
        }
        return !a.has("keep") || a.get("keep").isJsonNull() || a.get("keep").getAsBoolean();
    }

    /** Draw 10: which three of the ten go back into the library (null = nobody answered; the AI picks). */
    List<Card> choosePutBack(int n) {
        List<Card> hand = new ArrayList<>(player.getCardsIn(ZoneType.Hand));
        return chooseCards("Put " + n + " cards back into your library (it is shuffled). You keep the other " + (hand.size() - n) + ".", null, hand, n, n, "putBack");
    }

    /** Exile the whole hand, draw that many (the mulligan question is then asked again on the new hand). */
    void useSerumPowder() {
        List<Card> hand = new ArrayList<>(player.getCardsIn(ZoneType.Hand));
        int n = hand.size();
        for (Card c : hand) game.getAction().exile(c, null, null);
        player.drawCards(n);
        game.getGameLog().add(GameLogEntryType.MULLIGAN, player.getName() + " used Serum Powder: exiled their hand and drew " + n + " cards.");
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        OpeningHand rule = session.openingHand();
        if (rule.ownsFreeMulligans()) cardsToReturn = Math.min(rule.bottomNow(player), hand.size()); // the table's free mulligans, not Forge's flag
        if (cardsToReturn <= 0) return new CardCollection();
        if (autopilot()) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        List<Card> cards = new ArrayList<>();
        for (Card c : hand) cards.add(c);
        List<Card> chosen = chooseCards("Put " + cardsToReturn + " card(s) on the bottom of your library", null, cards, cardsToReturn, cardsToReturn, "mulligan");
        return chosen == null ? super.tuckCardsViaMulligan(hand, cardsToReturn) : new CardCollection(chosen);
    }

    // ------------------------------------------------------------------ decisions found by the 2026-10-18 audit
    // Each of these used to be inherited from PlayerControllerAi, so Forge's AI decided them for the human seat.
    // The reference for every question is Forge's own desktop PlayerControllerHuman (see docs/FORGE-ENGINE.md,
    // "Inherited decisions"); BridgeCoverageTest fails if a PlayerController method is neither overridden here nor
    // in its allow-list.

    /** Casting from an effect (cascade into a split or adventure card, "you may cast", discover) or picking one of several additional costs. */
    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        if (autopilot() || abilities == null || abilities.size() <= 1) return super.getAbilityToPlay(hostCard, abilities, triggerEvent);
        List<String> labels = new ArrayList<>();
        for (SpellAbility s : abilities) labels.add(describeSa(s));
        Integer i = chooseText("How do you want to cast " + hostCard.getName() + "?", hostCard.getName(), labels, false);
        return i == null || i < 0 ? super.getAbilityToPlay(hostCard, abilities, triggerEvent) : abilities.get(i);
    }

    /**
     * New targets: a copy that "may choose new targets" (Twincast, storm, Reverberate) and "change the target(s)"
     * effects (Redirect, Deflecting Swat, Bolt Bend). As PlayerControllerHuman: the same number of targets as
     * before, through the targets prompt; Cancel keeps the current targets.
     */
    @Override
    public TargetChoices chooseNewTargetsFor(SpellAbility ability, Predicate<GameObject> filter, boolean optional) {
        if (autopilot()) return super.chooseNewTargetsFor(ability, filter, optional);
        SpellAbility sa = ability.isWrapper() ? ((WrappedAbility) ability).getWrappedAbility() : ability;
        if (!sa.usesTargeting()) return null;
        TargetChoices old = sa.getTargets();
        int count = Math.max(1, old.size());
        List<GameObject> oldTargets = new ArrayList<>();
        for (GameObject o : old) oldTargets.add(o);
        List<Integer> divided = new ArrayList<>();
        if (sa.isDividedAsYouChoose()) for (GameObject o : oldTargets) { Integer v = old.getDividedValue(o); divided.add(v == null ? 0 : v); }
        sa.clearTargets();
        List<GameObject> candidates = targetCandidates(sa);
        if (filter != null) candidates.removeIf(o -> !filter.test(o));
        if (candidates.size() < count) { sa.setTargets(old); return null; }
        List<String> current = new ArrayList<>();
        for (GameObject o : oldTargets) current.add(o instanceof Card c ? c.getName() : o.toString());
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("targets", "Choose new targets for " + sa.getHostCard().getName() + (current.isEmpty() ? "" : " (now: " + String.join(", ", current) + ")"));
            p.addProperty("ability", sa.toString());
            p.addProperty("source", sourceOf(sa));
            p.addProperty("min", count);
            p.addProperty("max", count);
            p.addProperty("cancelLabel", "Keep current targets");
            p.add("options", objectsJson(candidates));
            JsonObject a = session.ask(p);
            if (a == null) { sa.setTargets(old); return super.chooseNewTargetsFor(ability, filter, optional); }
            if (isTrue(a, "cancel")) { sa.setTargets(old); return null; }
            sa.resetTargets();
            for (int idx : indices(a, "options")) if (idx >= 0 && idx < candidates.size()) sa.getTargets().add(candidates.get(idx));
            if (sa.getTargets().size() == count && sa.isTargetNumberValid()) {
                if (sa.isDividedAsYouChoose()) {
                    // the division does not change: each new target takes the amount of the one it replaces, in order
                    int i = 0;
                    for (GameObject o : sa.getTargets()) {
                        if (o instanceof GameEntity e) sa.addDividedAllocation(e, i < divided.size() ? divided.get(i) : 0);
                        i++;
                    }
                }
                return sa.getTargets();
            }
            session.sendError("choose " + count + (count == 1 ? " target" : " targets"));
        }
        sa.setTargets(old);
        return null;
    }

    /** Spellskite-style "change a target of target spell to this": which target, when the spell has several. */
    @Override
    public Pair<SpellAbilityStackInstance, GameObject> chooseTarget(SpellAbility sa, List<Pair<SpellAbilityStackInstance, GameObject>> allTargets) {
        if (autopilot() || allTargets == null || allTargets.size() < 2) return super.chooseTarget(sa, allTargets);
        List<String> labels = new ArrayList<>();
        for (Pair<SpellAbilityStackInstance, GameObject> t : allTargets) {
            GameObject o = t.getRight();
            labels.add((o instanceof Card c ? c.getName() : String.valueOf(o)) + " - " + t.getLeft().getSourceCard().getName());
        }
        Integer i = chooseText("Which target do you change?", sourceOf(sa), labels, false);
        return i == null || i < 0 ? super.chooseTarget(sa, allTargets) : allTargets.get(i);
    }

    /** Council's dilemma / will of the council (Expropriate, Council's Judgment, Tivit): this seat's vote. */
    @Override
    public Object vote(SpellAbility sa, String prompt, List<Object> options, ListMultimap<Object, Player> votes, Player forPlayer, boolean optional) {
        if (autopilot() || options == null || options.isEmpty()) return super.vote(sa, prompt, options, votes, forPlayer, optional);
        StringBuilder title = new StringBuilder(forPlayer != null && forPlayer != player ? "Vote for " + forPlayer.getName() : "Your vote");
        if (votes != null && !votes.isEmpty()) {
            List<String> tally = new ArrayList<>();
            for (Object k : votes.keySet()) tally.add(voteLabel(k) + " " + votes.get(k).size());
            title.append(" (so far: ").append(String.join(", ", tally)).append(")");
        }
        boolean entities = true;
        for (Object o : options) if (!(o instanceof GameEntity)) entities = false;
        Integer i;
        if (entities) {
            List<GameObject> objs = new ArrayList<>();
            for (Object o : options) objs.add((GameObject) o);
            i = chooseIndex(title.toString(), sourceOf(sa), objs, optional);
        } else {
            List<String> labels = new ArrayList<>();
            for (Object o : options) labels.add(voteLabel(o));
            i = chooseText(title.toString(), sourceOf(sa), labels, optional);
        }
        if (i == null) return super.vote(sa, prompt, options, votes, forPlayer, optional);
        return i < 0 ? null : options.get(i);
    }

    private static String voteLabel(Object o) {
        if (o instanceof SpellAbility s) return describeSa(s);
        if (o instanceof Card c) return c.getName();
        return String.valueOf(o);
    }

    /** "Call it" / Krark's Thumb: heads or tails, or which of two flips to keep. */
    @Override
    public boolean chooseFlipResult(SpellAbility sa, Player flipper, boolean call) {
        if (autopilot()) return super.chooseFlipResult(sa, flipper, call);
        List<String> labels = call ? List.of("Heads", "Tails") : List.of("Win the flip", "Lose the flip");
        Card host = sa == null ? null : sa.getHostCard();
        Boolean r = confirm(call ? "Call the coin flip" : "Choose the result of the flip", null, host, labels, host == null ? null : host.getName(), "flip");
        return r != null ? r : super.chooseFlipResult(sa, flipper, call);
    }

    /** Convoke, improvise, waterbend: which untapped creatures / artifacts to tap toward the cost. */
    @Override
    public Map<Card, ManaCostShard> chooseCardsForConvokeOrImprovise(SpellAbility sa, ManaCost manaCost, CardCollectionView untappedCards, boolean artifacts, boolean creatures, Integer maxReduction) {
        if (autopilot() || probing || untappedCards == null || untappedCards.isEmpty() || manaCost == null || manaCost.getCMC() <= 0)
            return super.chooseCardsForConvokeOrImprovise(sa, manaCost, untappedCards, artifacts, creatures, maxReduction);
        // the seat's preference (Menu -> Stops): ask every time, only when the mana sources fall short, or never
        String mode = session.stops().convoke;
        if ("never".equals(mode)) return new java.util.HashMap<>();
        boolean short_ = !probe(() -> ComputerUtilMana.canPayManaCost(new forge.game.mana.ManaCostBeingPaid(manaCost), sa, player, false));
        if ("needed".equals(mode) && !short_) return new java.util.HashMap<>();
        String what = artifacts && creatures ? "Waterbend" : creatures ? "Convoke" : "Improvise";
        String kind = artifacts && creatures ? "artifacts and creatures" : creatures ? "creatures" : "artifacts";
        List<Card> cards = new ArrayList<>(untappedCards);
        int max = Math.min(manaCost.getCMC(), cards.size());
        if (maxReduction != null) max = Math.min(max, maxReduction);
        String note = short_ ? " (your mana cannot cover it alone)" : " (none = pay with mana)";
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            List<Card> chosen = chooseCards(what + ": tap " + kind + " to help pay " + manaCost + note, sourceOf(sa), cards, 0, max, "convoke");
            if (chosen == null) return super.chooseCardsForConvokeOrImprovise(sa, manaCost, untappedCards, artifacts, creatures, maxReduction);
            Map<Card, ManaCostShard> out = convokeShards(chosen, manaCost, artifacts);
            if (out != null) return out;
            session.sendError("those cards cannot all pay toward " + manaCost);
        }
        return super.chooseCardsForConvokeOrImprovise(sa, manaCost, untappedCards, artifacts, creatures, maxReduction);
    }

    /** As Forge's convoke input: each card pays a shard of one of its colours if one is still unpaid, else generic. */
    public static Map<Card, ManaCostShard> convokeShards(List<Card> chosen, ManaCost manaCost, boolean artifacts) {
        ManaCostBeingPaid remaining = new ManaCostBeingPaid(manaCost);
        List<Card> ordered = new ArrayList<>(chosen);
        // fewest colours first, so a mono-coloured creature takes its coloured shard before a flexible one does
        ordered.sort((x, y) -> Integer.compare(x.getColor().countColors(), y.getColor().countColors()));
        Map<Card, ManaCostShard> out = new LinkedHashMap<>();
        for (Card c : ordered) {
            ManaCostShard shard = null;
            if (artifacts) {
                shard = remaining.payManaViaConvoke(ManaCostShard.COLORLESS.getColorMask());
            } else {
                byte colours = c.getColor().getColor();
                byte useful = (byte) (colours & remaining.getUnpaidColors());
                for (byte b : MagicColor.WUBRG) {
                    if ((useful & b) != 0) { shard = remaining.payManaViaConvoke(b); if (shard != null) break; }
                }
                if (shard == null) shard = remaining.payManaViaConvoke(colours == 0 ? ManaCostShard.COLORLESS.getColorMask() : firstColour(colours));
            }
            if (shard == null) return null;
            out.put(c, shard);
        }
        return out;
    }

    private static byte firstColour(byte colours) {
        for (byte b : MagicColor.WUBRG) if ((colours & b) != 0) return b;
        return colours;
    }

    /** "Put one of each ... into your hand" (DigMultiple): one pick per group, as PlayerControllerHuman. */
    @Override
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa, String title, boolean isOptional) {
        if (autopilot()) return super.chooseCardsForEffectMultiple(validMap, sa, title, isOptional);
        CardCollection result = new CardCollection();
        for (Map.Entry<String, CardCollection> e : validMap.entrySet()) {
            CardCollection pool = new CardCollection(e.getValue());
            pool.removeAll(result);
            if (pool.isEmpty()) continue;
            List<Card> one = chooseCards(title + " (" + e.getKey() + ")", sourceOf(sa), new ArrayList<>(pool), isOptional ? 0 : 1, 1, null);
            if (one == null) return super.chooseCardsForEffectMultiple(validMap, sa, title, isOptional);
            result.addAll(one);
        }
        return result;
    }

    /** Splice onto Arcane: which cards from hand to reveal and splice. */
    @Override
    public List<Card> chooseCardsForSplice(SpellAbility sa, List<Card> cards) {
        if (autopilot() || cards == null || cards.isEmpty()) return super.chooseCardsForSplice(sa, cards);
        List<Card> chosen = chooseCards("Splice onto " + sa.getHostCard().getName() + ": which cards?", sourceOf(sa), new ArrayList<>(cards), 0, cards.size(), "splice");
        return chosen == null ? super.chooseCardsForSplice(sa, cards) : chosen;
    }

    // dice (Commander has plenty: Wyll, Pixie Guide, The Deck of Many Things): the human picks, as in PlayerControllerHuman

    private static List<String> rollLabels(List<?> rolls) {
        List<String> labels = new ArrayList<>();
        for (int i = 0; i < rolls.size(); i++) labels.add("Die " + (i + 1) + ": " + rolls.get(i));
        return labels;
    }

    @Override
    public Integer chooseRollToIgnore(List<Integer> rolls) {
        if (autopilot() || rolls == null || rolls.size() <= 1) return super.chooseRollToIgnore(rolls);
        Integer i = chooseText("Which roll do you ignore?", null, rollLabels(rolls), false);
        return i == null || i < 0 ? super.chooseRollToIgnore(rolls) : rolls.get(i);
    }

    @Override
    public List<Integer> chooseDiceToReroll(List<Integer> rolls) {
        if (autopilot() || rolls == null || rolls.isEmpty()) return super.chooseDiceToReroll(rolls);
        List<Integer> picks = chooseManyText("Choose dice to reroll", null, rollLabels(rolls), 0, rolls.size(), "reroll");
        if (picks == null) return super.chooseDiceToReroll(rolls);
        List<Integer> out = new ArrayList<>();
        for (int i : picks) out.add(rolls.get(i));
        return out;
    }

    @Override
    public Integer chooseRollToModify(List<Integer> rolls) {
        if (autopilot() || rolls == null || rolls.isEmpty()) return super.chooseRollToModify(rolls);
        Integer i = chooseText("Choose a roll to modify (or none)", null, rollLabels(rolls), true);
        return i == null ? super.chooseRollToModify(rolls) : i < 0 ? null : rolls.get(i);
    }

    @Override
    public RollDiceEffect.DieRollResult chooseRollToSwap(List<RollDiceEffect.DieRollResult> rolls) {
        if (autopilot() || rolls == null || rolls.isEmpty()) return super.chooseRollToSwap(rolls);
        Integer i = chooseText("Choose a roll to swap (or none)", null, rollLabels(rolls), true);
        return i == null ? super.chooseRollToSwap(rolls) : i < 0 ? null : rolls.get(i);
    }

    @Override
    public String chooseRollSwapValue(List<String> swapChoices, Integer currentResult, int power, int toughness) {
        if (autopilot() || swapChoices == null || swapChoices.isEmpty()) return super.chooseRollSwapValue(swapChoices, currentResult, power, toughness);
        Integer i = chooseText("Swap the roll of " + currentResult + " with power " + power + " or toughness " + toughness + "? (or neither)", null, swapChoices, true);
        return i == null ? super.chooseRollSwapValue(swapChoices, currentResult, power, toughness) : i < 0 ? null : swapChoices.get(i);
    }

    /** Assist (another player helps pay a spell's generic mana): whom to ask. */
    @Override
    public Player choosePlayerToAssistPayment(FCollectionView<Player> optionList, SpellAbility sa, String title, int max) {
        if (autopilot() || optionList == null || optionList.isEmpty()) return super.choosePlayerToAssistPayment(optionList, sa, title, max);
        return chooseSingleEntityForEffect(optionList, null, sa, title == null || title.isBlank() ? "Ask a player to help pay (Assist), or nobody" : title, true, null, null);
    }

    /** Assist, the helper's side: how much of SOMEONE ELSE's spell this seat pays. The AI must never spend a human's mana here. */
    @Override
    public boolean helpPayForAssistSpell(ManaCostBeingPaid cost, SpellAbility sa, int max, int requested) {
        if (autopilot()) return super.helpPayForAssistSpell(cost, sa, max, requested);
        Integer n = number(sa.getActivatingPlayer().getName() + " asks for help paying for " + sa.getHostCard().getName() + " (Assist, up to " + max + "). How much do you pay?", sourceOf(sa), 0, max, null);
        int willPay = n == null ? 0 : n; // nobody answered: help with nothing (spending a human's mana is never automatic)
        if (willPay <= 0) return true;
        ManaCostBeingPaid assist = new ManaCostBeingPaid(ManaCost.get(willPay));
        if (!probe(() -> ComputerUtilMana.canPayManaCost(assist, sa, player, false))) {
            session.sendError("you cannot pay " + willPay + " right now");
            return true;
        }
        ComputerUtilMana.payManaCost(assist, sa, player, false);
        cost.decreaseGenericMana(willPay);
        game.getGameLog().add(GameLogEntryType.MANA, player.getName() + " helps pay " + willPay + " for " + sa.getHostCard().getName() + ".");
        return true;
    }

    /** Venture into the dungeon: which dungeon. */
    @Override
    public ICardFace chooseSingleCardFace(SpellAbility sa, List<ICardFace> faces, String message) {
        if (autopilot() || faces == null || faces.size() <= 1) return super.chooseSingleCardFace(sa, faces, message);
        List<String> labels = new ArrayList<>();
        for (ICardFace f : faces) labels.add(f.getName());
        Integer i = chooseText(message == null || message.isBlank() ? "Choose one" : message, sourceOf(sa), labels, false);
        return i == null || i < 0 ? super.chooseSingleCardFace(sa, faces, message) : faces.get(i);
    }

    /** Rooms: which door to unlock or lock. */
    @Override
    public CardState chooseSingleCardState(SpellAbility sa, List<CardState> states, String message, Map<String, Object> params) {
        if (autopilot() || states == null || states.size() <= 1) return super.chooseSingleCardState(sa, states, message, params);
        List<String> labels = new ArrayList<>();
        for (CardState st : states) labels.add(st.getName());
        Integer i = chooseText(message == null || message.isBlank() ? "Choose one" : message, sourceOf(sa), labels, false);
        return i == null || i < 0 ? super.chooseSingleCardState(sa, states, message, params) : states.get(i);
    }

    /** Bidding life (Illicit Auction, Mages' Contest): bid one more, or stop. */
    @Override
    public boolean confirmBidAction(SpellAbility sa, PlayerActionConfirmMode bidlife, String string, int bid, Player winner) {
        if (autopilot()) return super.confirmBidAction(sa, bidlife, string, bid, winner);
        Card host = sa == null ? null : sa.getHostCard();
        Boolean r = confirm(string + " (highest bidder: " + winner.getName() + ")", null, host, List.of("Bid higher", "Stop bidding"), host == null ? null : host.getName(), "bid");
        return r != null ? r : super.confirmBidAction(sa, bidlife, string, bid, winner);
    }

    /** A prevention shield that covers several damage events at once: how much is prevented where. */
    @Override
    public Map<GameEntity, Integer> divideShield(Card effectSource, Map<GameEntity, Integer> affected, int shieldAmount) {
        if (autopilot() || affected == null || affected.size() <= 1) return super.divideShield(effectSource, affected, shieldAmount);
        List<GameEntity> targets = new ArrayList<>(affected.keySet());
        int incoming = 0;
        for (int v : affected.values()) incoming += v;
        int total = Math.min(shieldAmount, incoming);
        List<Integer> amounts = assign("Prevent " + total + " damage: divide it", effectSource == null ? null : effectSource.getName(), effectSource, targets, total, null);
        if (amounts == null) return super.divideShield(effectSource, affected, shieldAmount);
        Map<GameEntity, Integer> out = new HashMap<>();
        for (int i = 0; i < targets.size(); i++) if (amounts.get(i) > 0) out.put(targets.get(i), Math.min(amounts.get(i), affected.get(targets.get(i))));
        return out;
    }

    // ------------------------------------------------------------------ notices: what Forge shows a human without asking

    /**
     * Cards revealed TO this seat (an opponent's hand after Gitaxian Probe, a tutored card, "reveal the top
     * card", the other cards of a dig). Forge's desktop human sees them in a dialog; here they go out as a
     * fire-and-forget `notice` frame for this seat only (the relay delivers it to that player's sockets). The
     * identities are exactly what Forge reveals to this player, so carrying them is not a leak.
     */
    @Override
    public void reveal(CardCollectionView cards, ZoneType zone, Player owner, String messagePrefix, boolean addMsgSuffix) {
        super.reveal(cards, zone, owner, messagePrefix, addMsgSuffix); // the AI's memory, harmless
        if (autopilot() || cards == null) return;
        String where = zoneLabel(owner, zone);
        String title;
        if (messagePrefix == null || messagePrefix.isBlank()) title = cards.isEmpty() ? "No cards in " + where : "Revealed: " + where;
        else title = messagePrefix.trim() + (addMsgSuffix ? " " + where : ""); // as Forge's human: "Revealing face-down cards from Blair's exile"
        JsonObject n = notice("reveal", title);
        if (cards.isEmpty()) n.addProperty("text", "There are no cards in " + where + ".");
        JsonArray cj = new JsonArray();
        for (Card c : cards) {
            JsonObject j = SeatView.card(c, player);
            if (!j.has("name") || j.get("name").isJsonNull()) SeatView.addIdentity(j, c);
            cj.add(j);
        }
        n.add("cards", cj);
        session.send(n);
    }

    @Override
    public void reveal(List<forge.game.card.CardView> cards, ZoneType zone, forge.game.player.PlayerView owner, String messagePrefix, boolean addMsgSuffix) {
        CardCollection list = new CardCollection();
        if (cards != null) for (forge.game.card.CardView cv : cards) { Card c = game.findByView(cv); if (c != null) list.add(c); }
        Player p = owner == null ? null : game.getPlayer(owner);
        reveal(list, zone, p, messagePrefix, addMsgSuffix);
    }

    /** Forge tells this player a value: a chosen colour, number, creature type, a vote, a coin flip. */
    @Override
    public void notifyOfValue(SpellAbility sa, GameObject relatedTarget, String value) {
        super.notifyOfValue(sa, relatedTarget, value);
        if (autopilot() || value == null || value.isBlank()) return;
        if (sa != null && sa.isManaAbility()) return; // Forge's human only logs these
        String text = forge.util.MessageUtil.formatNotificationMessage(sa, player, relatedTarget, value);
        JsonObject n = notice("info", sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : "Note");
        n.addProperty("text", text);
        if (sa != null && sa.getHostCard() != null) {
            Card host = sa.getHostCard();
            JsonObject j = SeatView.card(host, player);
            if (!j.has("name") || j.get("name").isJsonNull()) SeatView.addIdentity(j, host); // the message names it anyway
            JsonArray cj = new JsonArray();
            cj.add(j);
            n.add("source", cj);
        }
        session.send(n);
    }

    private JsonObject notice(String kind, String title) {
        JsonObject n = new JsonObject();
        n.addProperty("type", "notice");
        n.addProperty("kind", kind);
        n.addProperty("title", title);
        return n;
    }

    private String zoneLabel(Player owner, ZoneType zone) {
        String z = zone == null ? "cards" : zone.name().toLowerCase(Locale.ROOT);
        if (owner == null) return z;
        return owner == player ? "your " + z : owner.getName() + "'s " + z;
    }

    // ------------------------------------------------------------------ the generic prompts

    /** Yes/no. Returns null when nobody answered (caller falls back to the AI). */
    private Boolean confirm(String title, String detail, Card card, List<String> labels, String source, String mode) {
        JsonObject p = prompt("confirm", title);
        p.addProperty("mode", mode);
        p.addProperty("source", source);
        if (detail != null && !detail.isBlank()) p.addProperty("detail", detail);
        JsonArray l = new JsonArray();
        if (labels != null && labels.size() >= 2) { l.add(labels.get(0)); l.add(labels.get(1)); } else { l.add("Yes"); l.add("No"); }
        p.add("options", l);
        if (card != null) {
            JsonObject cj = SeatView.card(card, player);
            if (!cj.has("name")) SeatView.addIdentity(cj, card); // the question names it anyway
            p.add("card", cj);
        }
        JsonObject a = session.ask(p);
        if (a == null) return null;
        if (a.has("confirm") && !a.get("confirm").isJsonNull()) return a.get("confirm").getAsBoolean();
        if (a.has("option") && !a.get("option").isJsonNull()) return a.get("option").getAsInt() == 0;
        return null;
    }

    /** One number in [min, max] (or one of `values`). Out-of-range answers are clamped. */
    private Integer number(String title, String source, int min, int max, List<Integer> values) {
        JsonObject p = prompt("number", title);
        p.addProperty("source", source);
        p.addProperty("min", min);
        p.addProperty("max", max);
        if (values != null) {
            JsonArray v = new JsonArray();
            for (int i : values) v.add(i);
            p.add("values", v);
        }
        JsonObject a = session.ask(p);
        if (a == null || !a.has("value") || a.get("value").isJsonNull()) return null;
        int n;
        try { n = a.get("value").getAsInt(); } catch (RuntimeException e) { return null; }
        if (values != null && !values.contains(n)) return null;
        return Math.max(min, Math.min(max, n));
    }

    /** Pick one option (card / player / spell). Returns the index, -1 for "none" when optional, null = nobody answered. */
    /** An illegal answer: the same question is asked again (up to {@link #ATTEMPTS} times) before the AI decides. */
    private static final int ATTEMPTS = 3;
    private static final Integer ILLEGAL_INDEX = Integer.MIN_VALUE;
    private static final List<Integer> ILLEGAL_LIST = Collections.unmodifiableList(new ArrayList<>());

    private Integer chooseIndex(String title, String source, List<GameObject> options, boolean optional) {
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("choose", title);
            p.addProperty("optional", optional);
            p.addProperty("source", source);
            p.add("options", objectsJson(options));
            Integer r = readChoice(session.ask(p), options.size(), optional);
            if (!ILLEGAL_INDEX.equals(r)) return r;
        }
        return null;
    }

    private Integer chooseText(String title, String source, List<String> labels, boolean optional) {
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("choose", title);
            p.addProperty("optional", optional);
            p.addProperty("source", source);
            p.add("options", textOptions(labels));
            Integer r = readChoice(session.ask(p), labels.size(), optional);
            if (!ILLEGAL_INDEX.equals(r)) return r;
        }
        return null;
    }

    private Integer readChoice(JsonObject a, int size, boolean optional) {
        if (a == null) return null;
        if (!a.has("option") || a.get("option").isJsonNull()) {
            if (optional) return -1;
            session.sendError("choose one");
            return ILLEGAL_INDEX;
        }
        int idx = a.get("option").getAsInt();
        if (idx < 0 || idx >= size) {
            session.sendError("option " + idx + " is out of range");
            return ILLEGAL_INDEX;
        }
        return idx;
    }

    /**
     * Pick between min and max options; null = nobody answered or the answer was illegal.
     * Counts are clamped to the options first (rule 701.21a and friends: a player does as much as they
     * can), like Forge's own human controller: nothing to choose = no question, and when every option
     * must be chosen they all are, without a question, and the game log says so. A prompt whose min
     * exceeds its options could never be answered and would freeze the game.
     */
    private List<Integer> chooseManyIndex(String title, String source, List<GameObject> options, int min, int max, String reason) {
        int n = options.size();
        max = Math.min(max, n);
        min = Math.max(0, Math.min(min, max));
        if (max <= 0) return new ArrayList<>();
        if (min == n) {
            List<Integer> all = new ArrayList<>();
            for (int i = 0; i < n; i++) all.add(i);
            logChoseAll(reason, source, options);
            return all;
        }
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("chooseMany", title);
            p.addProperty("min", min);
            p.addProperty("max", max);
            p.addProperty("source", source);
            if (reason != null) p.addProperty("reason", reason);
            p.add("options", objectsJson(options));
            List<Integer> r = readMany(session.ask(p), options.size(), min, max);
            if (r != ILLEGAL_LIST) return r;
        }
        return null;
    }

    private List<Integer> chooseManyText(String title, String source, List<String> labels, int min, int max, String reason) {
        int n = labels.size();
        max = Math.min(max, n);
        min = Math.max(0, Math.min(min, max));
        if (max <= 0) return new ArrayList<>();
        if (min == n) {
            List<Integer> all = new ArrayList<>();
            for (int i = 0; i < n; i++) all.add(i);
            return all;
        }
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("chooseMany", title);
            p.addProperty("min", min);
            p.addProperty("max", max);
            p.addProperty("source", source);
            if (reason != null) p.addProperty("reason", reason);
            p.add("options", textOptions(labels));
            List<Integer> r = readMany(session.ask(p), labels.size(), min, max);
            if (r != ILLEGAL_LIST) return r;
        }
        return null;
    }

    private List<Integer> readMany(JsonObject a, int size, int min, int max) {
        if (a == null) return null;
        List<Integer> out = new ArrayList<>();
        for (int idx : indices(a, "options")) if (idx >= 0 && idx < size && !out.contains(idx)) out.add(idx);
        if (out.size() < min || out.size() > max) {
            session.sendError(min == max ? "choose exactly " + min : "choose between " + min + " and " + max);
            return ILLEGAL_LIST;
        }
        return out;
    }

    private static final Map<String, String> CHOSE_ALL_VERBS = Map.of(
            "sacrifice", "sacrificed", "destroy", "destroyed", "discard", "discarded", "reveal", "revealed", "exile", "exiled");

    /** "Alex sacrificed all 6 creatures (Blasphemous Edict)." Counts only: the options may be hidden cards. */
    private void logChoseAll(String reason, String source, List<GameObject> options) {
        String verb = reason == null ? null : CHOSE_ALL_VERBS.get(reason);
        if (verb == null) return;
        int n = options.size();
        boolean creatures = true, lands = true, permanents = true;
        for (GameObject o : options) {
            if (!(o instanceof Card c)) { creatures = lands = permanents = false; break; }
            creatures &= c.isCreature();
            lands &= c.isLand();
            permanents &= c.isInZone(ZoneType.Battlefield);
        }
        String noun = creatures ? "creature" : lands ? "land" : permanents ? "permanent" : "card";
        String what = n == 1 ? "their only " + noun : n == 2 ? "both " + noun + "s" : "all " + n + " " + noun + "s";
        String from = source == null || source.isBlank() || "the ability".equals(source) ? "" : " (" + source + ")";
        game.getGameLog().add(GameLogEntryType.INFORMATION, player.getName() + " " + verb + " " + what + from + ".");
    }

    /** Cards only (used by the cost decider too). Counts are clamped in chooseManyIndex. */
    List<Card> chooseCards(String title, String source, List<Card> cards, int min, int max, String reason) {
        List<Integer> picks = chooseManyIndex(title, source, new ArrayList<GameObject>(cards), min, max, reason);
        if (picks == null) return null;
        List<Card> out = new ArrayList<>();
        for (int i : picks) out.add(cards.get(i));
        return out;
    }

    private record Ordered(List<Integer> order, Map<Integer, String> bucket) { }

    /** Arrange items (cards) in order, optionally sorting each into a bucket ("top"/"bottom"). */
    private Ordered order(String title, String source, List<GameObject> items, List<String> buckets, String defaultBucket, String note) {
        JsonObject p = prompt("order", title);
        p.addProperty("source", source);
        p.addProperty("note", note);
        p.add("items", objectsJson(items));
        return readOrder(p, items.size(), buckets, defaultBucket);
    }

    private Ordered orderText(String title, String source, List<String> labels, String note) {
        JsonObject p = prompt("order", title);
        p.addProperty("source", source);
        p.addProperty("note", note);
        p.add("items", textOptions(labels));
        return readOrder(p, labels.size(), null, null);
    }

    private Ordered readOrder(JsonObject p, int size, List<String> buckets, String defaultBucket) {
        if (buckets != null) {
            JsonArray b = new JsonArray();
            for (String s : buckets) b.add(s);
            p.add("buckets", b);
            p.addProperty("defaultBucket", defaultBucket);
        }
        JsonObject a = session.ask(p);
        if (a == null) return null;
        List<Integer> order = new ArrayList<>();
        for (int idx : indices(a, "order")) if (idx >= 0 && idx < size && !order.contains(idx)) order.add(idx);
        for (int i = 0; i < size; i++) if (!order.contains(i)) order.add(i); // anything left keeps its place at the end
        Map<Integer, String> bucket = new LinkedHashMap<>();
        if (buckets != null) {
            JsonObject bj = a.has("buckets") && a.get("buckets").isJsonObject() ? a.getAsJsonObject("buckets") : new JsonObject();
            for (int i = 0; i < size; i++) {
                String b = bj.has(String.valueOf(i)) && !bj.get(String.valueOf(i)).isJsonNull() ? bj.get(String.valueOf(i)).getAsString() : defaultBucket;
                bucket.put(i, buckets.contains(b) ? b : defaultBucket);
            }
        }
        return new Ordered(order, bucket);
    }

    /** Split `total` among targets; answer `amounts` is positional. Null = nobody answered / illegal. */
    private List<Integer> assign(String title, String source, Card sourceCard, List<GameEntity> targets, int total, Map<GameEntity, Integer> lethal) {
        for (int attempt = 0; attempt < ATTEMPTS; attempt++) {
            JsonObject p = prompt("assign", title);
            p.addProperty("source", source);
            p.addProperty("total", total);
            if (sourceCard != null) p.add("card", SeatView.card(sourceCard, player));
            JsonArray ts = objectsJson(new ArrayList<GameObject>(targets));
            if (lethal != null) {
                for (int i = 0; i < targets.size(); i++) {
                    Integer l = lethal.get(targets.get(i));
                    if (l != null) ts.get(i).getAsJsonObject().addProperty("lethal", l);
                }
            }
            p.add("targets", ts);
            JsonObject a = session.ask(p);
            if (a == null) return null;
            List<Integer> amounts = indices(a, "amounts");
            String problem = null;
            int sum = 0;
            if (amounts.size() != targets.size()) problem = "expected " + targets.size() + " amounts";
            else {
                for (int n : amounts) { if (n < 0) problem = "amounts cannot be negative"; sum += n; }
                if (problem == null && sum != total) problem = "the amounts must add up to " + total;
            }
            if (problem == null) return amounts;
            session.sendError(problem);
        }
        return null;
    }

    // ------------------------------------------------------------------ helpers

    /** Option lists carry identity: Forge only asks a seat to choose among things that seat may see. */
    private JsonArray objectsJson(List<? extends GameObject> objects) {
        JsonArray a = new JsonArray();
        int i = 0;
        for (GameObject o : objects) {
            JsonObject j;
            if (o instanceof Card c) {
                j = SeatView.card(c, player);
                j.addProperty("kind", "card");
                if (!j.has("name")) SeatView.addIdentity(j, c);
            } else if (o instanceof GameEntity e) {
                j = SeatView.entityRef(e);
            } else if (o instanceof SpellAbility sa) {
                j = new JsonObject();
                j.addProperty("kind", "spell");
                j.addProperty("name", describeSa(sa));
                if (sa.getHostCard() != null) j.addProperty("cardId", sa.getHostCard().getId());
                for (SpellAbilityStackInstance si : game.getStack()) if (si.getSpellAbility() == sa) j.addProperty("stackId", si.getId());
            } else {
                j = new JsonObject();
                j.addProperty("kind", "text");
                j.addProperty("name", String.valueOf(o));
            }
            j.addProperty("index", i++);
            a.add(j);
        }
        return a;
    }

    private static JsonArray textOptions(List<String> labels) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < labels.size(); i++) {
            JsonObject j = new JsonObject();
            j.addProperty("kind", "text");
            j.addProperty("index", i);
            j.addProperty("name", labels.get(i));
            a.add(j);
        }
        return a;
    }

    private static List<Integer> indices(JsonObject a, String key) {
        List<Integer> out = new ArrayList<>();
        if (a != null && a.has(key) && a.get(key).isJsonArray()) {
            for (JsonElement e : a.getAsJsonArray(key)) {
                try { out.add(e.getAsInt()); } catch (RuntimeException ignored) { }
            }
        }
        return out;
    }

    private static boolean isTrue(JsonObject o, String key) {
        return o.has(key) && !o.get(key).isJsonNull() && o.get(key).getAsBoolean();
    }

    private static Card byId(List<Card> cards, int id) {
        for (Card c : cards) if (c.getId() == id) return c;
        return null;
    }

    private static GameEntity defenderOf(List<GameEntity> defenders, JsonObject ref) {
        if (ref == null) return null;
        boolean wantPlayer = !ref.has("kind") || "player".equals(ref.get("kind").getAsString());
        int id = ref.get("id").getAsInt();
        for (GameEntity d : defenders) {
            if (d.getId() == id && (d instanceof Player) == wantPlayer) return d;
        }
        return null;
    }
}
