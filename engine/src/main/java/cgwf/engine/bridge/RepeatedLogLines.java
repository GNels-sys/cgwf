package cgwf.engine.bridge;

import java.util.HashSet;
import java.util.Set;

/**
 * Forge writes a log entry every time a replacement effect applies. An effect that stops something from
 * happening applies at every state check for as long as the thing keeps trying to happen: Platinum Angel
 * ("You can't lose the game and your opponents can't win the game.") while its controller is at 0 life or has
 * taken 21 commander damage. One game (owner report 2026-11-18, room Q9HPXF) logged that sentence over a
 * thousand times, each one a frame to the relay, a row in the event log and a toast on every screen.
 * Such a line is sent once a turn; everything else passes through.
 */
public final class RepeatedLogLines {
    private int turn = Integer.MIN_VALUE;
    private final Set<String> seen = new HashSet<>();

    /** Should this log entry go out? */
    public boolean keep(String logType, String text, int turn) {
        if (!"EFFECT_REPLACED".equals(logType)) return true;
        if (turn != this.turn) {
            this.turn = turn;
            seen.clear();
        }
        return seen.add(text == null ? "" : text);
    }
}
