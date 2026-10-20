package cgwf.engine.bridge;

import cgwf.engine.DeckLoader;
import cgwf.engine.ForgeBoot;
import cgwf.engine.Main;
import cgwf.engine.Metrics;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The control socket the CGwF server talks to. One connection serves every table; frames carry
 * {@code gameId} and, where seat-specific, {@code seat}. Browsers never connect here.
 *
 * <pre>
 * CGwF -> engine: createGame {rid, gameId, seed?, deferStart?, startingSeat?, seats:[{seat, kind:"human"|"ai", name, deck}]}
 *                 beginGame {gameId, startingSeat?}   (after createGame with deferStart, once the table rolled for who goes first)
 *                 answer {gameId, seat, promptId, ...}   setStops {gameId, seat, stops}   hold {gameId, seat, turn|null}
 *                 resync {gameId, seat}   attachSeat/detachSeat {gameId, seat}   concede {gameId, seat}
 *                 endGame {gameId}   health {rid}   ping
 * engine -> CGwF: hello   gameCreated {rid, gameId, players[]}   cards {gameId, cards[]}
 *                 state {gameId, seat, ...view}   prompt {gameId, seat, promptId, prompt, ...}
 *                 log {gameId, seq, turn, logType, text}   gameOver {gameId, winnerSeat, endReason, turns}
 *                 error {gameId?, seat?, promptId?, rid?, message}   health {rid, activeGames, ...}   pong
 * </pre>
 * The handshake must carry {@code Authorization: Bearer <ENGINE_TOKEN>} when a token is configured.
 */
public final class EngineServer extends WebSocketServer {
    private final String token;
    private final long promptTimeoutMs;
    private final int maxGames;
    private final Map<String, GameSession> games = new ConcurrentHashMap<>();
    private final Set<WebSocket> control = ConcurrentHashMap.newKeySet();

    public EngineServer(int port, String token, long promptTimeoutMs, int maxGames) {
        super(new InetSocketAddress("0.0.0.0", port));
        this.token = token == null ? "" : token;
        this.promptTimeoutMs = promptTimeoutMs;
        this.maxGames = maxGames;
    }

    @Override
    public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(WebSocket conn, Draft draft, ClientHandshake request) throws InvalidDataException {
        ServerHandshakeBuilder builder = super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
        if (!token.isEmpty()) {
            String header = request.getFieldValue("Authorization");
            if (header == null || !constantTimeEquals("Bearer " + token, header)) {
                throw new InvalidDataException(CloseFrame.POLICY_VALIDATION, "unauthorized");
            }
        }
        return builder;
    }

    private static boolean constantTimeEquals(String a, String b) {
        byte[] x = a.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] y = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return java.security.MessageDigest.isEqual(x, y);
    }

    @Override
    public void onStart() {
        System.err.println("[engine] control socket listening on " + getAddress() + (token.isEmpty() ? " (NO TOKEN: set ENGINE_TOKEN)" : " (token required)"));
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        control.add(conn);
        JsonObject hello = new JsonObject();
        hello.addProperty("type", "hello");
        hello.addProperty("engine", "cgwf-engine");
        hello.addProperty("forge", Main.FORGE_VERSION);
        hello.addProperty("ready", ForgeBoot.isReady());
        hello.addProperty("activeGames", activeGames());
        conn.send(hello.toString());
        System.err.println("[engine] control connection from " + conn.getRemoteSocketAddress());
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        control.remove(conn);
        System.err.println("[engine] control connection closed (" + code + " " + reason + "); games keep running: " + activeGames());
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        System.err.println("[engine] socket error: " + ex);
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        JsonObject m;
        try {
            m = JsonParser.parseString(message).getAsJsonObject();
        } catch (RuntimeException e) {
            error(conn, null, null, "not a JSON object");
            return;
        }
        String type = str(m, "type");
        String rid = str(m, "rid");
        String gameId = str(m, "gameId");
        try {
            switch (type) {
                case "createGame" -> createGame(conn, m, rid);
                case "beginGame" -> {
                    game(gameId).begin(optInt(m, "startingSeat"));
                    System.err.println("[engine] game " + gameId + " began, starting seat " + optInt(m, "startingSeat"));
                }
                case "answer" -> game(gameId).answer(seat(m), m);
                case "setStops" -> game(gameId).setStops(seat(m), m.has("stops") && m.get("stops").isJsonObject() ? m.getAsJsonObject("stops") : null);
                case "hold" -> game(gameId).setHold(seat(m), m.has("turn") && !m.get("turn").isJsonNull() ? m.get("turn").getAsInt() : 0);
                case "resync" -> game(gameId).resync(m.has("seat") && !m.get("seat").isJsonNull() ? m.get("seat").getAsInt() : GameSession.SPECTATOR);
                case "attachSeat" -> game(gameId).setAbsent(seat(m), false);
                case "detachSeat" -> game(gameId).setAbsent(seat(m), true);
                case "concede" -> game(gameId).concede(seat(m));
                case "endGame" -> {
                    GameSession g = games.remove(gameId);
                    if (g != null) g.end();
                }
                case "health" -> {
                    JsonObject h = new JsonObject();
                    h.addProperty("type", "health");
                    if (rid != null) h.addProperty("rid", rid);
                    h.addProperty("ready", ForgeBoot.isReady());
                    h.addProperty("forge", Main.FORGE_VERSION);
                    h.addProperty("activeGames", activeGames());
                    h.addProperty("maxGames", maxGames);
                    h.addProperty("usedHeapMb", Metrics.usedHeapMb());
                    h.addProperty("maxHeapMb", Metrics.maxHeapMb());
                    conn.send(h.toString());
                }
                case "ping" -> {
                    JsonObject pong = new JsonObject();
                    pong.addProperty("type", "pong");
                    conn.send(pong.toString());
                }
                default -> error(conn, rid, gameId, "unknown message type: " + type);
            }
        } catch (IllegalArgumentException e) {
            error(conn, rid, gameId, e.getMessage());
        } catch (Exception e) {
            System.err.println("[engine] message failed: " + e);
            e.printStackTrace(System.err);
            error(conn, rid, gameId, e.toString());
        }
    }

    private GameSession game(String gameId) {
        GameSession g = gameId == null ? null : games.get(gameId);
        if (g == null) throw new IllegalArgumentException("unknown gameId");
        return g;
    }

    private static int seat(JsonObject m) {
        if (!m.has("seat") || m.get("seat").isJsonNull()) throw new IllegalArgumentException("seat is required");
        return m.get("seat").getAsInt();
    }

    private static String str(JsonObject m, String key) {
        return m.has(key) && !m.get(key).isJsonNull() ? m.get(key).getAsString() : null;
    }

    private void createGame(WebSocket conn, JsonObject m, String rid) {
        String gameId = str(m, "gameId");
        if (gameId == null || gameId.isBlank()) throw new IllegalArgumentException("gameId is required");
        if (games.containsKey(gameId)) throw new IllegalArgumentException("a game with that id is already running");
        games.entrySet().removeIf(e -> e.getValue().isOver() || e.getValue().isStale(STALE_DEFERRED_MS));
        if (games.size() >= maxGames) throw new IllegalArgumentException("engine busy: " + games.size() + " games running");
        long seed = m.has("seed") && !m.get("seed").isJsonNull() ? m.get("seed").getAsLong() : System.nanoTime();
        if (!m.has("seats") || !m.get("seats").isJsonArray() || m.getAsJsonArray("seats").size() < 2) throw new IllegalArgumentException("need at least two seats");
        List<GameSession.SeatSpec> specs = new ArrayList<>();
        for (JsonElement e : m.getAsJsonArray("seats")) {
            JsonObject s = e.getAsJsonObject();
            int seat = seat(s);
            boolean human = "human".equals(str(s, "kind"));
            String name = str(s, "name");
            if (name == null || name.isBlank()) name = "Seat " + (seat + 1);
            if (!s.has("deck") || !s.get("deck").isJsonObject()) throw new IllegalArgumentException("seat " + seat + " has no deck");
            DeckLoader.Loaded deck = DeckLoader.build(DeckLoader.parse(s.getAsJsonObject("deck")));
            if (deck.resolved() == 0) throw new IllegalArgumentException("seat " + seat + ": no card of that deck is known to Forge");
            specs.add(new GameSession.SeatSpec(seat, human, name, deck));
        }
        GameSession session = new GameSession(gameId, seed, specs, promptTimeoutMs, this::broadcast);
        games.put(gameId, session);
        JsonObject created = session.createdFrame();
        if (rid != null) created.addProperty("rid", rid);
        conn.send(created.toString());
        if (m.has("deferStart") && m.get("deferStart").getAsBoolean()) {
            System.err.println("[engine] game " + gameId + " created with " + specs.size() + " seats, waiting for beginGame (" + activeGames() + " active)");
            return;
        }
        session.begin(optInt(m, "startingSeat"));
        System.err.println("[engine] game " + gameId + " started with " + specs.size() + " seats (" + activeGames() + " active)");
    }

    /** A deferred game the relay never began (it restarted mid-roll) is dropped after this. */
    private static final long STALE_DEFERRED_MS = 30 * 60_000L;

    private static Integer optInt(JsonObject m, String key) {
        return m.has(key) && !m.get(key).isJsonNull() ? m.get(key).getAsInt() : null;
    }

    private int activeGames() {
        int n = 0;
        for (GameSession g : games.values()) if (!g.isOver()) n++;
        return n;
    }

    private void broadcast(JsonObject frame) {
        String text = frame.toString();
        for (WebSocket ws : control) {
            if (ws.isOpen()) ws.send(text);
        }
    }

    private static void error(WebSocket conn, String rid, String gameId, String text) {
        JsonObject j = new JsonObject();
        j.addProperty("type", "error");
        if (rid != null) j.addProperty("rid", rid);
        if (gameId != null) j.addProperty("gameId", gameId);
        j.addProperty("message", text);
        conn.send(j.toString());
    }
}
