package cgwf.engine;

import com.google.common.collect.Multiset;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import forge.StaticData;
import forge.card.CardEdition;
import forge.card.MagicColor;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameLogEntry;
import forge.game.card.Card;
import forge.game.card.CounterType;
import forge.game.combat.Combat;
import forge.game.mana.ManaPool;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.Player;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.ZoneType;
import forge.item.IPaperCard;

import java.util.List;
import java.util.function.ToIntFunction;

/**
 * The per-seat JSON view. The ONLY place the engine turns game state into bytes for a client,
 * so hidden information is decided here and nowhere else:
 * <ul>
 *   <li>libraries: count only, never cards;</li>
 *   <li>hands: the viewer's own hand in full, every other hand as a count;</li>
 *   <li>face-down cards (morphs, face-down exile): object + id, identity only if Forge says the viewer may see it;</li>
 *   <li>battlefield, graveyard, command zone, stack, face-up exile: public.</li>
 * </ul>
 * {@code viewer == null} is a spectator and sees public zones only.
 */
public final class SeatView {
    public static final int LOG_LINES = 40;
    private static final ToIntFunction<Player> NO_SEATS = p -> -1;

    private SeatView() { }

    public static JsonObject build(Game game, Player viewer) {
        return build(game, viewer, NO_SEATS);
    }

    /** @param seatOf maps a Forge player to the table seat the caller knows it by (-1 when unknown). */
    public static JsonObject build(Game game, Player viewer, ToIntFunction<Player> seatOf) {
        PhaseHandler ph = game.getPhaseHandler();
        JsonObject o = new JsonObject();
        o.addProperty("type", "state");
        o.addProperty("turn", ph.getTurn());
        PhaseType phase = ph.getPhase();
        o.addProperty("phase", phase == null ? null : phase.name());
        o.addProperty("activePlayer", ph.getPlayerTurn() == null ? null : ph.getPlayerTurn().getId());
        o.addProperty("priorityPlayer", ph.getPriorityPlayer() == null ? null : ph.getPriorityPlayer().getId());
        o.addProperty("viewer", viewer == null ? null : viewer.getId());
        o.addProperty("gameOver", game.isGameOver());
        if (game.isGameOver() && game.getOutcome() != null) {
            o.addProperty("winner", game.getOutcome().isDraw() || game.getOutcome().getWinningLobbyPlayer() == null
                    ? null : game.getOutcome().getWinningLobbyPlayer().getName());
            o.addProperty("endReason", game.getOutcome().getWinCondition() == null ? null : game.getOutcome().getWinCondition().name());
        }
        JsonArray players = new JsonArray();
        for (Player p : game.getRegisteredPlayers()) players.add(player(p, viewer, seatOf)); // registered = includes eliminated seats
        o.add("players", players);
        o.add("stack", stack(game));
        o.add("combat", combat(game.getCombat()));
        o.add("log", log(game));
        return o;
    }

    private static JsonObject player(Player p, Player viewer, ToIntFunction<Player> seatOf) {
        JsonObject j = new JsonObject();
        j.addProperty("id", p.getId());
        j.addProperty("seat", seatOf.applyAsInt(p));
        j.addProperty("name", p.getName());
        j.addProperty("isYou", p == viewer);
        j.addProperty("human", p.getController() instanceof cgwf.engine.bridge.BridgeController);
        j.addProperty("life", p.getLife());
        j.addProperty("poison", p.getPoisonCounters());
        j.addProperty("lost", p.hasLost());
        j.addProperty("handCount", p.getCardsIn(ZoneType.Hand).size());
        j.addProperty("libraryCount", p.getCardsIn(ZoneType.Library).size());
        j.addProperty("landsPlayedThisTurn", p.getLandsPlayedThisTurn());
        JsonObject cmdDamage = new JsonObject();
        for (java.util.Map.Entry<Card, Integer> e : p.getCommanderDamage()) {
            cmdDamage.addProperty(String.valueOf(e.getKey().getId()), e.getValue());
        }
        j.add("commanderDamage", cmdDamage);
        ManaPool mp = p.getManaPool();
        if (mp != null && !mp.isEmpty()) {
            JsonObject pool = new JsonObject();
            String[] names = {"W", "U", "B", "R", "G", "C"};
            byte[] colors = {MagicColor.WHITE, MagicColor.BLUE, MagicColor.BLACK, MagicColor.RED, MagicColor.GREEN, MagicColor.COLORLESS};
            for (int i = 0; i < names.length; i++) {
                int n = mp.getAmountOfColor(colors[i]);
                if (n > 0) pool.addProperty(names[i], n);
            }
            j.add("manaPool", pool);
        }
        if (p == viewer) j.add("hand", cards(p.getCardsIn(ZoneType.Hand), viewer));
        j.add("battlefield", cards(p.getCardsIn(ZoneType.Battlefield), viewer));
        j.add("graveyard", cards(p.getCardsIn(ZoneType.Graveyard), viewer));
        j.add("exile", cards(p.getCardsIn(ZoneType.Exile), viewer));
        j.add("command", cards(p.getCardsIn(ZoneType.Command), viewer));
        return j;
    }

    private static JsonArray cards(Iterable<Card> cards, Player viewer) {
        JsonArray a = new JsonArray();
        for (Card c : cards) {
            // Forge keeps bookkeeping "effect" cards (e.g. the Commander Effect) in the command zone; they are not cards a player sees.
            if (c.isImmutable() && !c.isEmblem()) continue;
            a.add(card(c, viewer));
        }
        return a;
    }

    private static boolean identityVisible(Card c, Player viewer) {
        if (viewer != null) return c.getView().canBeShownTo(viewer.getView());
        ZoneType z = c.getZone() == null ? null : c.getZone().getZoneType();
        if (z == null) return false;
        return switch (z) {
            case Battlefield, Graveyard, Command, Stack, Exile -> !c.isFaceDown();
            default -> false;
        };
    }

    /** A card object. Identity fields are present only when the viewer may see the card's face. */
    public static JsonObject card(Card c, Player viewer) {
        JsonObject j = new JsonObject();
        j.addProperty("id", c.getId());
        j.addProperty("zone", c.getZone() == null ? null : c.getZone().getZoneType().name());
        j.addProperty("controller", c.getController() == null ? null : c.getController().getId());
        j.addProperty("owner", c.getOwner() == null ? null : c.getOwner().getId());
        j.addProperty("tapped", c.isTapped());
        j.addProperty("faceDown", c.isFaceDown());
        j.addProperty("token", c.isToken());
        if (c.isCommander()) j.addProperty("commander", true);
        if (c.getDamage() > 0) j.addProperty("damage", c.getDamage());
        if (c.isInZone(ZoneType.Battlefield) && c.isCreature() && c.isSick()) j.addProperty("sick", true);
        GameEntity attachedTo = c.getEntityAttachedTo();
        if (attachedTo != null) j.add("attachedTo", entityRef(attachedTo));
        Multiset<CounterType> counters = c.getCounters();
        if (counters != null && !counters.isEmpty()) {
            JsonObject cj = new JsonObject();
            for (Multiset.Entry<CounterType> e : counters.entrySet()) cj.addProperty(e.getElement().getName(), e.getCount());
            j.add("counters", cj);
        }
        if (identityVisible(c, viewer)) addIdentity(j, c);
        return j;
    }

    /** Name, printing and stats of a card (only call this when the viewer may see the face). */
    public static void addIdentity(JsonObject j, Card c) {
        j.addProperty("name", c.getName());
        String set = c.getSetCode();
        j.addProperty("set", set);
        j.addProperty("scryfallSet", scryfallSet(set));
        IPaperCard pc = c.getPaperCard();
        j.addProperty("number", pc == null ? null : pc.getCollectorNumber());
        j.addProperty("types", c.getType().toString());
        if (c.getManaCost() != null && !c.getManaCost().isNoCost()) j.addProperty("manaCost", c.getManaCost().getShortString());
        if (c.isCreature()) {
            j.addProperty("power", c.getNetPower());
            j.addProperty("toughness", c.getNetToughness());
        }
    }

    private static String scryfallSet(String forgeCode) {
        if (forgeCode == null) return null;
        CardEdition e = StaticData.instance().getEditions().get(forgeCode);
        return e == null ? forgeCode.toLowerCase() : e.getScryfallCode();
    }

    public static JsonObject entityRef(GameEntity e) {
        JsonObject j = new JsonObject();
        j.addProperty("kind", e instanceof Player ? "player" : "card");
        j.addProperty("id", e.getId());
        j.addProperty("name", e instanceof Player ? e.getName() : null);
        return j;
    }

    private static JsonArray stack(Game game) {
        JsonArray a = new JsonArray();
        for (SpellAbilityStackInstance si : game.getStack()) {
            JsonObject j = new JsonObject();
            j.addProperty("id", si.getId());
            j.addProperty("description", si.getStackDescription());
            Card src = si.getSourceCard();
            if (src != null) {
                j.addProperty("sourceCardId", src.getId());
                j.addProperty("sourceName", src.getName());
            }
            j.addProperty("activatingPlayer", si.getActivatingPlayer() == null ? null : si.getActivatingPlayer().getId());
            a.add(j);
        }
        return a;
    }

    private static JsonObject combat(Combat combat) {
        if (combat == null) return null;
        JsonObject j = new JsonObject();
        j.addProperty("attackingPlayer", combat.getAttackingPlayer().getId());
        JsonArray attackers = new JsonArray();
        for (Card att : combat.getAttackers()) {
            JsonObject aj = new JsonObject();
            aj.addProperty("cardId", att.getId());
            GameEntity def = combat.getDefenderByAttacker(att);
            if (def != null) aj.add("defender", entityRef(def));
            JsonArray blockers = new JsonArray();
            for (Card b : combat.getBlockers(att)) blockers.add(b.getId());
            aj.add("blockedBy", blockers);
            attackers.add(aj);
        }
        j.add("attackers", attackers);
        return j;
    }

    private static JsonArray log(Game game) {
        JsonArray a = new JsonArray();
        List<GameLogEntry> entries = game.getGameLog().getLogEntries(null); // newest first
        int n = Math.min(LOG_LINES, entries.size());
        for (int i = n - 1; i >= 0; i--) {
            GameLogEntry e = entries.get(i);
            JsonObject j = new JsonObject();
            j.addProperty("type", e.type().name());
            j.addProperty("text", e.message());
            a.add(j);
        }
        return a;
    }
}
