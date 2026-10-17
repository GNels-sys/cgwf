package cgwf.engine;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * A very simple human: the same policy as spike/client.mjs, in Java, so tests can drive a
 * BridgeController without a socket. Plays a land when offered, casts the cheapest spell (at
 * most two per step), attacks the lowest-life opponent with everything, blocks what it can
 * survive, takes the first option otherwise, always keeps.
 */
public final class ScriptedSeat {
    private ScriptedSeat() { }

    public static JsonObject answer(JsonObject prompt, int myPlayerId) {
        JsonObject a = new JsonObject();
        a.addProperty("type", "answer");
        a.add("promptId", prompt.get("promptId"));
        String kind = prompt.has("prompt") ? prompt.get("prompt").getAsString() : "";
        switch (kind) {
            case "priority" -> {
                JsonArray opts = prompt.getAsJsonArray("options");
                Integer land = null;
                List<JsonObject> spells = new ArrayList<>();
                for (JsonElement e : opts) {
                    JsonObject o = e.getAsJsonObject();
                    String k = o.get("kind").getAsString();
                    if (k.equals("land") && land == null) land = o.get("index").getAsInt();
                    if (k.equals("spell")) spells.add(o);
                }
                if (land != null) a.addProperty("option", land);
                else if (!spells.isEmpty() && prompt.has("stackEmpty") && prompt.get("stackEmpty").getAsBoolean()) {
                    spells.sort(Comparator.comparingInt(o -> o.has("cost") && !o.get("cost").isJsonNull() ? o.get("cost").getAsString().length() : 0));
                    a.addProperty("option", spells.get(0).get("index").getAsInt());
                } else a.add("option", null);
            }
            case "targets" -> {
                JsonArray opts = prompt.getAsJsonArray("options");
                int min = Math.max(1, prompt.get("min").getAsInt());
                JsonArray picks = new JsonArray();
                // prefer things that are not mine
                for (JsonElement e : opts) {
                    JsonObject o = e.getAsJsonObject();
                    boolean mine = (o.has("controller") && !o.get("controller").isJsonNull() && o.get("controller").getAsInt() == myPlayerId)
                            || ("player".equals(o.get("kind").getAsString()) && o.get("id").getAsInt() == myPlayerId);
                    if (!mine && picks.size() < min) picks.add(o.get("index").getAsInt());
                }
                for (JsonElement e : opts) {
                    if (picks.size() >= min) break;
                    picks.add(e.getAsJsonObject().get("index").getAsInt());
                }
                a.add("options", picks);
            }
            case "attackers" -> {
                JsonObject target = null;
                for (JsonElement e : prompt.getAsJsonArray("defenders")) {
                    JsonObject d = e.getAsJsonObject();
                    if (!"player".equals(d.get("kind").getAsString())) continue;
                    if (target == null || d.get("life").getAsInt() < target.get("life").getAsInt()) target = d;
                }
                JsonArray attacks = new JsonArray();
                for (JsonElement e : prompt.getAsJsonArray("candidates")) {
                    JsonObject c = e.getAsJsonObject();
                    if (!c.has("power") || c.get("power").getAsInt() <= 0) continue;
                    JsonObject chosen = null;
                    for (JsonElement d : c.getAsJsonArray("canAttack")) {
                        JsonObject dj = d.getAsJsonObject();
                        if (target != null && "player".equals(dj.get("kind").getAsString()) && dj.get("id").getAsInt() == target.get("id").getAsInt()) chosen = dj;
                    }
                    if (chosen == null && c.getAsJsonArray("canAttack").size() > 0) chosen = c.getAsJsonArray("canAttack").get(0).getAsJsonObject();
                    if (chosen == null) continue;
                    JsonObject att = new JsonObject();
                    att.addProperty("cardId", c.get("id").getAsInt());
                    JsonObject ref = new JsonObject();
                    ref.addProperty("kind", chosen.get("kind").getAsString());
                    ref.addProperty("id", chosen.get("id").getAsInt());
                    att.add("defender", ref);
                    attacks.add(att);
                }
                a.add("attacks", attacks);
            }
            case "blockers" -> {
                JsonArray blocks = new JsonArray();
                List<Integer> used = new ArrayList<>();
                for (JsonElement e : prompt.getAsJsonArray("attackers")) {
                    JsonObject att = e.getAsJsonObject();
                    int power = att.has("power") ? att.get("power").getAsInt() : 0;
                    for (JsonElement b : prompt.getAsJsonArray("blockers")) {
                        JsonObject bj = b.getAsJsonObject();
                        int id = bj.get("id").getAsInt();
                        if (used.contains(id)) continue;
                        int toughness = bj.has("toughness") ? bj.get("toughness").getAsInt() : 0;
                        boolean can = false;
                        for (JsonElement x : bj.getAsJsonArray("canBlock")) if (x.getAsInt() == att.get("id").getAsInt()) can = true;
                        if (can && toughness > power) {
                            JsonObject blk = new JsonObject();
                            blk.addProperty("blockerId", id);
                            blk.addProperty("attackerId", att.get("id").getAsInt());
                            blocks.add(blk);
                            used.add(id);
                            break;
                        }
                    }
                }
                a.add("blocks", blocks);
            }
            case "choose" -> {
                JsonArray opts = prompt.getAsJsonArray("options");
                if (opts.size() > 0) a.addProperty("option", 0);
                else a.add("option", null);
            }
            case "chooseMany" -> {
                int min = prompt.get("min").getAsInt();
                JsonArray picks = new JsonArray();
                JsonArray opts = prompt.getAsJsonArray("options");
                for (int i = 0; i < Math.min(min, opts.size()); i++) picks.add(i);
                a.add("options", picks);
            }
            case "confirm" -> a.addProperty("confirm", true);
            case "mulligan" -> a.addProperty("keep", true);
            default -> { }
        }
        return a;
    }
}
