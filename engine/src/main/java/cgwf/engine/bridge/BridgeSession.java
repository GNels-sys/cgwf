package cgwf.engine.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.game.player.Player;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * One human seat's link to the outside world. The game thread calls {@link #ask} and blocks;
 * the control socket thread calls {@link #answer}. When nobody answers (seat marked absent,
 * timeout) {@code ask} returns null and the controller falls back to the Forge AI, so a game never
 * hangs on a missing player. The session also keeps the seat's auto-pass stops and the prompt
 * currently open, so a reconnecting client can be shown it again (resync).
 */
public final class BridgeSession {
    /** Frames leave through here; the owner decorates them with gameId/seat before they hit the wire. */
    public interface Transport { void send(JsonObject frame); }

    /** Arena-style stops: at which steps this seat wants priority offered instead of auto-passed. */
    public static final class Stops {
        final Set<String> myTurn = new HashSet<>();
        final Set<String> theirTurn = new HashSet<>();
        /** Stop whenever the top of the stack was put there by someone else. */
        boolean respond = true;

        static Stops defaults() {
            Stops s = new Stops();
            s.myTurn.add("MAIN1");
            s.myTurn.add("COMBAT_DECLARE_ATTACKERS");
            s.myTurn.add("MAIN2");
            s.myTurn.add("END_OF_TURN");
            s.theirTurn.add("END_OF_TURN");
            return s;
        }

        static Stops parse(JsonObject j) {
            Stops s = new Stops();
            if (j == null) return defaults();
            fill(s.myTurn, j.get("myTurn"));
            fill(s.theirTurn, j.get("theirTurn"));
            s.respond = !j.has("respond") || j.get("respond").isJsonNull() || j.get("respond").getAsBoolean();
            return s;
        }

        private static void fill(Set<String> into, JsonElement arr) {
            if (arr == null || !arr.isJsonArray()) return;
            for (JsonElement e : (JsonArray) arr) into.add(e.getAsString().toUpperCase(Locale.ROOT));
        }

        public JsonObject toJson() {
            JsonObject j = new JsonObject();
            JsonArray a = new JsonArray();
            for (String s : myTurn) a.add(s);
            JsonArray b = new JsonArray();
            for (String s : theirTurn) b.add(s);
            j.add("myTurn", a);
            j.add("theirTurn", b);
            j.addProperty("respond", respond);
            return j;
        }
    }

    private final int seat;
    private final long timeoutMs;
    private final AtomicInteger seq = new AtomicInteger();
    private final Object lock = new Object();
    private volatile Transport transport;
    private volatile Function<Player, JsonObject> viewBuilder;
    private volatile Runnable beforeAsk;
    private CompletableFuture<JsonObject> pending;
    private int pendingId = -1;
    private volatile JsonObject openPrompt;
    private volatile boolean absent;
    private volatile boolean concedeRequested;
    private volatile Stops stops = Stops.defaults();
    /** Pass every priority until the given turn number is over (0 = off). */
    private volatile int passUntilTurn;

    public BridgeSession(int seat, long timeoutMs) {
        this.seat = seat;
        this.timeoutMs = timeoutMs;
    }

    public int seat() { return seat; }

    public void attach(Transport t) { this.transport = t; }

    public void setViewBuilder(Function<Player, JsonObject> builder) { this.viewBuilder = builder; }

    /** Called right before a prompt goes out, so observers get a fresh state first. */
    public void setBeforeAsk(Runnable r) { this.beforeAsk = r; }

    public JsonObject viewFor(Player p) {
        Function<Player, JsonObject> b = viewBuilder;
        return b == null ? new JsonObject() : b.apply(p);
    }

    public void send(JsonObject msg) {
        Transport t = transport;
        if (t != null) t.send(msg);
    }

    public void sendError(String text, int promptId) {
        JsonObject j = new JsonObject();
        j.addProperty("type", "error");
        j.addProperty("message", text);
        if (promptId > 0) j.addProperty("promptId", promptId);
        send(j);
    }

    public void sendError(String text) { sendError(text, -1); }

    /** Sends a prompt and waits for the answer. Null = nobody answered (fall back to AI). */
    public JsonObject ask(JsonObject prompt) {
        if (absent) return null;
        Runnable pre = beforeAsk;
        if (pre != null) pre.run();
        CompletableFuture<JsonObject> f = new CompletableFuture<>();
        int id = seq.incrementAndGet();
        synchronized (lock) {
            pending = f;
            pendingId = id;
        }
        prompt.addProperty("type", "prompt");
        prompt.addProperty("promptId", id);
        openPrompt = prompt;
        send(prompt);
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            sendError("no answer in time; the AI decided for you", id);
            return null;
        } catch (ExecutionException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } finally {
            synchronized (lock) {
                if (pendingId == id) { pending = null; pendingId = -1; }
            }
            if (openPrompt == prompt) openPrompt = null;
        }
    }

    /** The prompt this seat has not answered yet, for resync; null when none. */
    public JsonObject openPrompt() { return openPrompt; }

    public void answer(JsonObject msg) {
        int id = msg.has("promptId") && !msg.get("promptId").isJsonNull() ? msg.get("promptId").getAsInt() : -1;
        synchronized (lock) {
            if (pending != null && pendingId == id) {
                pending.complete(msg);
            } else {
                sendError("no open prompt with promptId " + id + (pendingId > 0 ? " (open: " + pendingId + ")" : ""), id);
            }
        }
    }

    /** Seat gone (socket closed and grace over): pending and future prompts go to the AI until it is back. */
    public void setAbsent(boolean value) {
        absent = value;
        if (value) {
            synchronized (lock) {
                if (pending != null) pending.complete(null);
            }
        }
    }

    public boolean isAbsent() { return absent; }

    public void requestConcede() {
        concedeRequested = true;
        synchronized (lock) {
            if (pending != null) {
                JsonObject j = new JsonObject();
                j.addProperty("concede", true);
                pending.complete(j);
            }
        }
    }

    public boolean concedeRequested() { return concedeRequested; }

    public void setStops(JsonObject j) { stops = Stops.parse(j); }

    public Stops stops() { return stops; }

    public void passUntilTurn(int turn) { passUntilTurn = turn; }

    /**
     * Should this seat be offered priority now, or pass automatically?
     * Always stops when the stack holds something the seat did not put there (if `respond`).
     */
    public boolean stopsAt(String phase, boolean myTurn, boolean stackTopNotMine, int turn) {
        if (passUntilTurn > 0 && turn <= passUntilTurn) return false;
        if (passUntilTurn > 0) passUntilTurn = 0;
        Stops s = stops;
        if (stackTopNotMine && s.respond) return true;
        return (myTurn ? s.myTurn : s.theirTurn).contains(phase);
    }
}
