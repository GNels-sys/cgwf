package cgwf.engine;

import cgwf.engine.bridge.CastReplay;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Repeating a recorded cast: answers are re-expressed against the new prompt's options by name (pure, no Forge). */
class CastReplayTest {
    private static JsonObject prompt(String kind, String title, String reason, String... names) {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", kind);
        p.addProperty("title", title);
        if (reason != null) p.addProperty("reason", reason);
        JsonArray opts = new JsonArray();
        for (int i = 0; i < names.length; i++) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", "card");
            o.addProperty("index", i);
            o.addProperty("name", names[i]);
            o.addProperty("cardId", 100 + i);
            opts.add(o);
        }
        p.add("options", opts);
        return p;
    }

    private static JsonObject many(int... picks) {
        JsonObject a = new JsonObject();
        JsonArray arr = new JsonArray();
        for (int i : picks) arr.add(i);
        a.add("options", arr);
        a.addProperty("promptId", 7);
        return a;
    }

    private static int[] options(JsonObject a) {
        JsonArray arr = a.getAsJsonArray("options");
        int[] out = new int[arr.size()];
        for (int i = 0; i < arr.size(); i++) out[i] = arr.get(i).getAsInt();
        return out;
    }

    private static CastReplay.Recording sproutSwarm() {
        CastReplay.Recording rec = new CastReplay.Recording("Sprout Swarm", "Hand");
        rec.steps().add(new CastReplay.Step(prompt("chooseMany", "Optional costs for Sprout Swarm", "optionalCosts", "Buyback {3}"), many(0)));
        rec.steps().add(new CastReplay.Step(prompt("chooseMany", "Convoke: tap creatures to help pay {4}{G}", "convoke", "Saproling", "Saproling", "Llanowar Elves", "Saproling"), many(0, 1, 3)));
        return rec;
    }

    @Test
    void repeatsOptionalCostsAndConvokeByNameAgainstNewOptions() {
        CastReplay r = new CastReplay(sproutSwarm(), 3);
        assertTrue(r.active());
        // the buyback label is the same, at the same index
        JsonObject a1 = r.answerFor(prompt("chooseMany", "Optional costs for Sprout Swarm", "optionalCosts", "Buyback {3}"));
        assertArrayEquals(new int[] {0}, options(a1));
        // the saprolings tapped last time are tapped now; three new ones sit at other indices, the elf is skipped
        JsonObject a2 = r.answerFor(prompt("chooseMany", "Convoke: tap creatures to help pay {4}{G}", "convoke", "Llanowar Elves", "Saproling", "Saproling", "Saproling", "Saproling"));
        assertArrayEquals(new int[] {1, 2, 3}, options(a2));
        r.castDone();
        assertEquals(1, r.done());
        assertTrue(r.active());
        // the cursor is back at the start for the next cast
        assertArrayEquals(new int[] {0}, options(r.answerFor(prompt("chooseMany", "Optional costs for Sprout Swarm", "optionalCosts", "Buyback {3}"))));
    }

    @Test
    void convokeFillsFromOtherCreaturesWhenTheNamesRunShort() {
        CastReplay r = new CastReplay(sproutSwarm(), 2);
        r.answerFor(prompt("chooseMany", "Optional costs for Sprout Swarm", "optionalCosts", "Buyback {3}"));
        // only one Saproling untapped: it takes the elf and the bear to make up the three
        JsonObject a = r.answerFor(prompt("chooseMany", "Convoke: tap creatures to help pay {4}{G}", "convoke", "Grizzly Bears", "Saproling", "Llanowar Elves"));
        assertArrayEquals(new int[] {1, 0, 2}, options(a));
        // fewer creatures than recorded: as many as there are
        JsonObject b = r.answerFor(prompt("chooseMany", "Convoke: tap creatures to help pay {4}{G}", "convoke", "Saproling"));
        assertArrayEquals(new int[] {0}, options(b));
    }

    @Test
    void aMissingTargetCannotBeRepeated() {
        CastReplay.Recording rec = new CastReplay.Recording("Lightning Bolt", "Hand");
        rec.steps().add(new CastReplay.Step(prompt("targets", "Choose targets for Lightning Bolt", null, "Grizzly Bears", "Blair"), many(0)));
        CastReplay r = new CastReplay(rec, 5);
        assertArrayEquals(new int[] {1}, options(r.answerFor(prompt("targets", "Choose targets for Lightning Bolt", null, "Blair", "Grizzly Bears"))));
        r.castDone();
        assertNull(r.answerFor(prompt("targets", "Choose targets for Lightning Bolt", null, "Blair")), "the bear is gone: no answer, the seat is asked");
        assertNull(r.answerFor(prompt("confirm", "Something else entirely", null)), "a prompt the cast never had");
        r.stop("could not repeat");
        assertFalse(r.active());
        assertFalse(r.finished());
        assertEquals("could not repeat", r.stopReason());
    }

    @Test
    void numbersConfirmsAndSingleChoicesCopyThrough() {
        CastReplay.Recording rec = new CastReplay.Recording("Fireball", "Hand");
        JsonObject x = new JsonObject();
        x.addProperty("value", 7);
        x.addProperty("promptId", 3);
        rec.steps().add(new CastReplay.Step(prompt("number", "Choose X for Fireball", null), x));
        JsonObject yes = new JsonObject();
        yes.addProperty("option", 0);
        rec.steps().add(new CastReplay.Step(prompt("confirm", "Pay 2 life?", null), yes));
        JsonObject none = new JsonObject();
        none.add("option", null);
        rec.steps().add(new CastReplay.Step(prompt("choose", "Pick one", null, "A", "B"), none));
        CastReplay r = new CastReplay(rec, 1);
        JsonObject ax = r.answerFor(prompt("number", "Choose X for Fireball", null));
        assertEquals(7, ax.get("value").getAsInt());
        assertFalse(ax.has("promptId"));
        assertEquals(0, r.answerFor(prompt("confirm", "Pay 2 life?", null)).get("option").getAsInt());
        assertTrue(r.answerFor(prompt("choose", "Pick one", null, "B", "A")).get("option").isJsonNull());
        r.castDone();
        assertTrue(r.finished());
        assertEquals(1, r.done());
    }

    @Test
    void timesAreClamped() {
        assertEquals(1, new CastReplay(sproutSwarm(), 0).wanted());
        assertEquals(CastReplay.MAX_TIMES, new CastReplay(sproutSwarm(), 10_000).wanted());
    }

    private static void assertArrayEquals(int[] expected, int[] actual) {
        org.junit.jupiter.api.Assertions.assertArrayEquals(expected, actual);
    }
}
