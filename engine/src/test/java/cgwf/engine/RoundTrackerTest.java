package cgwf.engine;

import cgwf.engine.bridge.RoundTracker;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Rounds from Forge's turns: pure, no Forge needed. */
class RoundTrackerTest {
    /** Feeds turns 1..n with the given active player indexes and returns the round of each turn. */
    private static int[] rounds(int players, int... activeByTurn) {
        RoundTracker t = new RoundTracker();
        int[] out = new int[activeByTurn.length];
        for (int i = 0; i < activeByTurn.length; i++) out[i] = t.onTurn(i + 1, activeByTurn[i], players);
        return out;
    }

    @Test
    void fourPlayersGoRoundByRound() {
        // 1 + floor((turn - 1) / 4)
        assertArrayEquals(new int[] {1, 1, 1, 1, 2, 2, 2, 2, 3}, rounds(4, 0, 1, 2, 3, 0, 1, 2, 3, 0));
    }

    @Test
    void theRoundStartsWithWhoeverTookTurnOne() {
        // seat 2 went first in a 3-player game: order 2, 0, 1
        assertArrayEquals(new int[] {1, 1, 1, 2, 2, 2, 3}, rounds(3, 2, 0, 1, 2, 0, 1, 2));
    }

    @Test
    void eliminationsShortenTheRoundWithoutSkewingIt() {
        // 4 players; seat 2 loses during round 1 and takes no more turns
        assertArrayEquals(new int[] {1, 1, 1, 1, 2, 2, 2, 3, 3, 3}, rounds(4, 0, 1, 2, 3, 0, 1, 3, 0, 1, 3));
        // the first player loses: rounds now start with the next seat in order
        assertArrayEquals(new int[] {1, 1, 1, 2, 2, 3, 3}, rounds(3, 0, 1, 2, 1, 2, 1, 2));
    }

    @Test
    void anExtraTurnStaysInItsRound() {
        // 2 players; seat 1 takes an extra turn in round 2
        assertArrayEquals(new int[] {1, 1, 2, 2, 2, 3}, rounds(2, 0, 1, 0, 1, 1, 0));
    }

    @Test
    void repeatedOrOldTurnNumbersDoNotCount() {
        RoundTracker t = new RoundTracker();
        assertEquals(0, t.round());
        assertEquals(1, t.onTurn(1, 0, 2));
        assertEquals(1, t.onTurn(1, 0, 2));
        assertEquals(1, t.onTurn(2, 1, 2));
        assertEquals(2, t.onTurn(3, 0, 2));
        assertEquals(2, t.onTurn(2, 1, 2));
    }

    private static void assertArrayEquals(int[] expected, int[] actual) {
        org.junit.jupiter.api.Assertions.assertArrayEquals(expected, actual, java.util.Arrays.toString(actual));
    }
}
