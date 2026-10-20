package cgwf.engine.bridge;

import forge.game.player.Player;

/**
 * Who takes the first turn, decided outside Forge (CGwF's D20 roll or its own random pick) and
 * handed in before Match.startGame. Forge flips for a player and then asks THAT player's controller
 * {@code chooseStartingPlayer}; every seat's controller answers with this holder's player when it is
 * set, so whoever Forge flipped for, the table's winner goes first and Forge never re-randomises.
 * Unset (an older server): Forge's own coin flip and choice, as before.
 */
public final class StartingPlayer {
    private volatile Player player;

    public Player get() { return player; }

    public void set(Player p) { this.player = p; }
}
