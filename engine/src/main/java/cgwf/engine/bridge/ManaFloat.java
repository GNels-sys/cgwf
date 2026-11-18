package cgwf.engine.bridge;

import forge.ai.ComputerUtil;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.ability.AbilityUtils;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.cost.Cost;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartMana;
import forge.game.cost.CostTap;
import forge.game.mana.Mana;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.Player;
import forge.game.spellability.AbilityManaPart;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Paying through mana abilities that themselves cost mana (Signets, filter lands), in the right order.
 *
 * Forge's automatic payer pays such an ability's own cost only from sources that cost nothing to use, so it
 * cannot chain them: Sol Ring into a Signet into Sunken Ruins is the only way some boards make black mana, the
 * payer's affordability check says the spell can be paid, and the real payment then fails ("returned to Command
 * (could not be put on the stack)"; owner report 2026-11-18, room WYJ9C4: the commander could not be cast).
 *
 * This is the fallback for that case. It works on a small model of the board (each untapped permanent's plain
 * mana abilities: what they cost to use and what they make), searches breadth first for the fewest activations
 * after which the floating mana alone pays the cost, activates the first of them for real, reads the real pool
 * and searches again, until the pool pays the cost or nothing more helps. The caller then lets Forge pay from the
 * pool. The model is a guide only; every step is a real activation checked against the real pool.
 */
final class ManaFloat {
    private ManaFloat() { }

    private static final String LETTERS = "WUBRGC";
    private static final int ALL = 0b111111;
    private static final int MAX_SOURCES = 24;

    /** One mana ability of one untapped permanent, as the model sees it. */
    private record Source(Card card, SpellAbility ability, int index, List<Integer> cost, List<int[]> outputs, List<String> choices) {
        boolean filter() { return !cost.isEmpty(); }
    }

    private record Step(Source source, int option) { }

    private record Node(long used, int[] pool, Step first, int depth) { }

    private static int bit(char letter) {
        int i = LETTERS.indexOf(letter);
        return i < 0 ? 0 : 1 << i;
    }

    /** Which letters may pay this shard; 0 = not something the model pays (X). */
    private static int mask(ManaCostShard shard) {
        if (shard == ManaCostShard.X || shard == ManaCostShard.COLORED_X) return 0;
        if (shard == ManaCostShard.COLORLESS) return bit('C');
        if (shard.isGeneric()) return ALL;
        int m = 0;
        byte colours = shard.getColorMask();
        if ((colours & MagicColor.WHITE) != 0) m |= bit('W');
        if ((colours & MagicColor.BLUE) != 0) m |= bit('U');
        if ((colours & MagicColor.BLACK) != 0) m |= bit('B');
        if ((colours & MagicColor.RED) != 0) m |= bit('R');
        if ((colours & MagicColor.GREEN) != 0) m |= bit('G');
        return m == 0 ? ALL : m;
    }

    private static List<Integer> needs(ManaCostBeingPaid cost) {
        List<Integer> out = new ArrayList<>();
        for (ManaCostShard s : cost.getUnpaidShards()) {
            int m = mask(s);
            if (m != 0) out.add(m);
        }
        return out;
    }

    private static List<Integer> needs(ManaCost cost) {
        List<Integer> out = new ArrayList<>();
        if (cost == null) return out;
        for (ManaCostShard s : cost) {
            int m = mask(s);
            if (m != 0 && !s.isGeneric()) out.add(m);
        }
        for (int i = 0; i < cost.getGenericCost(); i++) out.add(ALL);
        return out;
    }

    /** Every pool that can be left after paying `needs` from `pool` (empty = cannot be paid). */
    private static void payAll(List<Integer> needs, int at, int[] pool, Set<String> seen, List<int[]> out, int limit) {
        if (out.size() >= limit) return;
        if (at == needs.size()) {
            if (seen.add(key(0, pool))) out.add(pool.clone());
            return;
        }
        int need = needs.get(at);
        // spend colourless first, so coloured mana is kept for what asks for it
        for (int i = LETTERS.length() - 1; i >= 0; i--) {
            if ((need & (1 << i)) == 0 || pool[i] == 0) continue;
            pool[i]--;
            payAll(needs, at + 1, pool, seen, out, limit);
            pool[i]++;
        }
    }

    private static boolean pays(List<Integer> needs, int[] pool) {
        List<Integer> sorted = new ArrayList<>(needs);
        sorted.sort((a, b) -> Integer.bitCount(a) - Integer.bitCount(b)); // the pickiest first
        List<int[]> out = new ArrayList<>();
        payAll(sorted, 0, pool.clone(), new HashSet<>(), out, 1);
        return !out.isEmpty();
    }

    private static String key(long used, int[] pool) {
        StringBuilder sb = new StringBuilder().append(used);
        for (int n : pool) sb.append(',').append(n);
        return sb.toString();
    }

    private static int[] realPool(Player player) {
        int[] pool = new int[LETTERS.length()];
        for (Mana m : player.getManaPool()) {
            String s = MagicColor.toShortString(m.getColor());
            int i = s == null || s.length() != 1 ? -1 : LETTERS.indexOf(s.charAt(0));
            pool[i < 0 ? LETTERS.indexOf('C') : i]++;
        }
        return pool;
    }

    private static void combos(List<Character> colours, int n, int from, StringBuilder cur, List<String> out) {
        if (out.size() >= 15) return;
        if (cur.length() == n) { out.add(cur.toString()); return; }
        for (int i = from; i < colours.size(); i++) {
            cur.append(colours.get(i));
            combos(colours, n, i, cur, out);
            cur.setLength(cur.length() - 1);
        }
    }

    /** The untapped permanents' plain mana abilities ("{T}: Add" and "{cost}, {T}: Add"), with what they may make. */
    private static List<Source> sources(Player player, int relevant) {
        List<Source> out = new ArrayList<>();
        int index = 0;
        for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
            if (c.isTapped() || index >= MAX_SOURCES) continue;
            boolean any = false;
            for (SpellAbility ma : c.getManaAbilities()) {
                AbilityManaPart mp = ma.getManaPart();
                if (mp == null || ma.getApi() != ApiType.Mana) continue;
                Cost cost = ma.getPayCosts();
                if (cost == null || !cost.hasTapCost()) continue;
                boolean plain = true;
                for (CostPart part : cost.getCostParts()) if (!(part instanceof CostTap) && !(part instanceof CostPartMana)) plain = false;
                String limits = mp.getManaRestrictions();
                if (!plain || (limits != null && !limits.isEmpty())) continue;
                List<int[]> outputs = new ArrayList<>();
                List<String> choices = new ArrayList<>();
                try {
                    ma.setActivatingPlayer(player);
                    if (!ma.canPlay()) continue;
                    int amount = ma.hasParam("Amount") ? AbilityUtils.calculateAmount(c, ma.getParam("Amount"), ma) : 1;
                    if (amount <= 0 || amount > 40) continue;
                    if (mp.isAnyMana() || mp.isComboMana()) {
                        List<Character> colours = new ArrayList<>();
                        for (String col : BridgeController.producedColours(ma, mp)) {
                            if ("any".equals(col)) { for (char ch : "WUBRG".toCharArray()) if (!colours.contains(ch)) colours.add(ch); }
                            else if (col.length() == 1 && LETTERS.indexOf(col.charAt(0)) >= 0 && !colours.contains(col.charAt(0))) colours.add(col.charAt(0));
                        }
                        if (colours.isEmpty()) continue;
                        // only colours something asks for by name; when none is, one stand-in is enough
                        List<Character> wanted = new ArrayList<>();
                        for (char ch : colours) if ((relevant & bit(ch)) != 0) wanted.add(ch);
                        if (wanted.isEmpty()) wanted.add(colours.get(0));
                        List<String> picks = new ArrayList<>();
                        if (mp.isComboMana()) combos(wanted, amount, 0, new StringBuilder(), picks);
                        else for (char ch : wanted) picks.add(String.valueOf(ch).repeat(amount));
                        for (String pick : picks) {
                            int[] made = new int[LETTERS.length()];
                            for (char ch : pick.toCharArray()) made[LETTERS.indexOf(ch)]++;
                            outputs.add(made);
                            choices.add(mp.isComboMana() ? String.join(" ", pick.split("")) : String.valueOf(pick.charAt(0)));
                        }
                    } else {
                        int[] made = new int[LETTERS.length()];
                        boolean known = true;
                        for (String token : mp.mana(ma).trim().split("\\s+")) {
                            int i = token.length() == 1 ? LETTERS.indexOf(token.charAt(0)) : -1;
                            if (i < 0) { known = false; break; }
                            made[i] += amount;
                        }
                        if (!known) continue;
                        outputs.add(made);
                        choices.add(null);
                    }
                } catch (RuntimeException e) {
                    continue;
                }
                if (outputs.isEmpty()) continue;
                out.add(new Source(c, ma, index, needs(cost.getTotalMana()), outputs, choices));
                any = true;
            }
            if (any) index++;
        }
        // the search tries them in this order: colourless makers that cost nothing, then abilities that cost mana, then the rest
        out.sort((a, b) -> rank(a) - rank(b));
        return out;
    }

    private static int rank(Source s) {
        if (s.filter()) return 1;
        for (int[] made : s.outputs()) for (int i = 0; i < made.length - 1; i++) if (made[i] > 0) return 2;
        return 0;
    }

    /** The first activation of the shortest way to a pool that pays `needs`; null when there is none within the limit. */
    private static Step plan(List<Source> sources, List<Integer> needs, int[] start, int nodeLimit) {
        if (pays(needs, start)) return null;
        ArrayDeque<Node> queue = new ArrayDeque<>();
        Set<String> seen = new HashSet<>();
        queue.add(new Node(0L, start, null, 0));
        seen.add(key(0L, start));
        int nodes = 0;
        while (!queue.isEmpty() && nodes < nodeLimit) {
            Node n = queue.poll();
            nodes++;
            if (n.depth() >= 14) continue;
            for (Source s : sources) {
                long bit = 1L << s.index();
                if ((n.used() & bit) != 0) continue;
                List<int[]> after = new ArrayList<>();
                if (s.filter()) payAll(s.cost(), 0, n.pool().clone(), new HashSet<>(), after, 6);
                else after.add(n.pool().clone());
                for (int[] paid : after) {
                    for (int o = 0; o < s.outputs().size(); o++) {
                        int[] pool = paid.clone();
                        int[] made = s.outputs().get(o);
                        for (int i = 0; i < pool.length; i++) pool[i] += made[i];
                        long used = n.used() | bit;
                        if (!seen.add(key(used, pool))) continue;
                        Step first = n.first() == null ? new Step(s, o) : n.first();
                        if (pays(needs, pool)) return first;
                        queue.add(new Node(used, pool, first, n.depth() + 1));
                    }
                }
            }
        }
        return null;
    }

    private static int relevant(List<Integer> needs) {
        int r = 0;
        for (int m : needs) if (m != ALL) r |= m;
        return r;
    }

    private static boolean hasFilter(List<Source> sources) {
        for (Source s : sources) if (s.filter()) return true;
        return false;
    }

    /** Could a chain through mana abilities that cost mana pay this cost? Nothing is activated. */
    static boolean couldPay(Player player, ManaCostBeingPaid cost, int nodeLimit) {
        List<Integer> needs = needs(cost);
        if (needs.isEmpty()) return false;
        int[] pool = realPool(player);
        List<Source> sources = sources(player, relevant(needs) | filterColours(player));
        if (!hasFilter(sources)) return false;
        return pays(needs, pool) || plan(sources, needs, pool, nodeLimit) != null;
    }

    /** Colours the board's own filter abilities ask for, so any-colour sources may feed them. */
    private static int filterColours(Player player) {
        int r = 0;
        for (Source s : sources(player, 0)) for (int m : s.cost()) if (m != ALL) r |= m;
        return r;
    }

    /**
     * Float mana, one real activation at a time, until the pool alone pays the cost. True when it does; false
     * when there is no way (mana already floated stays in the pool, as floating mana does).
     */
    static boolean floatFor(Player player, Game game, ManaCostBeingPaid cost, int nodeLimit) {
        List<Integer> needs = needs(cost);
        if (needs.isEmpty()) return false;
        int wanted = relevant(needs) | filterColours(player);
        Set<Card> tapped = new LinkedHashSet<>();
        for (int guard = 0; guard < MAX_SOURCES; guard++) {
            int[] pool = realPool(player);
            if (pays(needs, pool)) return true;
            List<Source> sources = sources(player, wanted);
            if (guard == 0 && !hasFilter(sources)) return false; // nothing here that the ordinary payer could not do
            Step step = plan(sources, needs, pool, nodeLimit);
            if (step == null) return false;
            Source s = step.source();
            String choice = s.choices().get(step.option());
            AbilityManaPart mp = s.ability().getManaPart();
            if (choice != null) mp.setExpressChoice(choice);
            s.ability().setActivatingPlayer(player);
            if (!tapped.add(s.card()) || !ComputerUtil.playNoStack(player, s.ability(), game, false)) return false;
        }
        return pays(needs, realPool(player));
    }
}
