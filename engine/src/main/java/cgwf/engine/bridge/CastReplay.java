package cgwf.engine.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * "Repeat this cast N times" (owner, 2026-11-04: an infinite Sprout Swarm loop took forty separate casts, each
 * with its prompts). While a seat casts a spell the session records every prompt it answered (optional costs
 * such as buyback, convoke, targets, X, modes, cost choices). When the same card is castable again from the
 * same zone the priority prompt offers a repeat; the seat says how many, and the engine casts it that many
 * times answering each prompt from the recording, translated to the current options by name (the saprolings
 * tapped for convoke are different objects each time), letting each copy resolve in between.
 *
 * The replay stops early, and the seat is asked again as usual, when a recorded answer cannot be matched (a
 * target is gone), when the card can no longer be cast (out of mana), or when an opponent puts something on
 * the stack: nothing is ever decided for the seat that it did not decide itself in the recorded cast.
 */
public final class CastReplay {
    /** One prompt the seat answered while casting, with the answer as sent. */
    public record Step(JsonObject prompt, JsonObject answer) { }

    /** The choices of one successful cast: the card, the zone it was cast from, every prompt and answer. */
    public static final class Recording {
        private final String cardName;
        private final String zone;
        private final List<Step> steps = new ArrayList<>();

        public Recording(String cardName, String zone) {
            this.cardName = cardName;
            this.zone = zone;
        }

        public String cardName() { return cardName; }
        public String zone() { return zone; }
        public List<Step> steps() { return steps; }

        void add(JsonObject prompt, JsonObject answer) {
            steps.add(new Step(prompt.deepCopy(), answer.deepCopy()));
        }
    }

    public static final int MAX_TIMES = 500;

    private final Recording recording;
    private final int wanted;
    private int done;
    private int cursor;
    private String stopped;

    public CastReplay(Recording recording, int wanted) {
        this.recording = recording;
        this.wanted = Math.max(1, Math.min(MAX_TIMES, wanted));
    }

    public Recording recording() { return recording; }
    public String cardName() { return recording.cardName(); }
    public int wanted() { return wanted; }
    public int done() { return done; }
    /** Null while running; "done" when every repeat went through; otherwise why it stopped early. */
    public String stopReason() { return stopped; }
    public boolean active() { return stopped == null && done < wanted; }
    public boolean finished() { return "done".equals(stopped); }

    public void stop(String why) {
        if (stopped == null) stopped = why;
    }

    /** One more cast went onto the stack. */
    public void castDone() {
        done++;
        cursor = 0;
        if (done >= wanted) stopped = "done";
    }

    /** The recorded answer for this prompt, translated to its current options; null when it cannot be repeated. */
    public JsonObject answerFor(JsonObject prompt) {
        String kind = str(prompt, "prompt");
        String title = str(prompt, "title");
        List<Step> steps = recording.steps();
        int found = -1;
        for (int i = cursor; i < steps.size(); i++) if (matches(steps.get(i), kind, title)) { found = i; break; }
        if (found < 0) for (int i = 0; i < cursor && i < steps.size(); i++) if (matches(steps.get(i), kind, title)) { found = i; break; }
        if (found < 0) return null;
        cursor = found + 1;
        return translate(steps.get(found), prompt);
    }

    private static boolean matches(Step s, String kind, String title) {
        return kind.equals(str(s.prompt(), "prompt")) && title.equals(str(s.prompt(), "title"));
    }

    /** The recorded answer re-expressed against the current prompt's options (by name), or null. */
    static JsonObject translate(Step s, JsonObject prompt) {
        String kind = str(prompt, "prompt");
        switch (kind) {
            case "choose":
            case "chooseMany":
            case "targets":
            case "mode":
                return translateOptions(s, prompt, "choose".equals(kind));
            case "number":
            case "confirm":
            case "order":
            case "text":
            case "assign":
                return copyAnswer(s.answer());
            default:
                return null;
        }
    }

    private static JsonObject translateOptions(Step s, JsonObject prompt, boolean single) {
        JsonObject rec = s.answer();
        JsonObject a = new JsonObject();
        if (rec.has("cancel") && !rec.get("cancel").isJsonNull() && rec.get("cancel").getAsBoolean()) {
            a.addProperty("cancel", true);
            return a;
        }
        List<String> recordedKeys = optionKeys(s.prompt());
        List<String> currentKeys = optionKeys(prompt);
        if (single) {
            if (!rec.has("option") || rec.get("option").isJsonNull()) {
                a.add("option", null);
                return a;
            }
            int ri = rec.get("option").getAsInt();
            if (ri < 0 || ri >= recordedKeys.size()) return null;
            int ci = currentKeys.indexOf(recordedKeys.get(ri));
            if (ci < 0) return null;
            a.addProperty("option", ci);
            return a;
        }
        List<String> wanted = new ArrayList<>();
        if (rec.has("options") && rec.get("options").isJsonArray()) {
            for (JsonElement e : rec.getAsJsonArray("options")) {
                int ri = e.getAsInt();
                if (ri >= 0 && ri < recordedKeys.size()) wanted.add(recordedKeys.get(ri));
            }
        }
        Set<Integer> used = new HashSet<>();
        List<Integer> picked = new ArrayList<>();
        int missing = 0;
        for (String key : wanted) {
            int ci = -1;
            for (int i = 0; i < currentKeys.size(); i++) if (!used.contains(i) && currentKeys.get(i).equals(key)) { ci = i; break; }
            if (ci < 0) { missing++; continue; }
            used.add(ci);
            picked.add(ci);
        }
        if (missing > 0) {
            // convoke: the creatures tapped last time are tapped now; any untapped ones do the same job
            if ("convoke".equals(str(s.prompt(), "reason"))) {
                for (int i = 0; i < currentKeys.size() && picked.size() < wanted.size(); i++) {
                    if (!used.contains(i)) { used.add(i); picked.add(i); }
                }
            } else {
                return null;
            }
        }
        JsonArray arr = new JsonArray();
        for (int i : picked) arr.add(i);
        a.add("options", arr);
        return a;
    }

    /** What identifies an option across casts: its name (a card, a player, a label), else its id. */
    static List<String> optionKeys(JsonObject prompt) {
        List<String> keys = new ArrayList<>();
        JsonElement opts = prompt.get("options");
        if (opts == null || !opts.isJsonArray()) return keys;
        for (JsonElement e : opts.getAsJsonArray()) {
            JsonObject o = e.getAsJsonObject();
            String name = str(o, "name");
            if (name.isEmpty()) name = str(o, "label");
            if (!name.isEmpty()) keys.add("n:" + name);
            else if (o.has("cardId")) keys.add("c:" + o.get("cardId").getAsString());
            else if (o.has("id")) keys.add("i:" + o.get("id").getAsString());
            else keys.add("?:" + keys.size());
        }
        return keys;
    }

    private static JsonObject copyAnswer(JsonObject answer) {
        JsonObject a = answer.deepCopy();
        a.remove("promptId");
        return a;
    }

    static String str(JsonObject o, String key) {
        return o != null && o.has(key) && !o.get(key).isJsonNull() && o.get(key).isJsonPrimitive() ? o.get(key).getAsString() : "";
    }
}
