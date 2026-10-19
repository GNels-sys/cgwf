package cgwf.engine;

import cgwf.engine.bridge.GameSession;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The gameOver frame carries per-seat results for deck statistics: place (1 = winner, then in reverse
 * order of elimination), won, conceded and Forge's loss reason. A real two-seat game: the human keeps,
 * concedes at the first priority, and Forge's AI wins. Needs -Dforge.assets.
 */
class GameResultsTest {
    private static List<DeckLoader.Loaded> decks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)), "set -Dforge.assets to run");
        ForgeBoot.init(Path.of(assets), true);
        decks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 2);
    }

    @Test
    void aConcedeIsALossAndTheWinnerPlacesFirst() throws Exception {
        LinkedBlockingQueue<JsonObject> frames = new LinkedBlockingQueue<>();
        GameSession[] holder = new GameSession[1];
        GameSession session = new GameSession("results-test", 7L, List.of(
                new GameSession.SeatSpec(0, true, "Alex", decks.get(0)),
                new GameSession.SeatSpec(1, false, "Bot", decks.get(1))), 30_000, frames::add);
        holder[0] = session;
        session.start();
        JsonObject over = null;
        boolean conceded = false;
        long deadline = System.currentTimeMillis() + 180_000;
        while (over == null && System.currentTimeMillis() < deadline) {
            JsonObject f = frames.poll(1, TimeUnit.SECONDS);
            if (f == null) continue;
            String type = f.has("type") ? f.get("type").getAsString() : "";
            if (type.equals("gameOver")) { over = f; break; }
            if (!type.equals("prompt") || f.get("seat").getAsInt() != 0) continue;
            JsonObject a = new JsonObject();
            a.add("promptId", f.get("promptId"));
            String kind = f.get("prompt").getAsString();
            if (kind.equals("mulligan")) a.addProperty("keep", true);
            else if (kind.equals("priority") && !conceded) { conceded = true; holder[0].concede(0); continue; }
            else if (kind.equals("choose") || kind.equals("confirm")) a.addProperty("option", 0);
            holder[0].answer(0, a);
        }
        assertNotNull(over, "the game finished");
        assertTrue(conceded, "the human reached a priority and conceded");
        Map<Integer, JsonObject> bySeat = new HashMap<>();
        for (JsonElement e : over.getAsJsonArray("results")) bySeat.put(e.getAsJsonObject().get("seat").getAsInt(), e.getAsJsonObject());
        JsonObject human = bySeat.get(0);
        JsonObject bot = bySeat.get(1);
        assertTrue(human.get("conceded").getAsBoolean(), over.toString());
        assertFalse(human.get("won").getAsBoolean());
        assertEquals(2, human.get("place").getAsInt());
        assertEquals("Conceded", human.get("lossReason").getAsString());
        assertTrue(bot.get("won").getAsBoolean(), over.toString());
        assertEquals(1, bot.get("place").getAsInt());
        assertEquals(1, over.get("winnerSeat").getAsInt());
    }
}
