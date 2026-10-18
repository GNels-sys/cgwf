package cgwf.engine.bridge;

import forge.ai.AiCostDecision;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardLists;
import forge.game.cost.CostDiscard;
import forge.game.cost.CostExile;
import forge.game.cost.CostReturn;
import forge.game.cost.CostSacrifice;
import forge.game.cost.CostTapType;
import forge.game.cost.PaymentDecision;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

import java.util.ArrayList;
import java.util.List;

/**
 * Decides how the human seat pays a cost. Forge's AI decider does everything (mana, life, counters)
 * and is kept as the base; the parts where a PLAYER must choose WHICH cards go (sacrifice, discard,
 * tap, exile, return to hand) are asked through the bridge instead. Everything the seat does not
 * answer falls back to the AI's pick, so a payment never hangs.
 */
final class BridgeCostDecision extends AiCostDecision {
    private final BridgeController ctl;

    BridgeCostDecision(BridgeController ctl, Player player, SpellAbility sa, boolean effect) {
        super(player, sa, effect);
        this.ctl = ctl;
    }

    private String sourceName() { return source == null ? "the ability" : source.getName(); }

    private PaymentDecision pick(String verb, List<Card> valid, int n) {
        if (n <= 0) return PaymentDecision.card(new CardCollection());
        if (valid.size() < n) return null;
        if (valid.size() == n) return PaymentDecision.card(new CardCollection(valid));
        List<Card> chosen = ctl.chooseCards(verb + " " + n + (n == 1 ? " card" : " cards") + " for " + sourceName(), sourceName(), valid, n, n, "cost");
        return chosen == null ? null : PaymentDecision.card(new CardCollection(chosen));
    }

    @Override
    public PaymentDecision visit(CostSacrifice cost) {
        if (ctl.autopilot() || cost.payCostFromSource() || "OriginalHost".equals(cost.getType()) || "All".equals(cost.getAmount())) {
            return super.visit(cost);
        }
        int n = cost.getAbilityAmount(ability);
        List<Card> valid = new ArrayList<>();
        for (Card c : CardLists.getValidCards(player.getCardsIn(ZoneType.Battlefield), cost.getType().split(";"), player, source, ability)) {
            if (c.canBeSacrificedBy(ability, isEffect())) valid.add(c);
        }
        PaymentDecision d = pick("Sacrifice", valid, n);
        return d == null ? super.visit(cost) : d;
    }

    @Override
    public PaymentDecision visit(CostDiscard cost) {
        String type = cost.getType();
        if (ctl.autopilot() || cost.payCostFromSource() || type.equals("LastDrawn") || type.equals("Hand") || type.equals("Random")
                || type.contains("WithSameName") || type.contains("+WithDifferentNames")) {
            return super.visit(cost);
        }
        int n = cost.getAbilityAmount(ability);
        List<Card> valid = new ArrayList<>(CardLists.getValidCards(player.getCardsIn(ZoneType.Hand), type.split(";"), player, source, ability));
        PaymentDecision d = pick("Discard", valid, n);
        return d == null ? super.visit(cost) : d;
    }

    @Override
    public PaymentDecision visit(CostTapType cost) {
        String type = cost.getType();
        if (ctl.autopilot() || type.contains("+withTotalPowerGE") || type.contains("sharesCreatureTypeWith")) return super.visit(cost);
        int n = cost.getAbilityAmount(ability);
        List<Card> valid = new ArrayList<>();
        for (Card c : CardLists.getValidCards(player.getCardsIn(ZoneType.Battlefield), type.split(";"), player, source, ability)) {
            if (c.isTapped()) continue;
            if (!cost.canTapSource && c == source) continue;
            valid.add(c);
        }
        PaymentDecision d = pick("Tap", valid, n);
        return d == null ? super.visit(cost) : d;
    }

    @Override
    public PaymentDecision visit(CostExile cost) {
        String type = cost.getType();
        if (ctl.autopilot() || cost.payCostFromSource() || type.equals("All") || type.contains("FromTopGrave") || type.contains("+withTotalCMCGE")
                || cost.zoneRestriction == 0 || (cost.getFrom().size() == 1 && cost.getFrom().get(0) == ZoneType.Library)) {
            return super.visit(cost);
        }
        int n = cost.getAbilityAmount(ability);
        CardCollection pool = new CardCollection();
        for (ZoneType z : cost.getFrom()) pool.addAll(cost.zoneRestriction != 1 ? player.getGame().getCardsIn(z) : player.getCardsIn(z));
        List<Card> valid = new ArrayList<>(CardLists.getValidCards(pool, type.split(";"), player, source, ability));
        PaymentDecision d = pick("Exile", valid, n);
        return d == null ? super.visit(cost) : d;
    }

    @Override
    public PaymentDecision visit(CostReturn cost) {
        if (ctl.autopilot() || cost.payCostFromSource()) return super.visit(cost);
        int n = cost.getAbilityAmount(ability);
        List<Card> valid = new ArrayList<>(CardLists.getValidCards(player.getCardsIn(ZoneType.Battlefield), cost.getType().split(";"), player, source, ability));
        PaymentDecision d = pick("Return to hand", valid, n);
        return d == null ? super.visit(cost) : d;
    }
}
