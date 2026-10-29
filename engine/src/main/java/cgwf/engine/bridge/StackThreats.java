package cgwf.engine.bridge;

import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetChoices;

import java.util.regex.Pattern;

/**
 * Does anything an opponent has on the stack threaten this seat? (Owner, 2026-10-29: "I want to hold my
 * instants to protect my board", not be asked about every creature or ramp spell an opponent casts.)
 *
 * A stack item threatens a seat when, anywhere in its chain of sub-abilities, it
 * <ul>
 *   <li>targets the seat, a card the seat controls (or owns, for cards in their graveyard or exile), or a
 *       spell or ability the seat put on the stack (a counterspell on their spell);</li>
 *   <li>uses one of Forge's "...All" effects (DestroyAll, DamageAll, ChangeZoneAll, SacrificeAll, PumpAll,
 *       TapAll, ...): board wipes, mass bounce, "all creatures get -2/-2", "creatures you control get +2/+2";</li>
 *   <li>is defined over every player or every opponent ("each opponent discards", "each player sacrifices",
 *       Forge's {@code Defined$ Player} / {@code Player.Opponent}).</li>
 * </ul>
 * Anything else (a creature spell, ramp, card draw, removal aimed at another opponent) is not the seat's
 * business, and with the "threats" response mode the engine passes for them without asking.
 */
public final class StackThreats {
    private StackThreats() {}

    /** Forge's Defined$ values that mean every player or every opponent; never "You", "TriggeredPlayer", "Targeted". */
    private static final Pattern EVERYONE = Pattern.compile("^(Player|Opponent)(\\b|$)");

    /**
     * A short reason naming the first opponent's stack item that threatens `me` ("Blair's Swords to Plowshares
     * targets your Krenko, Mob Boss", "Alex's Wrath of God affects every permanent"), or null when nothing does.
     */
    public static String describe(Iterable<SpellAbilityStackInstance> stack, Player me) {
        if (stack == null || me == null) return null;
        for (SpellAbilityStackInstance si : stack) {
            Player by = si.getActivatingPlayer();
            if (by == null || by == me) continue;
            String why = threat(si, me);
            if (why == null) continue;
            Card source = si.getSourceCard();
            String name = source == null ? "A spell" : source.getName();
            return possessive(by.getName()) + " " + name + " " + why;
        }
        return null;
    }

    /** Why this stack item (with its sub-abilities) threatens `me`, or null. */
    static String threat(SpellAbilityStackInstance si, Player me) {
        for (SpellAbilityStackInstance s = si; s != null; s = s.getSubInstance()) {
            String why = threat(s.getSpellAbility(), s.getTargetChoices(), me);
            if (why != null) return why;
        }
        // targets may also live only on the live SpellAbility chain (copies, triggers)
        for (SpellAbility sa = si.getSpellAbility(); sa != null; sa = sa.getSubAbility()) {
            String why = threat(sa, sa.getTargets(), me);
            if (why != null) return why;
        }
        return null;
    }

    private static String threat(SpellAbility sa, TargetChoices tc, Player me) {
        if (tc != null) {
            for (Player p : tc.getTargetPlayers()) if (p == me) return "targets you";
            for (Card c : tc.getTargetCards()) {
                if (c.getController() == me || c.getOwner() == me) return "targets your " + c.getName();
            }
            for (SpellAbility t : tc.getTargetSpells()) {
                if (t.getActivatingPlayer() == me) return "targets your " + (t.getHostCard() == null ? "spell" : t.getHostCard().getName());
            }
        }
        if (sa == null) return null;
        ApiType api = sa.getApi();
        if (api != null && api.name().endsWith("All")) return "affects every " + everyWhat(api);
        String defined = sa.getParam("Defined");
        if (defined != null && EVERYONE.matcher(defined).find()) {
            return defined.contains("Opponent") ? "affects each opponent" : "affects every player";
        }
        return null;
    }

    private static String everyWhat(ApiType api) {
        switch (api) {
            case DestroyAll: case SacrificeAll: case ChangeZoneAll: return "permanent it names";
            case DamageAll: return "creature and player it names";
            case PumpAll: case AnimateAll: case ProtectionAll: case PutCounterAll: case RemoveCounterAll: return "creature it names";
            case TapAll: case UntapAll: case TapOrUntapAll: return "permanent it names";
            default: return "permanent it names";
        }
    }

    static String possessive(String name) {
        if (name == null || name.isEmpty()) return "Someone's";
        return name.endsWith("s") ? name + "'" : name + "'s";
    }
}
