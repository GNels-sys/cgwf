package cgwf.engine;

import cgwf.engine.bridge.GameSession;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * "Roll to see who goes first" (2026-10-19): the table's winner reaches Forge as the starting player
 * through every seat's chooseStartingPlayer, whoever Forge's own coin flip picked, and nobody is asked
 * "Who plays first?". A deferred game waits for beginGame. Real games; needs -Dforge.assets.
 */
class StartingPlayerTest {
    private static List<DeckLoader.Loaded> decks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)), "set -Dforge.assets to run");
        ForgeBoot.init(Path.of(assets), true);
        decks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 3);
    }

    /** Plays until turn 1 begins and returns the Forge player id whose turn it is; fails on a "Who plays first?" question. */
    private static int firstTurnPlayer(long seed, int startingSeat, int[] playerIdBySeat) throws Exception {
        LinkedBlockingQueue<JsonObject> frames = new LinkedBlockingQueue<>();
        GameSession[] g = new GameSession[1];
        g[0] = new GameSession("start-" + seed + "-" + startingSeat, seed, List.of(
                new GameSession.SeatSpec(0, true, "Alex", decks.get(0)),
                new GameSession.SeatSpec(1, false, "Bot", decks.get(1)),
                new GameSession.SeatSpec(2, false, "Blair", decks.get(2))), 30_000, frames::add);
        for (JsonElement e : g[0].createdFrame().getAsJsonArray("players")) {
            JsonObject p = e.getAsJsonObject();
            playerIdBySeat[p.get("seat").getAsInt()] = p.get("playerId").getAsInt();
        }
        g[0].begin(startingSeat);
        try {
            long deadline = System.currentTimeMillis() + 120_000;
            while (System.currentTimeMillis() < deadline) {
                JsonObject f = frames.poll(1, TimeUnit.SECONDS);
                if (f == null) continue;
                String type = f.has("type") ? f.get("type").getAsString() : "";
                if (type.equals("state") && f.has("turn") && f.get("turn").getAsInt() >= 1 && f.has("activePlayer") && !f.get("activePlayer").isJsonNull()) {
                    return f.get("activePlayer").getAsInt();
                }
                if (!type.equals("prompt") || f.get("seat").getAsInt() != 0) continue;
                String title = f.has("title") && !f.get("title").isJsonNull() ? f.get("title").getAsString() : "";
                assertFalse(title.contains("plays first"), "nobody is asked who plays first: " + f);
                JsonObject a = new JsonObject();
                a.add("promptId", f.get("promptId"));
                String kind = f.get("prompt").getAsString();
                if (kind.equals("mulligan")) a.addProperty("keep", true);
                else if (kind.equals("choose") || kind.equals("confirm")) a.addProperty("option", 0);
                else if (kind.equals("chooseMany")) a.add("options", new com.google.gson.JsonArray());
                g[0].answer(0, a);
            }
            throw new AssertionError("turn 1 never began");
        } finally {
            // ending a running game from another thread must not deadlock with the game thread (it did, 2026-10-20)
            g[0].end();
            long until = System.currentTimeMillis() + 60_000;
            while (!g[0].isOver() && System.currentTimeMillis() < until) Thread.sleep(50);
            assertTrue(g[0].isOver(), "the game thread finished after end()");
        }
    }

    @Test
    void theTablesStartingSeatTakesTurnOneWhoeverForgeFlippedFor() throws Exception {
        int[] ids = new int[3];
        // every seat, a human and two Forge AI seats, over seeds whose own flip differs
        for (int seat = 0; seat < 3; seat++) {
            for (long seed : new long[] {3L, 8L}) {
                int active = firstTurnPlayer(seed, seat, ids);
                assertEquals(ids[seat], active, "seat " + seat + " (seed " + seed + ") takes turn 1");
            }
        }
    }

    @Test
    void aDeferredGameWaitsForBeginAndCanBeEndedBeforeIt() throws Exception {
        LinkedBlockingQueue<JsonObject> frames = new LinkedBlockingQueue<>();
        GameSession g = new GameSession("deferred", 5L, List.of(
                new GameSession.SeatSpec(0, false, "A", decks.get(0)),
                new GameSession.SeatSpec(1, false, "B", decks.get(1))), 30_000, frames::add);
        Thread.sleep(300);
        assertFalse(g.hasBegun());
        assertTrue(frames.isEmpty(), "nothing is played before beginGame");
        assertThrows(IllegalArgumentException.class, () -> g.begin(7), "an empty seat cannot start");
        g.end();
        assertTrue(g.isOver(), "ending during the roll needs no game thread");
        assertThrows(IllegalStateException.class, () -> g.begin(0));
    }
}
