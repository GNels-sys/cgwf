package cgwf.engine.bridge;

import com.google.common.collect.Table;
import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.player.Player;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.trigger.Trigger;
import forge.game.zone.Zone;
import forge.game.zone.ZoneType;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;

/**
 * Forge remembers every spell cast this turn (`MagicStack.thisTurnCast`), and with each one a snapshot of the
 * whole battlefield and every graveyard as they were when it was cast (`SpellAbility.lastStateBattlefield`, copies
 * of every card). Nothing frees them before the turn ends. Owner report 2026-11-22: a Sprout Swarm loop repeated
 * 500 times with a few hundred Saprolings in play slowed to a crawl near the 200th token and then ended in "engine
 * failure": the engine's log has `OutOfMemoryError: Java heap space`. Measured here with 300 creatures in play:
 * fifty casts left 32,000 extra card objects behind, about 9 MB a cast.
 *
 * A snapshot matters while its spell is on the stack and while what it made is resolving its own enters triggers.
 * So the newest few are kept, as is that of any spell still on the stack; older ones are emptied, the way Forge
 * itself empties them on last-known-information copies (`CardCopyService`). The list of spells cast this turn
 * (storm, "your second spell each turn") is untouched.
 */
public final class CastSnapshots {
    /** Casts whose snapshots are always kept: the newest ones. */
    static final int KEEP = 8;

    private CastSnapshots() { }

    /**
     * Empties the snapshots of this turn's older casts, and those kept by tokens. Game thread only, and only between
     * resolutions (at a priority). Returns how many snapshots were freed.
     */
    public static int trim(Game game) {
        if (game.getStack().getSpellsCastThisTurn().size() <= KEEP) return 0; // an ordinary turn: nothing piles up
        return trimCasts(game) + trimTokens(game) + trimResolved(game);
    }

    /** Forge's private per-card record of the abilities that resolved this turn; `CastSnapshotsTest` fails if it is renamed. */
    static final String RESOLVED_FIELD = "numberAbilityResolved";
    private static Field resolvedField;
    private static boolean resolvedFieldMissing;

    /**
     * The biggest holder (measured: four fifths of what was kept). A card counts how often each of its abilities
     * resolved this turn (`Card.numberAbilityResolved`, for "activate only once each turn" and the like), keyed by
     * the ability object itself, and that object still carries the battlefield snapshot it resolved with. A spell
     * with buyback is the same card every time, so after fifty casts it held fifty boards. The count stays; the
     * snapshots of abilities that have finished resolving go.
     *
     * A card that changes zone is a new object in Forge, and its record lives on in the last-known-information
     * copies of it: the ones this turn's casts and the tokens' makers point at. Those are looked at too.
     */
    private static int trimResolved(Game game) {
        Field f = resolvedField();
        if (f == null) return 0;
        Set<Card> cards = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Card c : game.getCardsInGame()) {
            cards.add(c);
            if (!c.isToken() || !c.isInPlay()) continue;
            SpellAbility made = c.getTokenSpawningAbility();
            if (made == null) continue;
            if (made.getHostCard() != null) cards.add(made.getHostCard());
            SpellAbility root = made.getRootAbility();
            if (root != null && root.getHostCard() != null) cards.add(root.getHostCard());
        }
        for (SpellAbility sa : game.getStack().getSpellsCastThisTurn()) {
            if (sa != null && sa.getHostCard() != null) cards.add(sa.getHostCard());
        }
        // every zone remembers the cards that entered it this turn, as they were: the spell's earlier selves
        List<Zone> zones = new ArrayList<>();
        zones.add(game.getStackZone());
        for (Player p : game.getRegisteredPlayers()) {
            for (ZoneType zt : ZoneType.values()) {
                Zone z = p.getZone(zt);
                if (z != null) zones.add(z);
            }
        }
        for (Zone z : zones) {
            if (z == null) continue;
            for (ZoneType origin : ZoneType.values()) {
                List<Card> entered = z.getCardsAddedThisTurn(origin);
                if (entered != null) cards.addAll(entered);
            }
        }
        Set<Card> inGame = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Card c : game.getCardsInGame()) inGame.add(c);
        Set<Integer> onStack = new HashSet<>();
        for (SpellAbilityStackInstance si : game.getStack()) {
            if (si.getSourceCard() != null) onStack.add(si.getSourceCard().getId());
        }
        int freed = 0;
        for (Card c : cards) {
            Object table;
            try {
                table = f.get(c);
            } catch (IllegalAccessException | RuntimeException e) {
                return freed;
            }
            if (table instanceof Table<?, ?, ?> t && !t.isEmpty()) {
                for (Object key : t.rowKeySet()) {
                    if (key instanceof SpellAbility sa && empty(sa)) freed++;
                }
            }
            // an old copy of a card that is not waiting on the stack: nothing of it will resolve again
            if (!inGame.contains(c) && !onStack.contains(c.getId())) freed += emptyAllOn(c);
        }
        return freed;
    }

    /**
     * Every ability, trigger and replacement effect of an old copy of a card. The third holder found: a buyback
     * spell's "return it to your hand instead" effect keeps the snapshot it was applied with, on each old copy.
     */
    private static int emptyAllOn(Card c) {
        int freed = 0;
        try {
            for (SpellAbility sa : c.getAllSpellAbilities()) {
                if (empty(sa)) freed++;
            }
            for (ReplacementEffect re : c.getReplacementEffects()) {
                SpellAbility over = re.getOverridingAbility();
                if (over != null && empty(over)) freed++;
            }
            for (Trigger t : c.getTriggers()) {
                SpellAbility over = t.getOverridingAbility();
                if (over != null && empty(over)) freed++;
            }
        } catch (RuntimeException e) {
            // a half-built copy: leave it
        }
        return freed;
    }

    static Field resolvedField() {
        if (resolvedField != null || resolvedFieldMissing) return resolvedField;
        try {
            Field f = Card.class.getDeclaredField(RESOLVED_FIELD);
            f.setAccessible(true);
            resolvedField = f;
        } catch (ReflectiveOperationException | RuntimeException e) {
            resolvedFieldMissing = true;
            System.err.println("[CastSnapshots] Forge's " + RESOLVED_FIELD + " is not there; resolved abilities keep their snapshots: " + e);
        }
        return resolvedField;
    }

    /**
     * Every token remembers the ability that made it (`Card.getTokenSpawningAbility`), and that ability keeps the
     * battlefield snapshot it resolved with: one more copy of the board per token made, for as long as the token
     * lives. The ability has finished resolving by the time anyone has priority, so its snapshot is emptied.
     */
    private static int trimTokens(Game game) {
        int freed = 0;
        for (Card c : game.getCardsIn(ZoneType.Battlefield)) {
            if (!c.isToken()) continue;
            SpellAbility made = c.getTokenSpawningAbility();
            if (made == null) continue;
            if (empty(made)) freed++;
            SpellAbility root = made.getRootAbility();
            if (root != null && root != made && empty(root)) freed++;
        }
        return freed;
    }

    /** Empties one ability's snapshots; false when there was nothing to free. */
    private static boolean empty(SpellAbility sa) {
        CardCollection battlefield = sa.getLastStateBattlefield();
        CardCollection graveyard = sa.getLastStateGraveyard();
        if ((battlefield == null || battlefield.isEmpty()) && (graveyard == null || graveyard.isEmpty())) return false;
        sa.setLastStateBattlefield(CardCollection.EMPTY);
        sa.setLastStateGraveyard(CardCollection.EMPTY);
        return true;
    }

    private static int trimCasts(Game game) {
        List<SpellAbility> cast = game.getStack().getSpellsCastThisTurn();
        int upTo = cast.size() - KEEP;
        if (upTo <= 0) return 0;
        Set<Integer> onStack = null;
        int freed = 0;
        for (int i = 0; i < upTo; i++) {
            SpellAbility sa = cast.get(i);
            if (sa == null) continue;
            CardCollection battlefield = sa.getLastStateBattlefield();
            CardCollection graveyard = sa.getLastStateGraveyard();
            if ((battlefield == null || battlefield.isEmpty()) && (graveyard == null || graveyard.isEmpty())) continue;
            if (onStack == null) {
                onStack = new HashSet<>();
                for (SpellAbilityStackInstance si : game.getStack()) {
                    Card source = si.getSourceCard();
                    if (source != null) onStack.add(source.getId());
                }
            }
            Card host = sa.getHostCard();
            if (host != null && onStack.contains(host.getId())) continue; // still waiting to resolve
            sa.setLastStateBattlefield(CardCollection.EMPTY);
            sa.setLastStateGraveyard(CardCollection.EMPTY);
            freed++;
        }
        return freed;
    }
}
