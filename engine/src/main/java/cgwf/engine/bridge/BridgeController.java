package cgwf.engine.bridge;

import cgwf.engine.SeatView;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import forge.LobbyPlayer;
import forge.ai.ComputerUtilAbility;
import forge.ai.ComputerUtilCost;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardUtil;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;
import forge.util.collect.FCollectionView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * The human seat. Forge asks a {@code PlayerController} ~110 kinds of questions; this class turns
 * the ones the spike models into JSON prompts and blocks until the seat answers. Everything it does
 * not model (and every prompt nobody answers: disconnect, timeout) falls through to Forge's own AI,
 * which is what {@code super} is. Stage 1 widens the modelled set prompt by prompt.
 *
 * Modelled here: priority ("choose an ability to play", mana paid automatically), targets,
 * declare attackers, declare blockers, single choice, multiple choice, confirm, mulligan + bottom.
 */
public final class BridgeController extends PlayerControllerAi {
    private final BridgeSession session;
    private final Game game;

    public BridgeController(Game game, Player p, LobbyPlayer lp, BridgeSession session) {
        super(game, p, lp);
        this.game = game;
        this.session = session;
    }

    public BridgeSession session() { return session; }

    private boolean autopilot() { return session.isDisconnected(); }

    private JsonObject prompt(String kind, String title) {
        JsonObject p = new JsonObject();
        p.addProperty("prompt", kind);
        p.addProperty("title", title);
        p.add("view", SeatView.build(game, player));
        return p;
    }

    // ------------------------------------------------------------------ priority

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        if (session.concedeRequested() && !player.hasLost()) {
            player.concede();
            return null;
        }
        if (autopilot()) return super.chooseSpellAbilityToPlay();

        List<SpellAbility> legal = legalAbilities();
        JsonObject p = prompt("priority", "You have priority");
        JsonArray opts = new JsonArray();
        for (int i = 0; i < legal.size(); i++) opts.add(abilityJson(i, legal.get(i)));
        p.add("options", opts);

        JsonObject a = session.ask(p);
        if (a == null) return super.chooseSpellAbilityToPlay();
        if (isTrue(a, "concede")) {
            player.concede();
            return null;
        }
        if (!a.has("option") || a.get("option").isJsonNull()) return null; // pass
        int idx = a.get("option").getAsInt();
        if (idx < 0 || idx >= legal.size()) {
            session.sendError("option " + idx + " is out of range");
            return Collections.emptyList(); // Forge asks again without passing
        }
        SpellAbility sa = legal.get(idx);
        sa.setActivatingPlayer(player);
        if (!chooseTargets(sa)) {
            session.sendError("no legal targets chosen; nothing was played");
            return Collections.emptyList();
        }
        List<SpellAbility> chosen = new ArrayList<>(1);
        chosen.add(sa);
        return chosen;
    }

    /** Everything this seat could legally play or activate right now, mana permitting. */
    private List<SpellAbility> legalAbilities() {
        CardCollection cards = ComputerUtilAbility.getAvailableCards(game, player);
        List<SpellAbility> out = new ArrayList<>();
        for (SpellAbility sa : ComputerUtilAbility.getSpellAbilities(cards, player)) {
            if (sa.isManaAbility()) continue; // paid automatically
            Card host = sa.getHostCard();
            if (host == null) continue;
            // the AI's candidate list includes the top card of EVERY library (for "play from the top" effects);
            // never offer a card the seat may not see
            if (host.isInZone(ZoneType.Library) && !host.getView().canBeShownTo(player.getView())) continue;
            if (host.isInZone(ZoneType.Hand) && host.getController() != player) continue;
            boolean ok;
            try {
                sa.setActivatingPlayer(player);
                ok = sa.canPlay()
                        && ComputerUtilCost.canPayCost(sa, player, false)
                        && (!sa.usesTargeting() || sa.getMinTargets() == 0 || hasAnyTarget(sa));
            } catch (RuntimeException e) {
                ok = false;
            }
            if (ok) out.add(sa);
        }
        return out;
    }

    private boolean hasAnyTarget(SpellAbility sa) {
        if (!CardUtil.getValidCardsToTarget(sa).isEmpty()) return true;
        if (sa.getTargetRestrictions().canTgtPlayer()) {
            for (Player p : game.getPlayers()) if (sa.canTarget(p)) return true;
        }
        return false;
    }

    private static JsonObject abilityJson(int index, SpellAbility sa) {
        JsonObject j = new JsonObject();
        Card host = sa.getHostCard();
        j.addProperty("index", index);
        j.addProperty("cardId", host.getId());
        j.addProperty("cardName", host.getName());
        j.addProperty("zone", host.getZone() == null ? null : host.getZone().getZoneType().name());
        j.addProperty("kind", sa.isLandAbility() ? "land" : sa.isSpell() ? "spell" : "ability");
        j.addProperty("description", sa.toString());
        j.addProperty("cost", sa.getPayCosts() == null ? null : sa.getPayCosts().toSimpleString());
        j.addProperty("targets", sa.usesTargeting());
        return j;
    }

    /** Walks the ability chain and asks for targets wherever Forge needs them. False = not playable. */
    private boolean chooseTargets(SpellAbility root) {
        for (SpellAbility sa = root; sa != null; sa = sa.getSubAbility()) {
            if (!sa.usesTargeting()) continue;
            sa.resetTargets();
            List<GameObject> candidates = new ArrayList<>(CardUtil.getValidCardsToTarget(sa));
            if (sa.getTargetRestrictions().canTgtPlayer()) {
                for (Player p : game.getPlayers()) if (sa.canTarget(p)) candidates.add(p);
            }
            int min = sa.getMinTargets();
            int max = sa.getMaxTargets();
            if (candidates.isEmpty()) {
                if (min == 0) continue;
                return false;
            }
            JsonObject p = prompt("targets", "Choose targets for " + sa.getHostCard().getName());
            p.addProperty("ability", sa.toString());
            p.addProperty("min", min);
            p.addProperty("max", max);
            p.add("options", objectsJson(candidates));
            JsonObject a = autopilot() ? null : session.ask(p);
            List<Integer> picks = a == null ? firstN(Math.max(1, min), candidates.size()) : indices(a, "options");
            for (int idx : picks) {
                if (idx >= 0 && idx < candidates.size()) sa.getTargets().add(candidates.get(idx));
            }
            if (!sa.isTargetNumberValid()) return false;
        }
        return true;
    }

    // ------------------------------------------------------------------ combat

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        if (autopilot()) { super.declareAttackers(attacker, combat); return; }
        List<GameEntity> defenders = new ArrayList<>();
        for (GameEntity d : combat.getDefenders()) defenders.add(d);
        List<Card> candidates = new ArrayList<>();
        JsonArray cands = new JsonArray();
        for (Card c : attacker.getCreaturesInPlay()) {
            if (!CombatUtil.canAttack(c)) continue;
            JsonArray allowed = new JsonArray();
            for (GameEntity d : defenders) if (CombatUtil.canAttack(c, d)) allowed.add(SeatView.entityRef(d));
            if (allowed.isEmpty()) continue;
            JsonObject cj = SeatView.card(c, player);
            cj.add("canAttack", allowed);
            cands.add(cj);
            candidates.add(c);
        }
        if (candidates.isEmpty()) return;
        JsonObject p = prompt("attackers", "Declare attackers");
        p.add("candidates", cands);
        JsonArray defs = new JsonArray();
        for (GameEntity d : defenders) {
            JsonObject dj = SeatView.entityRef(d);
            if (d instanceof Player pl) dj.addProperty("life", pl.getLife());
            if (d instanceof Card dc) dj.addProperty("name", dc.getName());
            defs.add(dj);
        }
        p.add("defenders", defs);
        JsonObject a = session.ask(p);
        if (a == null) { super.declareAttackers(attacker, combat); return; }
        if (!a.has("attacks") || !a.get("attacks").isJsonArray()) return; // no attack
        for (JsonElement e : a.getAsJsonArray("attacks")) {
            JsonObject att = e.getAsJsonObject();
            Card c = byId(candidates, att.get("cardId").getAsInt());
            GameEntity d = defenderOf(defenders, att.getAsJsonObject("defender"));
            if (c != null && d != null && CombatUtil.canAttack(c, d) && !combat.isAttacking(c)) combat.addAttacker(c, d);
        }
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        if (autopilot()) { super.declareBlockers(defender, combat); return; }
        List<Card> attackers = new ArrayList<>();
        for (Card att : combat.getAttackers()) {
            GameEntity d = combat.getDefenderByAttacker(att);
            if (d == defender || (d instanceof Card dc && dc.getController() == defender)) attackers.add(att);
        }
        if (attackers.isEmpty()) return;
        List<Card> blockers = new ArrayList<>();
        JsonArray bj = new JsonArray();
        for (Card b : defender.getCreaturesInPlay()) {
            if (!CombatUtil.canBlock(b, combat)) continue;
            JsonArray can = new JsonArray();
            for (Card att : attackers) if (CombatUtil.canBlock(att, b, combat)) can.add(att.getId());
            if (can.isEmpty()) continue;
            JsonObject cj = SeatView.card(b, player);
            cj.add("canBlock", can);
            bj.add(cj);
            blockers.add(b);
        }
        if (blockers.isEmpty()) return;
        JsonObject p = prompt("blockers", "Declare blockers");
        JsonArray aj = new JsonArray();
        for (Card att : attackers) {
            JsonObject j = SeatView.card(att, player);
            GameEntity d = combat.getDefenderByAttacker(att);
            if (d != null) j.add("attacking", SeatView.entityRef(d));
            aj.add(j);
        }
        p.add("attackers", aj);
        p.add("blockers", bj);
        JsonObject a = session.ask(p);
        if (a == null) { super.declareBlockers(defender, combat); return; }
        if (!a.has("blocks") || !a.get("blocks").isJsonArray()) return;
        for (JsonElement e : a.getAsJsonArray("blocks")) {
            JsonObject blk = e.getAsJsonObject();
            Card b = byId(blockers, blk.get("blockerId").getAsInt());
            Card att = byId(attackers, blk.get("attackerId").getAsInt());
            if (b != null && att != null && CombatUtil.canBlock(att, b, combat)) combat.addBlocker(att, b);
        }
        String problem = CombatUtil.validateBlocks(combat, defender);
        if (problem != null) {
            session.sendError("blocks rejected: " + problem + " (no blocks declared)");
            for (Card b : CardLists.filterControlledBy(combat.getAllBlockers(), defender)) combat.removeFromCombat(b);
        }
    }

    // ------------------------------------------------------------------ generic choices

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal,
            SpellAbility sa, String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot()) return super.chooseSingleEntityForEffect(optionList, null, sa, title, isOptional, targetedPlayer, params);
        List<T> opts = new ArrayList<>();
        for (T t : optionList) opts.add(t);
        if (opts.isEmpty()) return null;
        JsonObject p = prompt("choose", title);
        p.addProperty("optional", isOptional);
        p.addProperty("source", sa == null || sa.getHostCard() == null ? null : sa.getHostCard().getName());
        p.add("options", objectsJson(opts));
        JsonObject a = session.ask(p);
        if (a == null) return super.chooseSingleEntityForEffect(optionList, null, sa, title, isOptional, targetedPlayer, params);
        if (!a.has("option") || a.get("option").isJsonNull()) return isOptional ? null : opts.get(0);
        int idx = a.get("option").getAsInt();
        return idx >= 0 && idx < opts.size() ? opts.get(idx) : (isOptional ? null : opts.get(0));
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max, DelayedReveal delayedReveal,
            SpellAbility sa, String title, Player targetedPlayer, Map<String, Object> params) {
        if (delayedReveal != null) reveal(delayedReveal);
        if (autopilot()) return super.chooseEntitiesForEffect(optionList, min, max, null, sa, title, targetedPlayer, params);
        List<T> opts = new ArrayList<>();
        for (T t : optionList) opts.add(t);
        JsonObject p = prompt("chooseMany", title);
        p.addProperty("min", min);
        p.addProperty("max", max);
        p.addProperty("source", sa == null || sa.getHostCard() == null ? null : sa.getHostCard().getName());
        p.add("options", objectsJson(opts));
        JsonObject a = session.ask(p);
        if (a == null) return super.chooseEntitiesForEffect(optionList, min, max, null, sa, title, targetedPlayer, params);
        List<T> out = new ArrayList<>();
        for (int idx : indices(a, "options")) if (idx >= 0 && idx < opts.size() && !out.contains(opts.get(idx))) out.add(opts.get(idx));
        if (out.size() < min || out.size() > max) {
            session.sendError("expected between " + min + " and " + max + " choices; the AI chose instead");
            return super.chooseEntitiesForEffect(optionList, min, max, null, sa, title, targetedPlayer, params);
        }
        return out;
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow, Map<String, Object> params) {
        if (autopilot()) return super.confirmAction(sa, mode, message, options, cardToShow, params);
        JsonObject p = prompt("confirm", message);
        p.addProperty("mode", mode == null ? null : mode.name());
        p.addProperty("source", sa == null || sa.getHostCard() == null ? null : sa.getHostCard().getName());
        JsonArray labels = new JsonArray();
        if (options != null) for (String o : options) labels.add(o);
        else { labels.add("Yes"); labels.add("No"); }
        p.add("options", labels);
        if (cardToShow != null) p.add("card", SeatView.card(cardToShow, player));
        JsonObject a = session.ask(p);
        if (a == null) return super.confirmAction(sa, mode, message, options, cardToShow, params);
        if (a.has("confirm")) return a.get("confirm").getAsBoolean();
        return a.has("option") && !a.get("option").isJsonNull() && a.get("option").getAsInt() == 0;
    }

    // ------------------------------------------------------------------ mulligan

    @Override
    public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
        if (autopilot()) return super.mulliganKeepHand(firstPlayer, cardsToReturn);
        JsonObject p = prompt("mulligan", "Keep this hand?");
        p.addProperty("cardsToReturn", cardsToReturn);
        p.add("hand", objectsJson(new ArrayList<>(player.getCardsIn(ZoneType.Hand))));
        JsonObject a = session.ask(p);
        if (a == null) return super.mulliganKeepHand(firstPlayer, cardsToReturn);
        return !a.has("keep") || a.get("keep").getAsBoolean();
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        if (autopilot()) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        List<Card> cards = new ArrayList<>();
        for (Card c : hand) cards.add(c);
        JsonObject p = prompt("chooseMany", "Put " + cardsToReturn + " card(s) on the bottom of your library");
        p.addProperty("min", cardsToReturn);
        p.addProperty("max", cardsToReturn);
        p.add("options", objectsJson(cards));
        JsonObject a = session.ask(p);
        if (a == null) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        CardCollection out = new CardCollection();
        for (int idx : indices(a, "options")) if (idx >= 0 && idx < cards.size() && !out.contains(cards.get(idx))) out.add(cards.get(idx));
        if (out.size() != cardsToReturn) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        return out;
    }

    // ------------------------------------------------------------------ helpers

    /** Option lists carry identity: Forge only asks a seat to choose among things that seat may see. */
    private JsonArray objectsJson(List<? extends GameObject> objects) {
        JsonArray a = new JsonArray();
        int i = 0;
        for (GameObject o : objects) {
            JsonObject j;
            if (o instanceof Card c) {
                j = SeatView.card(c, player);
                j.addProperty("kind", "card");
                if (!j.has("name")) j.addProperty("name", c.getName());
            } else if (o instanceof GameEntity e) {
                j = SeatView.entityRef(e);
            } else {
                j = new JsonObject();
                j.addProperty("kind", "other");
                j.addProperty("name", String.valueOf(o));
            }
            j.addProperty("index", i++);
            a.add(j);
        }
        return a;
    }

    private static List<Integer> indices(JsonObject a, String key) {
        List<Integer> out = new ArrayList<>();
        if (a != null && a.has(key) && a.get(key).isJsonArray()) {
            for (JsonElement e : a.getAsJsonArray(key)) out.add(e.getAsInt());
        }
        return out;
    }

    private static List<Integer> firstN(int n, int size) {
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < Math.min(n, size); i++) out.add(i);
        return out;
    }

    private static boolean isTrue(JsonObject o, String key) {
        return o.has(key) && !o.get(key).isJsonNull() && o.get(key).getAsBoolean();
    }

    private static Card byId(List<Card> cards, int id) {
        for (Card c : cards) if (c.getId() == id) return c;
        return null;
    }

    private static GameEntity defenderOf(List<GameEntity> defenders, JsonObject ref) {
        if (ref == null) return null;
        boolean wantPlayer = !ref.has("kind") || "player".equals(ref.get("kind").getAsString());
        int id = ref.get("id").getAsInt();
        for (GameEntity d : defenders) {
            if (d.getId() == id && (d instanceof Player) == wantPlayer) return d;
        }
        return null;
    }
}
