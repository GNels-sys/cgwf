package cgwf.engine;

import cgwf.engine.bridge.BridgeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The seat's auto-pass rules (stops, respond, "end turn", auto-pass when nothing, hold): pure, no Forge needed. */
class BridgeSessionTest {
    private static JsonObject stops(boolean respond, boolean autoPassEmpty, String... mine) {
        JsonObject j = new JsonObject();
        JsonArray m = new JsonArray();
        for (String s : mine) m.add(s);
        j.add("myTurn", m);
        j.add("theirTurn", new JsonArray());
        j.addProperty("respond", respond);
        j.addProperty("autoPassEmpty", autoPassEmpty);
        return j;
    }

    @Test
    void defaultsStopAtMainPhasesAndRespond() {
        BridgeSession s = new BridgeSession(0, 1000);
        assertTrue(s.stopsAt("MAIN1", true, false, 3));
        assertFalse(s.stopsAt("UPKEEP", true, false, 3));
        assertTrue(s.stopsAt("END_OF_TURN", false, false, 3));
        assertFalse(s.stopsAt("MAIN1", false, false, 3));
        assertTrue(s.stopsAt("UPKEEP", false, true, 3), "someone else's spell on the stack always stops");
        assertTrue(s.autoPassesEmpty(3));
        assertTrue(s.stops().toJson().get("autoPassEmpty").getAsBoolean());
    }

    @Test
    void holdStopsEverywhereAndOverridesEndTurnAndAutoPass() {
        BridgeSession s = new BridgeSession(0, 1000);
        s.setStops(stops(false, true, "MAIN1"));
        s.passUntilTurn(4);
        assertFalse(s.stopsAt("MAIN1", true, false, 4), "end turn passes the rest of the turn");
        s.setHold(4);
        assertTrue(s.stopsAt("UPKEEP", true, false, 4));
        assertTrue(s.stopsAt("DRAW", false, false, 4));
        assertFalse(s.autoPassesEmpty(4), "holding means no automatic pass even with nothing to do");
        assertTrue(s.holding(4));
        // the next turn: the hold is gone, ordinary stops again
        assertFalse(s.stopsAt("UPKEEP", true, false, 5));
        assertFalse(s.holding(5));
        assertEquals(0, s.holdTurn());
        assertTrue(s.autoPassesEmpty(5));
        // release early
        s.setHold(6);
        s.setHold(0);
        assertFalse(s.stopsAt("UPKEEP", true, false, 6));
        // whichever came last wins: an explicit "end turn" releases a hold ...
        s.setHold(7);
        s.passUntilTurn(7);
        assertFalse(s.holding(7));
        assertFalse(s.stopsAt("MAIN2", true, false, 7));
        // ... and a hold cancels an "end turn"
        s.passUntilTurn(8);
        s.setHold(8);
        assertTrue(s.stopsAt("MAIN2", true, false, 8));
    }

    @Test
    void autoPassEmptyCanBeSwitchedOff() {
        BridgeSession s = new BridgeSession(0, 1000);
        s.setStops(stops(true, false, "MAIN1"));
        assertFalse(s.autoPassesEmpty(2));
        assertTrue(s.stopsAt("MAIN1", true, false, 2));
    }
}
