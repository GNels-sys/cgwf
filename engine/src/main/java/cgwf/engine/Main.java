package cgwf.engine;

import cgwf.engine.bridge.BridgeServer;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.game.Game;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Entry point.
 * <pre>
 *   java -jar cgwf-engine.jar bench [--assets DIR] [--decks DIR] [--seed N] [--games N] [--max-turns N] [--lazy true|false]
 *   java -jar cgwf-engine.jar audit [--assets DIR] [--decks DIR] [--seed N] [--max-turns N]
 *   java -jar cgwf-engine.jar serve [--assets DIR] [--decks DIR] [--port 8081] [--prompt-timeout-ms N]
 * </pre>
 * Environment fallbacks: FORGE_ASSETS, CGWF_DECKS, PORT, CGWF_LAZY_CARDS, CGWF_PROMPT_TIMEOUT_MS.
 * Forge prints to System.out; everything of ours goes to stderr except the bench JSON report.
 */
public final class Main {
    public static final String FORGE_VERSION = "2.0.15";

    private Main() { }

    public static void main(String[] args) throws Exception {
        String mode = "serve";
        Map<String, String> opt = new HashMap<>();
        for (int i = 0; i < args.length; i++) {
            if (args[i].startsWith("--")) {
                String key = args[i].substring(2);
                String val = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[++i] : "true";
                opt.put(key, val);
            } else {
                mode = args[i];
            }
        }
        PrintStream realOut = System.out;
        System.setOut(System.err);

        Path assets = Path.of(opt.getOrDefault("assets", envOr("FORGE_ASSETS", "../forge/forge-gui")));
        Path decks = Path.of(opt.getOrDefault("decks", envOr("CGWF_DECKS", "spike/decks")));
        boolean lazy = !"false".equalsIgnoreCase(opt.getOrDefault("lazy", envOr("CGWF_LAZY_CARDS", "true")));
        long startupMs = ForgeBoot.init(assets, lazy);
        System.err.printf("[engine] Forge %s ready in %d ms (lazy card scripts: %s, heap used %d MB, max heap %d MB)%n",
                FORGE_VERSION, startupMs, lazy, Metrics.usedHeapMb(), Metrics.maxHeapMb());

        switch (mode) {
            case "bench" -> bench(decks, Long.parseLong(opt.getOrDefault("seed", "1")), Integer.parseInt(opt.getOrDefault("games", "1")),
                    Integer.parseInt(opt.getOrDefault("max-turns", "60")), startupMs, lazy, realOut);
            case "audit" -> {
                HiddenInfoAudit.Result r = HiddenInfoAudit.run(decks, Long.parseLong(opt.getOrDefault("seed", "7")), Integer.parseInt(opt.getOrDefault("max-turns", "40")));
                System.err.printf("[audit] %d events, %d views checked over %d turns, %d leaks%n", r.events(), r.views(), r.turns(), r.leaks().size());
                for (String leak : r.leaks()) System.err.println("[audit] LEAK " + leak);
                realOut.println(r.leaks().isEmpty() ? "HIDDEN-INFO OK" : "HIDDEN-INFO FAIL");
                System.exit(r.leaks().isEmpty() ? 0 : 1);
            }
            case "serve" -> {
                int port = Integer.parseInt(opt.getOrDefault("port", envOr("PORT", "8081")));
                long timeout = Long.parseLong(opt.getOrDefault("prompt-timeout-ms", envOr("CGWF_PROMPT_TIMEOUT_MS", "600000")));
                BridgeServer server = new BridgeServer(port, decks, timeout);
                server.setReuseAddr(true);
                server.run();
            }
            default -> {
                System.err.println("unknown mode: " + mode + " (bench | audit | serve)");
                System.exit(2);
            }
        }
    }

    private static String envOr(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.isBlank() ? def : v;
    }

    /** Four Forge AIs play each other; prints one JSON report to stdout. */
    static void bench(Path decksDir, long seed, int games, int maxTurns, long startupMs, boolean lazy, PrintStream out) throws IOException {
        List<DeckLoader.Loaded> decks = DeckLoader.loadDir(decksDir, 4);
        JsonObject report = new JsonObject();
        report.addProperty("forge", FORGE_VERSION);
        report.addProperty("java", System.getProperty("java.version"));
        report.addProperty("os", System.getProperty("os.name") + " " + System.getProperty("os.arch"));
        report.addProperty("startupMs", startupMs);
        report.addProperty("lazyCards", lazy);
        report.addProperty("heapAfterBootMb", Metrics.usedHeapMb());
        report.addProperty("maxHeapMb", Metrics.maxHeapMb());
        report.addProperty("maxTurns", maxTurns);
        JsonArray dj = new JsonArray();
        for (DeckLoader.Loaded d : decks) {
            JsonObject j = new JsonObject();
            j.addProperty("name", d.spec().name());
            StringBuilder cmd = new StringBuilder();
            for (DeckLoader.CardRef c : d.spec().commanders()) cmd.append(cmd.isEmpty() ? "" : " / ").append(c.name());
            j.addProperty("commanders", cmd.toString());
            j.addProperty("cards", d.deck().getMain().countAll() + (d.deck().has(forge.deck.DeckSection.Commander) ? d.deck().get(forge.deck.DeckSection.Commander).countAll() : 0));
            j.addProperty("exactPrinting", d.exactPrinting());
            j.addProperty("bySetOnly", d.bySetOnly());
            j.addProperty("byNameOnly", d.byNameOnly());
            j.addProperty("missing", String.join(", ", d.missing()));
            dj.add(j);
            System.err.printf("[bench] deck %s: %d cards (%d exact printing, %d by set, %d by name, %d missing)%n",
                    d.spec().name(), d.resolved(), d.exactPrinting(), d.bySetOnly(), d.byNameOnly(), d.missing().size());
        }
        report.add("decks", dj);
        JsonArray gj = new JsonArray();
        for (int g = 0; g < games; g++) {
            long s = seed + g;
            List<GameFactory.Seat> seats = new ArrayList<>();
            for (int i = 0; i < decks.size(); i++) {
                String name = "AI " + (i + 1);
                seats.add(new GameFactory.Seat(name, decks.get(i).deck(), GameFactory.ai(name)));
            }
            GameFactory.Created created = GameFactory.create(seats, s);
            Game game = created.game();
            Metrics m = new Metrics(game, maxTurns);
            game.subscribeToEvents(m);
            System.err.printf("[bench] game %d/%d seed %d starting%n", g + 1, games, s);
            try {
                created.match().startGame(game);
            } catch (Throwable t) {
                System.err.println("[bench] game failed: " + t);
                t.printStackTrace(System.err);
            } finally {
                m.finish();
            }
            JsonObject gjson = m.toJson(s);
            gj.add(gjson);
            System.err.printf("[bench] game %d done: %s%n", g + 1, gjson);
            System.gc();
        }
        report.add("games", gj);
        out.println(new GsonBuilder().setPrettyPrinting().create().toJson(report));
        out.flush();
    }
}
