package cgwf.engine;

import cgwf.engine.bridge.GameSession;
import cgwf.engine.bridge.OpeningHand;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The table's opening-hand rule (2026-10-20), through real games (GameSession, Forge's MulliganService):
 * Draw 7 with 0, 1 or 2 free London mulligans, and Draw 10 / put 3 back (no mulligans). Needs -Dforge.assets.
 */
class OpeningHandTest {
    private static List<DeckLoader.Loaded> decks;

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)), "set -Dforge.assets to run");
        ForgeBoot.init(Path.of(assets), true);
        decks = DeckLoader.loadDir(Path.of(System.getProperty("cgwf.decks", "spike/decks")), 3);
    }

    /** Krenko + 60 Leyline of the Void + 39 Mountain: a ten-card hand holds a Leyline (an opening-hand action). */
    private static DeckLoader.Loaded leylines() {
        return DeckLoader.build(new DeckLoader.DeckSpec("Leylines", null,
                List.of(new DeckLoader.CardRef("Krenko, Mob Boss", null, null, null, 1)),
                List.of(new DeckLoader.CardRef("Leyline of the Void", null, null, null, 60), new DeckLoader.CardRef("Mountain", null, null, null, 39))));
    }

    private static JsonArray firstN(int n) {
        JsonArray a = new JsonArray();
        for (int i = 0; i < n; i++) a.add(i);
        return a;
    }

    private static String reason(JsonObject p) { return p.has("reason") && !p.get("reason").isJsonNull() ? p.get("reason").getAsString() : ""; }

    private static void endAndWait(GameSession g) throws InterruptedException {
        g.end();
        long until = System.currentTimeMillis() + 60_000;
        while (!g.isOver() && System.currentTimeMillis() < until) Thread.sleep(50);
        assertTrue(g.isOver(), "the game thread finished");
    }

    /** Mulligan twice, then keep: the bottom counts asked and the hand kept, for this many free mulligans. */
    private static void mulliganTwice(int free) throws Exception {
        LinkedBlockingQueue<JsonObject> frames = new LinkedBlockingQueue<>();
        GameSession g = new GameSession("mull-" + free, 21L + free, List.of(
                new GameSession.SeatSpec(0, true, "Alex", decks.get(0)),
                new GameSession.SeatSpec(1, false, "Bot", decks.get(1))), 30_000, frames::add, new OpeningHand(OpeningHand.Mode.DRAW7, free));
        g.begin(0);
        List<Integer> bottoms = new ArrayList<>();
        JsonObject kept = null;
        int asked = 0;
        try {
            long deadline = System.currentTimeMillis() + 120_000;
            while (kept == null && System.currentTimeMillis() < deadline) {
                JsonObject f = frames.poll(1, TimeUnit.SECONDS);
                if (f == null || !"prompt".equals(f.get("type").getAsString()) || f.get("seat").getAsInt() != 0) continue;
                JsonObject a = new JsonObject();
                a.add("promptId", f.get("promptId"));
                switch (f.get("prompt").getAsString()) {
                    case "mulligan" -> {
                        asked++;
                        assertEquals(free, f.get("freeMulligans").getAsInt(), "the prompt says how many are free");
                        if (asked <= 2) a.addProperty("keep", false);
                        else { a.addProperty("keep", true); kept = f; }
                    }
                    case "chooseMany" -> {
                        if ("mulligan".equals(reason(f))) {
                            assertEquals(f.get("min").getAsInt(), f.get("max").getAsInt());
                            bottoms.add(f.get("min").getAsInt());
                        }
                        a.add("options", firstN(f.get("min").getAsInt()));
                    }
                    default -> a.addProperty("option", 0);
                }
                g.answer(0, a);
            }
        } finally {
            endAndWait(g);
        }
        assertNotNull(kept, "the human kept after two mulligans");
        List<Integer> expected = new ArrayList<>();
        for (int m = 1; m <= 2; m++) if (m - free > 0) expected.add(m - free);
        assertEquals(expected, bottoms, free + " free: bottom counts per mulligan");
        assertEquals(7 - Math.max(0, 2 - free), kept.getAsJsonArray("hand").size(), free + " free: cards kept");
        assertEquals(2, kept.get("mulligans").getAsInt());
    }

    @Test
    void freeMulligansAreTheTablesZeroOneOrTwo() throws Exception {
        for (int free = 0; free <= OpeningHand.MAX_FREE; free++) mulliganTwice(free);
    }

    @Test
    void drawTenPutsThreeBackForEveryoneAtOnceWithNoMulligans() throws Exception {
        LinkedBlockingQueue<JsonObject> frames = new LinkedBlockingQueue<>();
        GameSession g = new GameSession("draw10", 33L, List.of(
                new GameSession.SeatSpec(0, true, "Alex", leylines()),
                new GameSession.SeatSpec(1, true, "Blair", decks.get(0)),
                new GameSession.SeatSpec(2, false, "Bot", decks.get(1))), 30_000, frames::add, OpeningHand.parse("draw10", null));
        g.begin(1);
        Map<Integer, JsonObject> putBack = new HashMap<>();
        Map<Integer, Set<Integer>> chosen = new HashMap<>();
        List<JsonObject> seen = new ArrayList<>();
        JsonObject openingHand = null;
        JsonObject firstState = null;
        try {
            long deadline = System.currentTimeMillis() + 120_000;
            while (firstState == null && System.currentTimeMillis() < deadline) {
                JsonObject f = frames.poll(1, TimeUnit.SECONDS);
                if (f == null) continue;
                seen.add(f);
                String type = f.get("type").getAsString();
                if (type.equals("state") && f.has("turn") && f.get("turn").getAsInt() >= 1 && f.get("seat").getAsInt() == 0) { firstState = f; break; }
                if (!type.equals("prompt")) continue;
                int seat = f.get("seat").getAsInt();
                String kind = f.get("prompt").getAsString();
                assertFalse(kind.equals("mulligan"), "no mulligan question in Draw 10");
                if (kind.equals("chooseMany") && "putBack".equals(reason(f))) {
                    assertEquals(3, f.get("min").getAsInt());
                    assertEquals(3, f.get("max").getAsInt());
                    assertEquals(10, f.getAsJsonArray("options").size(), "the seat chooses from its own ten");
                    putBack.put(seat, f);
                    if (putBack.size() < 2) continue; // hold the first answer: the other human must be asked meanwhile
                    for (Map.Entry<Integer, JsonObject> e : putBack.entrySet()) {
                        JsonObject p = e.getValue();
                        Set<Integer> ids = new HashSet<>();
                        JsonArray opts = p.getAsJsonArray("options");
                        for (int i = 7; i < 10; i++) ids.add(opts.get(i).getAsJsonObject().get("id").getAsInt());
                        chosen.put(e.getKey(), ids);
                        JsonObject a = new JsonObject();
                        a.add("promptId", p.get("promptId"));
                        JsonArray last3 = new JsonArray();
                        last3.add(7);
                        last3.add(8);
                        last3.add(9);
                        a.add("options", last3);
                        g.answer(e.getKey(), a);
                    }
                    continue;
                }
                JsonObject a = new JsonObject();
                a.add("promptId", f.get("promptId"));
                if (kind.equals("chooseMany")) {
                    if ("openingHand".equals(reason(f)) && seat == 0) openingHand = f;
                    a.add("options", firstN(f.get("min").getAsInt()));
                } else if (kind.equals("priority")) {
                    a.add("option", null);
                } else {
                    a.addProperty("option", 0);
                }
                g.answer(seat, a);
            }
        } finally {
            endAndWait(g);
        }
        assertEquals(Set.of(0, 1), putBack.keySet(), "both humans were asked, at the same time");
        assertNotNull(firstState, "turn 1 began");
        // the opening-hand action (Leyline of the Void) was offered after the put-back, from the seven kept
        assertNotNull(openingHand, "Leyline of the Void was offered from the opening hand");
        // every player kept seven (Alex's Leylines may have gone onto the battlefield; turn 1 may have drawn one);
        // nothing went to a graveyard; the rest of the 99 is in the library
        for (JsonElement e : firstState.getAsJsonArray("players")) {
            JsonObject p = e.getAsJsonObject();
            int seat = p.get("seat").getAsInt();
            int bf = seat == 0 ? p.getAsJsonArray("battlefield").size() : 0;
            int held = p.get("handCount").getAsInt() + bf;
            assertTrue(held == 7 || held == 8, "seat " + seat + " kept seven: " + held);
            assertEquals(0, p.getAsJsonArray("graveyard").size(), "nothing went to a graveyard (seat " + seat + ")");
            assertEquals(99, p.get("libraryCount").getAsInt() + held, "seat " + seat + ": the three are back in the library");
        }
        // the three put back never appear again in any frame after the put-back (hidden in the library)
        boolean after = false;
        for (JsonObject f : seen) {
            if ("prompt".equals(f.get("type").getAsString()) && "putBack".equals(reason(f))) { after = true; continue; }
            if (!after) continue;
            String text = f.toString();
            for (Set<Integer> ids : chosen.values()) for (int id : ids) assertFalse(text.contains("\"id\":" + id + ","), "card " + id + " was put back and must stay hidden: " + f.get("type"));
        }
        boolean logged = false;
        for (JsonObject f : seen) if ("log".equals(f.get("type").getAsString()) && f.get("text").getAsString().equals("Alex put 3 cards back and shuffled.")) logged = true;
        assertTrue(logged, "the put-back is logged without naming a card");
    }
}
