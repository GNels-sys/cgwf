package cgwf.engine.bridge;

/**
 * Rounds for people, from Forge's turns (Forge's turn number stays the source of truth; Forge has no
 * rounds). A round is one pass around the table starting with the player who took turn 1: a new round
 * begins when the turn goes to a player who sits earlier in Forge's turn order (counted from that first
 * player) than the player who had the previous turn. That equals 1 + floor((turn - 1) / players still in
 * the game at the start of the round) while nobody leaves and nobody takes an extra turn, and stays
 * right when they do: an eliminated player's skipped turn shortens the round, and an extra turn by
 * the same player stays in the current round.
 */
public final class RoundTracker {
    private int first = -1;
    private int lastRel = -1;
    private int lastTurn = 0;
    private int round = 0;

    /**
     * A turn began. @param playerIndex the active player's position in Forge's (fixed) player order;
     * @param players how many players that order has (including any who lost).
     * @return the round this turn belongs to.
     */
    public synchronized int onTurn(int turn, int playerIndex, int players) {
        if (turn <= lastTurn || playerIndex < 0 || players <= 0) return round;
        lastTurn = turn;
        if (first < 0) {
            first = playerIndex;
            lastRel = 0;
            round = 1;
            return round;
        }
        int rel = ((playerIndex - first) % players + players) % players;
        if (rel < lastRel) round++;
        lastRel = rel;
        return round;
    }

    /** The current round (0 before the first turn). */
    public synchronized int round() { return round; }
}
