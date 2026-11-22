package cgwf.engine.bridge;

import forge.game.Game;
import forge.game.zone.MagicStack;

import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.IntSupplier;

/**
 * Forge ends a game as a draw (rule 104.4b, a loop of mandatory actions) when one mandatory, untargeted trigger
 * goes on the stack more than 50 times with no player action, no life loss and no empty stack in between
 * ({@code MagicStack.isRepeatingTrigger}). That is not always a loop. Owner report 2026-11-21: an opponent's 120
 * Scute Swarm triggers were resolving one by one, each made a token, each token triggered the owner's Authority
 * of the Consuls ("whenever a creature an opponent controls enters, you gain 1 life"); at the 51st the game was
 * declared a draw ("has accepted that the game is a draw") with a finite stack still to resolve. Sixty creatures
 * entering at once do the same.
 *
 * Forge keeps the count in a private map and asks it with {@code merge(triggerId, 1, sum)}. This class puts a map
 * in its place that counts a trigger per stack size instead: a real loop on a stack that does not grow comes back
 * to the same trigger at the same stack size every round, so it still reaches the limit and is still a draw; a
 * stack that is draining (Scute Swarm) or filling in one go (sixty tokens at once) meets each size once. A loop
 * that grows the stack without end still hits Forge's other limit (more than 999 items). Everything that clears
 * Forge's count (a player acts, life is lost, the stack is empty) clears this one too.
 */
public final class TriggerRepeatGuard {
    /** Forge's field; {@code TriggerRepeatGuardTest} fails when a Forge bump renames it. */
    static final String FIELD = "triggerRepeats";

    private TriggerRepeatGuard() { }

    /** Puts the size-aware count on this game's stack. False (and a line on stderr) when Forge's field is gone. */
    public static boolean install(Game game) {
        MagicStack stack = game.getStack();
        try {
            Field f = MagicStack.class.getDeclaredField(FIELD);
            f.setAccessible(true);
            f.set(stack, new Counts(stack::size));
            return true;
        } catch (ReflectiveOperationException | RuntimeException e) {
            System.err.println("[TriggerRepeatGuard] not installed, Forge's own count stays: " + e);
            return false;
        }
    }

    /** True when this game's stack carries the size-aware count. */
    public static boolean installed(Game game) {
        try {
            Field f = MagicStack.class.getDeclaredField(FIELD);
            f.setAccessible(true);
            return f.get(game.getStack()) instanceof Counts;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return false;
        }
    }

    /** Forge's map, counting per trigger AND stack size at the moment the trigger is put on the stack. */
    static final class Counts extends HashMap<Integer, Integer> {
        private static final long serialVersionUID = 1L;
        private final transient IntSupplier stackSize;
        private final Map<Long, Integer> seen = new HashMap<>();

        Counts(IntSupplier stackSize) {
            this.stackSize = stackSize;
        }

        @Override
        public Integer merge(Integer triggerId, Integer value, BiFunction<? super Integer, ? super Integer, ? extends Integer> sum) {
            long key = ((long) triggerId << 20) | (stackSize.getAsInt() & 0xFFFFF);
            return seen.merge(key, value, (a, b) -> sum.apply(a, b));
        }

        @Override
        public void clear() {
            super.clear();
            seen.clear();
        }
    }
}
