package cgwf.engine.bridge;

import forge.game.player.Player;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The table's opening-hand rule (lobby setting, 2026-10-20), shared by every seat's controller.
 *
 * <ul>
 * <li>DRAW7: Forge's London mulligan, with the table's number of free mulligans. Forge's MulliganService
 *     still runs the whole flow (deal, keep or shuffle back and redraw seven, Serum Powder, then the
 *     opening-hand actions), but its only free-mulligan setting is a flag ("the first mulligan is free when
 *     there are more than two players"). So the count of cards to put on the bottom is decided here and
 *     answered through the controller hook Forge itself asks for it, {@code tuckCardsViaMulligan}.</li>
 * <li>DRAW10: Forge deals ten (its own starting hand size); before anyone keeps, every player chooses three
 *     cards at the same time, those go back into the library and it is shuffled; no mulligans. Runs once,
 *     from the first {@code mulliganKeepHand} Forge asks (any seat), on the game thread.</li>
 * </ul>
 * {@link #FORGE} (an older relay sent no rule): Forge's own numbers, unchanged.
 */
public final class OpeningHand {
    public enum Mode { DRAW7, DRAW10 }

    public static final int DRAW10_HAND = 10;
    public static final int PUT_BACK = 3;
    public static final int MAX_FREE = 2;
    public static final OpeningHand FORGE = new OpeningHand(Mode.DRAW7, -1);

    public final Mode mode;
    /** Free mulligans per player (0-2), or -1 = Forge decides. */
    public final int freeMulligans;
    private final AtomicBoolean putBackDone = new AtomicBoolean();
    private volatile Runnable putBack;

    public OpeningHand(Mode mode, int freeMulligans) {
        this.mode = mode;
        this.freeMulligans = freeMulligans < 0 ? -1 : Math.min(MAX_FREE, freeMulligans);
    }

    public boolean drawTen() { return mode == Mode.DRAW10; }

    /** Whether the table set the free-mulligan count (else Forge's own count applies). */
    public boolean ownsFreeMulligans() { return mode == Mode.DRAW7 && freeMulligans >= 0; }

    /**
     * Cards to put on the bottom after the mulligan Forge is performing for {@code p} right now (Forge calls
     * tuckCardsViaMulligan inside the mulligan, before it counts it in the player's statistics).
     */
    public int bottomNow(Player p) { return Math.max(0, p.getStats().getMulliganCount() + 1 - freeMulligans); }

    /** Cards already put on the bottom (for the keep question), and how many the next mulligan would. */
    public int bottomSoFar(Player p) { return Math.max(0, p.getStats().getMulliganCount() - freeMulligans); }

    void setPutBack(Runnable r) { this.putBack = r; }

    /** Draw 10: run every player's put-back once (the first seat Forge asks to keep triggers it). */
    public void ensurePutBack() {
        Runnable r = putBack;
        if (r != null && putBackDone.compareAndSet(false, true)) r.run();
    }

    public static OpeningHand parse(String mode, Integer free) {
        if ("draw10".equals(mode)) return new OpeningHand(Mode.DRAW10, 0);
        if ("draw7".equals(mode)) return new OpeningHand(Mode.DRAW7, free == null ? 1 : Math.max(0, free));
        return FORGE;
    }
}
