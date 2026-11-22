package cgwf.engine.bridge;

import forge.game.Game;
import forge.game.GameEntity;
import forge.game.card.Card;
import forge.game.card.CardLists;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Combat decisions for a bot on a very large board, by a quick rule instead of Forge's AI.
 *
 * Owner report 2026-11-22 (room 84KYWG): after about 500 Scute Swarm tokens a bot sat in its declare-attackers
 * step for 27 minutes 38 seconds with the engine at 100% CPU, then attacked with nothing. Forge's AI weighs every
 * attacker against every blocker, and for each pair walks the triggers of every card in play; part of that work
 * (building its attack planner, which predicts the opponents' next combats and the blocks against them) runs
 * outside Forge's own thinking deadline. Measured here on plain creatures it already grows faster than the board
 * (100 attackers 1.6 s, 200 attackers 5.2 s); the live stall could not be reproduced locally, so this does not
 * patch one spot: above {@link #isBig} the bot never enters that analysis.
 *
 * The rule, on purpose simple and predictable. Attacking: opponents in order of life, lowest first; a player whose
 * attackers must pay to attack is left alone; an opponent gets just enough of the strongest remaining attackers to
 * be dead even if every one of their untapped blockers stops the strongest of them. If nobody can be killed, the
 * bot keeps one creature home for each creature its opponents control and sends the rest at the weakest opponent.
 * Blocking: while the damage coming in would kill, chump the biggest attackers with the weakest blockers;
 * otherwise only block where the blocker kills the attacker and survives.
 */
public final class BigBoardCombat {
    /** This many creatures of the bot's own, or more, is a big board. */
    static final int OWN_CREATURES = 60;
    /** This many creatures in play among all players, or more, is a big board. */
    static final int ALL_CREATURES = 150;

    private BigBoardCombat() { }

    /** Is the board too large to hand to Forge's combat AI? */
    public static boolean isBig(Game game, Player bot) {
        int mine = 0;
        int all = 0;
        for (Card c : game.getCardsIn(ZoneType.Battlefield)) {
            if (!c.isCreature()) continue;
            all++;
            if (c.getController() == bot) mine++;
        }
        return mine >= OWN_CREATURES || all >= ALL_CREATURES;
    }

    // ------------------------------------------------------------------ the plan (pure)

    /** One opponent as the attack plan sees it. */
    public record Target(int life, int blockers, int creatures, boolean taxed) { }

    /**
     * How many of the attackers (given by power, strongest first) go at each target; the rest stay home.
     * `powers` must be sorted in descending order.
     */
    public static int[] planAttack(List<Integer> powers, List<Target> targets) {
        int[] sent = new int[targets.size()];
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < targets.size(); i++) order.add(i);
        order.sort(Comparator.comparingInt(i -> targets.get(i).life()));
        int next = 0; // the strongest attacker not yet assigned
        boolean anyKill = false;
        for (int t : order) {
            Target target = targets.get(t);
            if (target.taxed() || target.life() <= 0) continue;
            int need = neededToKill(powers, next, target);
            if (need < 0) continue;
            sent[t] = need;
            next += need;
            anyKill = true;
        }
        if (anyKill) return sent;
        // nobody dies this turn: keep a blocker home for every creature that could come back at us, race with the rest
        int threat = 0;
        for (Target target : targets) threat += target.creatures();
        int surplus = powers.size() - threat;
        if (surplus <= 0) return sent;
        for (int t : order) {
            if (targets.get(t).taxed() || targets.get(t).life() <= 0) continue;
            sent[t] = surplus;
            break;
        }
        return sent;
    }

    /**
     * The fewest attackers from `from` on that kill the target although each of its blockers stops one of the
     * strongest; -1 when all that are left would not be enough.
     */
    static int neededToKill(List<Integer> powers, int from, Target target) {
        long through = 0;
        for (int i = from; i < powers.size(); i++) {
            int k = i - from + 1; // attackers sent so far
            if (k > target.blockers()) through += powers.get(i); // the first `blockers` of them are blocked
            if (through >= target.life()) return k;
        }
        return -1;
    }

    // ------------------------------------------------------------------ attack

    /** Declares this bot's attack by the rule. Game thread. */
    public static void declareAttackers(Player bot, Combat combat) {
        Game game = bot.getGame();
        List<Card> attackers = new ArrayList<>(CombatUtil.getPossibleAttackers(bot));
        attackers.removeIf(c -> c.getNetCombatDamage() <= 0);
        attackers.sort(Comparator.comparingInt(Card::getNetCombatDamage).reversed());
        List<Player> opponents = new ArrayList<>();
        for (GameEntity d : combat.getDefenders()) {
            if (d instanceof Player p && !p.hasLost() && p != bot) opponents.add(p);
        }
        if (attackers.isEmpty() || opponents.isEmpty()) return;
        List<Integer> powers = new ArrayList<>();
        for (Card c : attackers) powers.add(c.getNetCombatDamage());
        List<Target> targets = new ArrayList<>();
        for (Player p : opponents) {
            int blockers = 0;
            int creatures = 0;
            for (Card c : p.getCreaturesInPlay()) {
                creatures++;
                if (!c.isTapped() && CombatUtil.canBlock(c)) blockers++;
            }
            boolean taxed = CombatUtil.getAttackCost(game, attackers.get(0), p) != null;
            targets.add(new Target(p.getLife(), blockers, creatures, taxed));
        }
        int[] sent = planAttack(powers, targets);
        // strongest first, in the order the plan handed them out: lowest life first
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < targets.size(); i++) order.add(i);
        order.sort(Comparator.comparingInt(i -> targets.get(i).life()));
        int next = 0;
        for (int t : order) {
            Player defender = opponents.get(t);
            for (int k = 0; k < sent[t] && next < attackers.size(); next++) {
                Card c = attackers.get(next);
                if (!CombatUtil.canAttack(c, defender)) continue; // this one stays home; the next takes its place
                combat.addAttacker(c, defender);
                k++;
            }
        }
        if (!CombatUtil.validateAttackers(combat)) {
            // something on the table restricts or requires attacks: declare exactly what the rules require, as Forge's AI does
            for (Card own : CardLists.filterControlledBy(combat.getAttackers(), bot)) combat.removeFromCombat(own);
            for (Map.Entry<Card, GameEntity> e : combat.getAttackConstraints().getLegalAttackers().getLeft().entrySet()) {
                if (e.getKey().getController() == bot) combat.addAttacker(e.getKey(), e.getValue());
            }
        }
    }

    // ------------------------------------------------------------------ block

    /** Declares this bot's blocks by the rule. False when the result is not a legal block (the caller falls back). Game thread. */
    public static boolean declareBlockers(Player bot, Combat combat) {
        List<Card> attackers = new ArrayList<>(combat.getAttackersOf(bot));
        if (attackers.isEmpty()) return true; // only planeswalkers or battles are attacked: let them through
        attackers.sort(Comparator.comparingInt(Card::getNetCombatDamage).reversed());
        List<Card> blockers = new ArrayList<>();
        for (Card c : bot.getCreaturesInPlay()) {
            if (CombatUtil.canBlock(c, combat)) blockers.add(c);
        }
        if (blockers.isEmpty()) return true;
        blockers.sort(Comparator.comparingInt(Card::getNetToughness)); // weakest first: the ones to chump with
        long incoming = 0;
        for (Card a : attackers) incoming += Math.max(0, a.getNetCombatDamage());
        boolean[] used = new boolean[blockers.size()];
        for (Card attacker : attackers) {
            int power = Math.max(0, attacker.getNetCombatDamage());
            boolean lethal = incoming >= bot.getLife();
            int pick = -1;
            for (int i = 0; i < blockers.size() && pick < 0; i++) {
                if (used[i]) continue;
                Card b = blockers.get(i);
                boolean worthIt = lethal // any body will do
                        || (b.getNetToughness() > power && b.getNetCombatDamage() >= attacker.getNetToughness() && !attacker.hasKeyword("Deathtouch"));
                if (worthIt && CombatUtil.canBlock(attacker, b, combat)) pick = i;
            }
            if (pick < 0) {
                if (!lethal) continue;
                continue; // nothing may block this one
            }
            used[pick] = true;
            combat.addBlocker(attacker, blockers.get(pick));
            incoming -= power;
        }
        if (CombatUtil.validateBlocks(combat, bot) == null) return true;
        for (Card b : CardLists.filterControlledBy(combat.getAllBlockers(), bot)) combat.undoBlockingAssignment(b);
        return CombatUtil.validateBlocks(combat, bot) == null; // no blocks at all, when that is legal
    }
}
