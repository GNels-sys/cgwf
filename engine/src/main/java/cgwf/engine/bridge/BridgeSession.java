package cgwf.engine.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One human seat's link to the outside world. The game thread calls {@link #ask} and blocks;
 * the socket thread calls {@link #answer}. When the seat is gone (closed socket, timeout) {@code ask}
 * returns null and the caller falls back to the Forge AI, so a game never hangs on an absent player.
 */
public final class BridgeSession {
    public interface Transport { void send(String json); }

    private static final Gson GSON = new Gson();

    private final long timeoutMs;
    private final AtomicInteger seq = new AtomicInteger();
    private final Object lock = new Object();
    private volatile Transport transport;
    private CompletableFuture<JsonObject> pending;
    private int pendingId = -1;
    private volatile boolean disconnected;
    private volatile boolean concedeRequested;

    public BridgeSession(long timeoutMs) { this.timeoutMs = timeoutMs; }

    public void attach(Transport t) { this.transport = t; }

    public void send(JsonObject msg) {
        Transport t = transport;
        if (t != null && !disconnected) t.send(GSON.toJson(msg));
    }

    public void sendError(String text) {
        JsonObject j = new JsonObject();
        j.addProperty("type", "error");
        j.addProperty("message", text);
        send(j);
    }

    /** Sends a prompt and waits for the answer. Null = nobody answered (fall back to AI). */
    public JsonObject ask(JsonObject prompt) {
        if (disconnected) return null;
        CompletableFuture<JsonObject> f = new CompletableFuture<>();
        int id = seq.incrementAndGet();
        synchronized (lock) {
            pending = f;
            pendingId = id;
        }
        prompt.addProperty("type", "prompt");
        prompt.addProperty("promptId", id);
        send(prompt);
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            sendError("prompt " + id + " timed out; the AI decided for you");
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
        }
    }

    public void answer(JsonObject msg) {
        int id = msg.has("promptId") ? msg.get("promptId").getAsInt() : -1;
        synchronized (lock) {
            if (pending != null && pendingId == id) {
                pending.complete(msg);
            } else {
                sendError("no pending prompt with promptId " + id);
            }
        }
    }

    /** Seat left: pending and future prompts go to the AI. */
    public void disconnect() {
        disconnected = true;
        synchronized (lock) {
            if (pending != null) pending.complete(null);
        }
    }

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
    public boolean isDisconnected() { return disconnected; }
}
