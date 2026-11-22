package cgwf.engine;

import cgwf.engine.bridge.BridgeSession;
import cgwf.engine.bridge.CastReplay;
import cgwf.engine.bridge.LoopReplay;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Spotting and running a loop (pure, no Forge). The round is the owner's of 2026-11-21: order three triggers,
 * pick the opponent Enduring Tenacity drains, pay life to draw.
 */
class LoopReplayTest {
    private static final String[] TRIGGERS = {"Enduring Tenacity", "Ajani Resolute", "Niv-Mizzet"};

    private static JsonObject list(String kind, String title, String key, String... names) {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", kind);
        p.addProperty("title", title);
        JsonArray opts = new JsonArray();
        for (int i = 0; i < names.length; i++) {
            JsonObject o = new JsonObject();
            o.addProperty("index", i);
            o.addProperty("name", names[i]);
            opts.add(o);
        }
        p.add(key, opts);
        return p;
    }

    private static JsonObject order(String... names) { return list("order", "Order the triggers", "items", names); }
    private static JsonObject targets(String... names) { return list("targets", "Choose targets for Enduring Tenacity", "options", names); }

    private static JsonObject confirm() {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", "confirm");
        p.addProperty("title", "Pay 1 life?");
        JsonArray labels = new JsonArray(); // as the engine sends them: two plain strings
        labels.add("Yes");
        labels.add("No");
        p.add("options", labels);
        return p;
    }

    private static JsonObject priority() {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", "priority");
        p.addProperty("title", "You have priority");
        return p;
    }

    private static JsonObject ints(String key, int... values) {
        JsonObject a = new JsonObject();
        JsonArray arr = new JsonArray();
        for (int v : values) arr.add(v);
        a.add(key, arr);
        a.addProperty("promptId", 9);
        return a;
    }

    private static JsonObject yes() {
        JsonObject a = new JsonObject();
        a.addProperty("confirm", true);
        return a;
    }

    private static JsonObject option(Integer index) {
        JsonObject a = new JsonObject();
        if (index == null) a.add("option", null);
        else a.addProperty("option", index);
        return a;
    }

    private static void round(LoopReplay.Watch w, int target) {
        w.add(order(TRIGGERS), ints("order", 0, 1, 2));
        w.add(targets("Daretti bot", "Captain bot", "Nethroi bot"), ints("options", target));
        w.add(confirm(), yes());
    }

    @Test
    void aRoundAnsweredTheSameWayTwiceIsOfferedWhenItStartsAgain() {
        LoopReplay.Watch w = new LoopReplay.Watch();
        round(w, 0);
        assertNull(w.cycleFor(order(TRIGGERS)), "once is not a loop");
        round(w, 0);
        List<CastReplay.Step> cycle = w.cycleFor(order(TRIGGERS));
        assertNotNull(cycle, "twice in a row is");
        assertEquals(3, cycle.size());
        assertEquals(2, w.rounds(3));
        assertNull(w.cycleFor(confirm()), "only offered on the round's first question");
        JsonObject offer = LoopReplay.offerJson(cycle, w.rounds(cycle.size()));
        assertEquals(3, offer.get("steps").getAsInt());
        assertEquals(2, offer.get("seen").getAsInt());
        assertEquals(LoopReplay.MAX_TIMES, offer.get("max").getAsInt());
        assertEquals("Order the triggers", offer.getAsJsonArray("titles").get(0).getAsString());
        assertFalse(offer.get("key").getAsString().isEmpty());
    }

    @Test
    void aDifferentAnswerOrAnythingElseDoneInBetweenIsNotALoop() {
        LoopReplay.Watch w = new LoopReplay.Watch();
        round(w, 0);
        round(w, 1); // another target: not the same round
        assertNull(w.cycleFor(order(TRIGGERS)));

        w.clear();
        round(w, 0);
        w.add(priority(), option(null)); // letting it resolve is part of any loop
        round(w, 0);
        assertNotNull(w.cycleFor(order(TRIGGERS)));

        w.clear();
        round(w, 0);
        w.add(priority(), option(2)); // playing something breaks the run
        round(w, 0);
        assertNull(w.cycleFor(order(TRIGGERS)));

        w.clear();
        round(w, 0);
        w.scope("7:UPKEEP"); // another turn or phase starts over
        round(w, 0);
        assertNull(w.cycleFor(order(TRIGGERS)));
    }

    @Test
    void aSingleQuestionNeedsThreeInARow() {
        LoopReplay.Watch w = new LoopReplay.Watch();
        w.add(confirm(), yes());
        w.add(confirm(), yes());
        assertNull(w.cycleFor(confirm()));
        w.add(confirm(), yes());
        List<CastReplay.Step> cycle = w.cycleFor(confirm());
        assertNotNull(cycle);
        assertEquals(1, cycle.size());
    }

    private static LoopReplay loop(int times, int library) {
        LoopReplay.Watch w = new LoopReplay.Watch();
        round(w, 0);
        round(w, 0);
        return new LoopReplay(w.cycleFor(order(TRIGGERS)), times, library);
    }

    @Test
    void theRoundIsAnsweredByNameForAsManyTimesAsAsked() {
        LoopReplay l = loop(2, -1);
        // the triggers come in another order this time: the answer follows the names
        JsonObject o = l.answerFor(order("Niv-Mizzet", "Enduring Tenacity", "Ajani Resolute"));
        assertEquals("[1,2,0]", o.getAsJsonArray("order").toString());
        // the players are listed differently: still Daretti
        JsonObject t = l.answerFor(targets("Captain bot", "Daretti bot", "Nethroi bot"));
        assertEquals("[1]", t.getAsJsonArray("options").toString());
        assertTrue(l.answerFor(confirm()).get("confirm").getAsBoolean());
        assertEquals(1, l.done());
        assertTrue(l.active());
        assertNotNull(l.answerFor(order(TRIGGERS)));
        assertNotNull(l.answerFor(targets("Daretti bot", "Captain bot", "Nethroi bot")));
        assertNotNull(l.answerFor(confirm()));
        assertEquals(2, l.done());
        assertFalse(l.active());
        assertTrue(l.finished());
        assertEquals("The loop ran 2 times.", l.summary());
        assertNull(l.answerFor(order(TRIGGERS)), "over: the seat answers");
    }

    @Test
    void aChoiceThatIsGonePausesTheLoopAndTheNewAnswerTakesItsPlace() {
        LoopReplay l = loop(500, -1);
        assertNotNull(l.answerFor(order(TRIGGERS)));
        JsonObject left = targets("Captain bot", "Nethroi bot"); // Daretti is out of the game
        assertNull(l.answerFor(left));
        assertTrue(l.active(), "paused, not over");
        assertEquals("Daretti bot is no longer a choice", l.pauseReason());
        assertEquals(500, l.pausedJson().get("left").getAsInt());
        l.resume(left, ints("options", 1)); // Nethroi from now on
        assertNull(l.pauseReason());
        assertNotNull(l.answerFor(confirm()));
        assertEquals(1, l.done());
        assertNotNull(l.answerFor(order(TRIGGERS)));
        JsonObject t = l.answerFor(targets("Nethroi bot", "Captain bot"));
        assertEquals("[0]", t.getAsJsonArray("options").toString());
    }

    @Test
    void anotherQuestionEndsTheLoop() {
        LoopReplay l = loop(500, -1);
        assertNotNull(l.answerFor(order(TRIGGERS)));
        JsonObject other = list("choose", "Choose a creature to sacrifice", "options", "Bloodthirsty Conqueror");
        assertNull(l.answerFor(other));
        assertFalse(l.active());
        assertTrue(l.stopReason().contains("a different question came up"));
        assertTrue(l.summary().startsWith("The loop ran 0 times; it stopped because a different question came up"));
    }

    @Test
    void anEmptyLibraryEndsALoopThatStartedWithCards() {
        LoopReplay l = loop(500, 12);
        JsonObject p = order(TRIGGERS);
        JsonObject view = new JsonObject();
        view.addProperty("viewer", 3);
        JsonArray players = new JsonArray();
        JsonObject me = new JsonObject();
        me.addProperty("id", 3);
        me.addProperty("libraryCount", 0);
        players.add(me);
        view.add("players", players);
        p.add("view", view);
        assertNull(l.answerFor(p));
        assertFalse(l.active());
        assertEquals("your library is empty", l.stopReason());
    }

    /** The session's side: the offer rides on the prompt, {loop: N} runs it, a paused question can stop it. */
    @Test
    void theSessionOffersTheLoopRunsItPausesAndStopsOnRequest() {
        BridgeSession session = new BridgeSession(0, 5_000);
        List<JsonObject> asked = new ArrayList<>();
        List<String> notices = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        List<String> log = new ArrayList<>();
        AtomicReference<Function<JsonObject, JsonObject>> script = new AtomicReference<>();
        session.setLoopLog(log::add);
        session.attach(frame -> {
            String type = frame.get("type").getAsString();
            if ("notice".equals(type)) notices.add(frame.get("text").getAsString());
            if ("error".equals(type)) errors.add(frame.get("message").getAsString());
            if (!"prompt".equals(type)) return;
            asked.add(frame.deepCopy());
            JsonObject a = script.get().apply(frame);
            a.add("promptId", frame.get("promptId"));
            session.answer(a);
        });
        Function<JsonObject, JsonObject> byHand = p -> switch (p.get("prompt").getAsString()) {
            case "order" -> ints("order", 0, 1, 2);
            case "targets" -> ints("options", 0);
            default -> yes();
        };
        script.set(byHand);
        for (int i = 0; i < 2; i++) {
            session.ask(order(TRIGGERS));
            session.ask(targets("Daretti bot", "Captain bot", "Nethroi bot"));
            session.ask(confirm());
        }
        assertEquals(6, asked.size());
        for (JsonObject p : asked) assertFalse(p.has("loop"), "no offer during the first two rounds");

        // an answer that asks for a loop nobody offered is refused and the question asked again
        script.set(p -> {
            if (errors.isEmpty()) {
                JsonObject a = new JsonObject();
                a.addProperty("loop", 5);
                return a;
            }
            return byHand.apply(p);
        });
        // (a different question, so no offer rides on it)
        JsonObject stray = session.ask(list("choose", "Choose a card", "options", "Swamp"));
        assertEquals(1, errors.size());
        assertFalse(stray.has("loop"));
        assertEquals(8, asked.size());

        // two fresh rounds, then the third one starts: the offer, and three rounds asked for
        script.set(byHand);
        for (int i = 0; i < 2; i++) {
            session.ask(order(TRIGGERS));
            session.ask(targets("Daretti bot", "Captain bot", "Nethroi bot"));
            session.ask(confirm());
        }
        int before = asked.size();
        script.set(p -> {
            assertTrue(p.has("loop"), "the offer rides on the round's first question");
            JsonObject a = new JsonObject();
            a.addProperty("loop", 3);
            return a;
        });
        JsonObject first = session.ask(order(TRIGGERS));
        assertEquals("[0,1,2]", first.getAsJsonArray("order").toString(), "the engine answers the offered question itself");
        assertNotNull(session.loop());
        script.set(p -> { throw new AssertionError("the loop answers; nobody is asked: " + p.get("title")); });
        assertEquals("[0]", session.ask(targets("Daretti bot", "Captain bot", "Nethroi bot")).getAsJsonArray("options").toString());
        assertTrue(session.ask(confirm()).get("confirm").getAsBoolean());
        assertNotNull(session.ask(order(TRIGGERS)));
        assertEquals(before + 1, asked.size(), "one question (the offer) for a round and a half");

        // Daretti is out: that one question goes to the seat, marked paused; the seat stops the loop with its answer
        script.set(p -> {
            assertTrue(p.has("loopPaused"));
            assertEquals("Daretti bot is no longer a choice", p.getAsJsonObject("loopPaused").get("reason").getAsString());
            JsonObject a = ints("options", 1);
            a.addProperty("stopLoop", true);
            return a;
        });
        JsonObject manual = session.ask(targets("Captain bot", "Nethroi bot"));
        assertEquals("[1]", manual.getAsJsonArray("options").toString());
        assertNull(session.loop());
        assertEquals(List.of("The loop ran 1 time; it stopped because you stopped it."), notices);
        assertEquals(List.of("runs a loop of 3 choices, up to 3 times.", "ran a loop 1 time."), log);
    }

    private static List<CastReplay.Step> yesThreeTimes() {
        LoopReplay.Watch w = new LoopReplay.Watch();
        for (int i = 0; i < 3; i++) w.add(confirm(), yes());
        return w.cycleFor(confirm());
    }

    private static JsonObject confirmWithLibrary(int cards) {
        JsonObject p = confirm();
        JsonObject view = new JsonObject();
        view.addProperty("viewer", 3);
        JsonArray players = new JsonArray();
        JsonObject me = new JsonObject();
        me.addProperty("id", 3);
        me.addProperty("libraryCount", cards);
        players.add(me);
        view.add("players", players);
        p.add("view", view);
        return p;
    }

    /** Owner, 2026-11-21: "a response to X amount of triggers to do one thing and the rest to do another". */
    @Test
    void aYesNoRoundCanBeAnsweredOneWayForSomeRoundsAndTheOtherWayForTheRest() {
        List<CastReplay.Step> cycle = yesThreeTimes();
        JsonObject offer = LoopReplay.offerJson(cycle, 3);
        assertEquals("Yes", offer.getAsJsonObject("flip").get("now").getAsString());
        assertEquals("No", offer.getAsJsonObject("flip").get("then").getAsString());

        LoopReplay l = new LoopReplay(cycle, 2, -1);
        l.thenOther();
        assertTrue(l.answerFor(confirm()).get("confirm").getAsBoolean());
        assertFalse(l.flipped());
        assertTrue(l.answerFor(confirm()).get("confirm").getAsBoolean());
        assertTrue(l.flipped(), "the two rounds asked for are done: the other answer from here");
        assertTrue(l.active());
        for (int i = 0; i < 3; i++) assertFalse(l.answerFor(confirm()).get("confirm").getAsBoolean());
        l.stop("nothing was left on the stack");
        assertEquals("The loop answered \"Yes\" 2 times, then \"No\" 3 times; it stopped because nothing was left on the stack.", l.summary());
    }

    @Test
    void onlyASingleYesNoQuestionHasAnOtherAnswer() {
        LoopReplay.Watch w = new LoopReplay.Watch();
        round(w, 0);
        round(w, 0);
        List<CastReplay.Step> cycle = w.cycleFor(order(TRIGGERS));
        assertFalse(LoopReplay.offerJson(cycle, 2).has("flip"));
        LoopReplay l = new LoopReplay(cycle, 1, -1);
        l.thenOther(); // ignored: three questions have no "other" answer
        l.answerFor(order(TRIGGERS));
        l.answerFor(targets("Daretti bot", "Captain bot", "Nethroi bot"));
        l.answerFor(confirm());
        assertTrue(l.finished());
        assertFalse(l.flipped());
    }

    @Test
    void aRoundThatWouldDrawMoreCardsThanAreLeftEndsTheLoop() {
        LoopReplay l = new LoopReplay(yesThreeTimes(), 500, 7);
        assertNotNull(l.answerFor(confirmWithLibrary(7)));
        assertNotNull(l.answerFor(confirmWithLibrary(5)), "each round draws two");
        assertNotNull(l.answerFor(confirmWithLibrary(3)));
        assertNull(l.answerFor(confirmWithLibrary(1)), "one card left, two would be drawn");
        assertFalse(l.active());
        assertEquals("your library has only 1 card left", l.stopReason());
    }
}
