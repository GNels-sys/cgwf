package cgwf.engine.bridge;

import cgwf.engine.DeckLoader;
import cgwf.engine.ForgeBoot;
import cgwf.engine.GameFactory;
import cgwf.engine.SeatView;
import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import forge.game.Game;
import forge.game.event.GameEventTurnPhase;
import forge.game.player.Player;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Spike transport: one WebSocket connection = one table with one human seat (the connection) and
 * three Forge AI seats. Messages are JSON objects with a {@code type}.
 * <pre>
 * client -> server: {type:"start", seat?:0-3, seed?:n, name?:"You", decks?:["file.json",...]}
 *                   {type:"answer", promptId:n, ...}   {type:"concede"}   {type:"ping"}
 * server -> client: {type:"hello"} {type:"started", seat, players[]} {type:"state", ...view}
 *                   {type:"prompt", promptId, prompt:"priority|targets|attackers|blockers|choose|chooseMany|confirm|mulligan", view, ...}
 *                   {type:"error", message} {type:"gameOver", ...view} {type:"pong"}
 * </pre>
 */
public final class BridgeServer extends WebSocketServer {
    private record Table(BridgeSession session, Thread thread, Game game) { }

    private final Path decksDir;
    private final long promptTimeoutMs;
    private final Map<WebSocket, Table> tables = new ConcurrentHashMap<>();

    public BridgeServer(int port, Path decksDir, long promptTimeoutMs) {
        super(new InetSocketAddress("0.0.0.0", port));
        this.decksDir = decksDir;
        this.promptTimeoutMs = promptTimeoutMs;
    }

    @Override
    public void onStart() {
        System.err.println("[engine] WebSocket bridge listening on " + getAddress());
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        JsonObject hello = new JsonObject();
        hello.addProperty("type", "hello");
        hello.addProperty("engine", "cgwf-engine");
        hello.addProperty("forge", "2.0.15");
        hello.addProperty("ready", ForgeBoot.isReady());
        conn.send(hello.toString());
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Table t = tables.remove(conn);
        if (t != null) t.session().disconnect(); // the AI finishes the game for the absent seat
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
            error(conn, "not a JSON object");
            return;
        }
        String type = m.has("type") ? m.get("type").getAsString() : "";
        try {
            switch (type) {
                case "start" -> start(conn, m);
                case "answer" -> {
                    Table t = tables.get(conn);
                    if (t == null) error(conn, "no game on this connection");
                    else t.session().answer(m);
                }
                case "concede" -> {
                    Table t = tables.get(conn);
                    if (t != null) t.session().requestConcede();
                }
                case "ping" -> {
                    JsonObject pong = new JsonObject();
                    pong.addProperty("type", "pong");
                    conn.send(pong.toString());
                }
                default -> error(conn, "unknown message type: " + type);
            }
        } catch (Exception e) {
            error(conn, e.toString());
        }
    }

    private void start(WebSocket conn, JsonObject m) throws Exception {
        if (tables.containsKey(conn)) { error(conn, "a game is already running on this connection"); return; }
        int seat = m.has("seat") ? m.get("seat").getAsInt() : 0;
        long seed = m.has("seed") ? m.get("seed").getAsLong() : System.nanoTime();
        String name = m.has("name") ? m.get("name").getAsString() : "You";
        List<DeckLoader.Loaded> decks = new ArrayList<>();
        if (m.has("decks") && m.get("decks").isJsonArray()) {
            for (JsonElement e : m.getAsJsonArray("decks")) {
                decks.add(DeckLoader.build(DeckLoader.read(decksDir.resolve(e.getAsString()))));
            }
        } else {
            decks = DeckLoader.loadDir(decksDir, 4);
        }
        if (decks.size() < 2) { error(conn, "need at least two decks"); return; }
        if (seat < 0 || seat >= decks.size()) seat = 0;

        BridgeSession session = new BridgeSession(promptTimeoutMs);
        session.attach(conn::send);
        List<GameFactory.Seat> seats = new ArrayList<>();
        for (int i = 0; i < decks.size(); i++) {
            DeckLoader.Loaded d = decks.get(i);
            String nm = i == seat ? name : "Bot " + (i + 1) + " (" + d.spec().name() + ")";
            seats.add(new GameFactory.Seat(nm, d.deck(), i == seat ? new BridgeLobbyPlayer(nm, session) : GameFactory.ai(nm)));
        }
        GameFactory.Created created = GameFactory.create(seats, seed);
        Game game = created.game();
        Player human = null;
        for (Player p : game.getPlayers()) if (p.getController() instanceof BridgeController) human = p;
        final Player viewer = human;

        game.subscribeToEvents(new Object() {
            @Subscribe
            public void onPhase(GameEventTurnPhase e) {
                session.send(SeatView.build(game, viewer));
            }
        });

        JsonObject started = new JsonObject();
        started.addProperty("type", "started");
        started.addProperty("seat", seat);
        started.addProperty("seed", seed);
        started.addProperty("you", viewer == null ? null : viewer.getId());
        JsonArray players = new JsonArray();
        for (int i = 0; i < seats.size(); i++) {
            JsonObject pj = new JsonObject();
            pj.addProperty("name", seats.get(i).name());
            pj.addProperty("deck", decks.get(i).spec().name());
            pj.addProperty("human", i == seat);
            players.add(pj);
        }
        started.add("players", players);
        conn.send(started.toString());

        Thread thread = new Thread(() -> {
            try {
                created.match().startGame(game);
            } catch (Throwable t) {
                System.err.println("[engine] game thread died: " + t);
                t.printStackTrace(System.err);
                session.sendError("engine failure: " + t);
            } finally {
                JsonObject over = SeatView.build(game, viewer);
                over.addProperty("type", "gameOver");
                session.send(over);
                tables.remove(conn);
            }
        }, "game-" + seed);
        thread.setDaemon(true);
        tables.put(conn, new Table(session, thread, game));
        thread.start();
    }

    private static void error(WebSocket conn, String text) {
        JsonObject j = new JsonObject();
        j.addProperty("type", "error");
        j.addProperty("message", text);
        conn.send(j.toString());
    }
}
