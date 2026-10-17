package cgwf.engine;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.card.Card;
import forge.game.event.GameEventCardChangeZone;
import forge.game.event.GameEventPlayerPriority;
import forge.game.event.GameEventTurnPhase;
import forge.game.player.Player;
import forge.game.zone.ZoneType;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Runs a four-seat AI game and, at every priority pass, step change and zone change, serialises
 * the view of every seat plus a spectator and checks that none of them contains a card that sits
 * in any library or in another seat's hand: not its id, not a name that only such a card could
 * have supplied, and never more than the public count. The JUnit test in src/test wraps this.
 */
public final class HiddenInfoAudit {
    public record Result(int views, int events, int turns, List<String> leaks) { }

    private static final int MAX_LEAKS = 50;

    private HiddenInfoAudit() { }

    public static Result run(Path decksDir, long seed, int maxTurns) throws IOException {
        List<DeckLoader.Loaded> decks = DeckLoader.loadDir(decksDir, 4);
        List<GameFactory.Seat> seats = new ArrayList<>();
        for (DeckLoader.Loaded d : decks) seats.add(new GameFactory.Seat("Seat " + (seats.size() + 1), d.deck(), GameFactory.ai("Seat " + (seats.size() + 1))));
        GameFactory.Created created = GameFactory.create(seats, seed);
        Game game = created.game();
        List<String> leaks = new ArrayList<>();
        int[] counts = new int[2];
        Object auditor = new Object() {
            @Subscribe public void onPriority(GameEventPlayerPriority e) { audit(); }
            @Subscribe public void onPhase(GameEventTurnPhase e) { audit(); }
            @Subscribe public void onZone(GameEventCardChangeZone e) { audit(); }

            void audit() {
                counts[1]++;
                List<Player> viewers = new ArrayList<>(game.getRegisteredPlayers());
                viewers.add(null); // spectator
                for (Player viewer : viewers) {
                    counts[0]++;
                    leaks.addAll(check(game, viewer, SeatView.build(game, viewer)));
                }
                if (leaks.size() >= MAX_LEAKS && !game.isGameOver()) game.setGameOver(GameEndReason.Draw);
            }
        };
        Metrics metrics = new Metrics(game, maxTurns);
        game.subscribeToEvents(auditor);
        game.subscribeToEvents(metrics);
        created.match().startGame(game);
        return new Result(counts[0], counts[1], metrics.turns(), leaks);
    }

    /** Pure check of one serialised view against the true state. */
    public static List<String> check(Game game, Player viewer, JsonObject view) {
        String who = viewer == null ? "spectator" : viewer.getName();
        Set<Integer> secretIds = new HashSet<>();
        Map<Integer, String> secretWhere = new HashMap<>();
        Set<String> secretNames = new HashSet<>();
        Set<String> publicNames = new HashSet<>();
        Map<Integer, Player> players = new HashMap<>();
        for (Player p : game.getRegisteredPlayers()) { // eliminated seats keep their zones and stay in the view
            players.put(p.getId(), p);
            for (Card c : p.getCardsIn(ZoneType.Library)) {
                secretIds.add(c.getId());
                secretWhere.put(c.getId(), p.getName() + "'s library");
                secretNames.add(c.getName());
            }
            if (p != viewer) {
                for (Card c : p.getCardsIn(ZoneType.Hand)) {
                    secretIds.add(c.getId());
                    secretWhere.put(c.getId(), p.getName() + "'s hand");
                    secretNames.add(c.getName());
                }
            }
        }
        for (Card c : game.getCardsInGame()) {
            if (!secretIds.contains(c.getId())) publicNames.add(c.getName());
        }
        // a name is "secret only" when no card the viewer could legitimately see carries it
        Set<String> secretOnlyNames = new HashSet<>(secretNames);
        secretOnlyNames.removeAll(publicNames);

        List<String> leaks = new ArrayList<>();
        Set<Integer> idsSeen = new HashSet<>();
        Set<String> namesSeen = new HashSet<>();
        collect(view, idsSeen, namesSeen);
        for (int id : idsSeen) {
            if (secretIds.contains(id)) leaks.add(who + " sees card #" + id + " from " + secretWhere.get(id));
        }
        for (String n : namesSeen) {
            if (secretOnlyNames.contains(n)) leaks.add(who + " sees the name '" + n + "' which only a hidden card carries");
        }
        if (view.has("players")) {
            for (JsonElement e : view.getAsJsonArray("players")) {
                JsonObject pj = e.getAsJsonObject();
                Player p = players.get(pj.get("id").getAsInt());
                if (p == null) { leaks.add(who + ": unknown player id in view"); continue; }
                if (pj.has("library")) leaks.add(who + " sees a 'library' array for " + p.getName());
                if (p != viewer && pj.has("hand")) leaks.add(who + " sees a 'hand' array for " + p.getName());
                if (pj.get("handCount").getAsInt() != p.getCardsIn(ZoneType.Hand).size()) leaks.add(who + ": handCount wrong for " + p.getName());
                if (pj.get("libraryCount").getAsInt() != p.getCardsIn(ZoneType.Library).size()) leaks.add(who + ": libraryCount wrong for " + p.getName());
            }
        }
        return leaks;
    }

    /** Collects every card id and card name referenced anywhere in a view. */
    private static void collect(JsonElement el, Set<Integer> ids, Set<String> names) {
        if (el == null || el.isJsonNull()) return;
        if (el.isJsonArray()) {
            for (JsonElement e : (JsonArray) el) collect(e, ids, names);
            return;
        }
        if (!el.isJsonObject()) return;
        JsonObject o = el.getAsJsonObject();
        boolean isCard = o.has("zone") && o.has("id");
        boolean isCardRef = o.has("kind") && "card".equals(o.get("kind").getAsString()) && o.has("id");
        if (isCard || isCardRef) {
            ids.add(o.get("id").getAsInt());
            if (o.has("name") && !o.get("name").isJsonNull()) names.add(o.get("name").getAsString());
        }
        if (o.has("cardId")) ids.add(o.get("cardId").getAsInt());
        if (o.has("sourceCardId")) ids.add(o.get("sourceCardId").getAsInt());
        if (o.has("sourceName") && !o.get("sourceName").isJsonNull()) names.add(o.get("sourceName").getAsString());
        if (o.has("blockedBy")) for (JsonElement b : o.getAsJsonArray("blockedBy")) ids.add(b.getAsInt());
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            if (e.getKey().equals("commanderDamage")) continue; // commanders are public identities wherever they are
            collect(e.getValue(), ids, names);
        }
    }
}
