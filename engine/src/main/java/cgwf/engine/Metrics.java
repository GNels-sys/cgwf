package cgwf.engine;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.event.GameEventTurnBegan;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Files;
import java.nio.file.Path;

/** Turn timing + memory for the spike report. Subscribe it to a game before starting. */
public final class Metrics {
    private final long startNanos = System.nanoTime();
    private final int maxTurns;
    private volatile int turns;
    private volatile long endNanos = -1;
    private long lastTurnNanos = -1;
    private double maxTurnSeconds;
    private int slowestTurn;
    private final Game game;

    public Metrics(Game game, int maxTurns) {
        this.game = game;
        this.maxTurns = maxTurns;
    }

    @Subscribe
    public void onTurn(GameEventTurnBegan e) {
        long now = System.nanoTime();
        if (lastTurnNanos > 0) {
            double sec = (now - lastTurnNanos) / 1e9;
            if (sec > maxTurnSeconds) { maxTurnSeconds = sec; slowestTurn = turns; }
        }
        lastTurnNanos = now;
        turns = e.turnNumber();
        if (maxTurns > 0 && e.turnNumber() > maxTurns && !game.isGameOver()) {
            game.setGameOver(GameEndReason.Draw);
        }
    }

    public void finish() { endNanos = System.nanoTime(); }

    public int turns() { return turns; }
    public double wallSeconds() { return ((endNanos < 0 ? System.nanoTime() : endNanos) - startNanos) / 1e9; }
    public double secondsPerTurn() { return wallSeconds() / Math.max(1, turns); }

    public static long peakHeapMb() {
        long sum = 0;
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP && p.getPeakUsage() != null) sum += p.getPeakUsage().getUsed();
        }
        return sum / (1024 * 1024);
    }

    public static long usedHeapMb() {
        Runtime r = Runtime.getRuntime();
        return (r.totalMemory() - r.freeMemory()) / (1024 * 1024);
    }

    public static long maxHeapMb() { return Runtime.getRuntime().maxMemory() / (1024 * 1024); }

    /** Peak resident set size from /proc (Linux only), in MB; null elsewhere. */
    public static Long rssPeakMb() {
        Path status = Path.of("/proc/self/status");
        if (!Files.isReadable(status)) return null;
        try {
            for (String line : Files.readAllLines(status)) {
                if (line.startsWith("VmHWM:")) {
                    String kb = line.replaceAll("[^0-9]", "");
                    return Long.parseLong(kb) / 1024;
                }
            }
        } catch (IOException | NumberFormatException ignored) { }
        return null;
    }

    public JsonObject toJson(long seed) {
        JsonObject j = new JsonObject();
        j.addProperty("seed", seed);
        j.addProperty("turns", turns);
        j.addProperty("wallSeconds", Math.round(wallSeconds() * 100) / 100.0);
        j.addProperty("secondsPerTurn", Math.round(secondsPerTurn() * 1000) / 1000.0);
        j.addProperty("maxTurnSeconds", Math.round(maxTurnSeconds * 100) / 100.0);
        j.addProperty("slowestTurn", slowestTurn);
        if (game.getOutcome() != null) {
            GameEndReason reason = game.getOutcome().getWinCondition();
            boolean draw = game.getOutcome().isDraw() || reason == GameEndReason.Draw;
            j.addProperty("draw", draw);
            j.addProperty("winner", draw || game.getOutcome().getWinningLobbyPlayer() == null ? null : game.getOutcome().getWinningLobbyPlayer().getName());
            j.addProperty("reason", reason == null ? null : reason.name());
        }
        j.addProperty("peakHeapMb", peakHeapMb());
        j.addProperty("usedHeapMbAfter", usedHeapMb());
        Long rss = rssPeakMb();
        if (rss != null) j.addProperty("rssPeakMb", rss);
        return j;
    }
}
