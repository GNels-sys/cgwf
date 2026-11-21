package cgwf.engine.bridge;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * "Run the loop" (owner, 2026-11-21: Enduring Tenacity + Bloodthirsty Conqueror, an infinite life-drain loop
 * made of triggers, asked three questions every round: order the triggers, pick the target, pay life to draw.
 * The game took about ninety rounds of them). {@link CastReplay} only repeats a spell cast from a priority
 * prompt; a trigger loop never comes back to one.
 *
 * {@link Watch} sees every answer a seat gives by hand. When the same run of questions has been answered the
 * same way twice in a row (three times for a single question), with nothing else done in between and inside
 * the same phase of the same turn, the next question that would start the run again carries a `loop` offer.
 * The seat answers `{loop: N}` and the engine answers the run N more times from the recording, translated to
 * the current options by name. The game still plays every round out: opponents get their priority as usual,
 * and the win comes when the loop really takes the last life.
 *
 * The loop ends early when a different question comes up, an opponent puts something on the stack, the stack
 * runs empty, or the seat's library runs out during it. When only a recorded choice is gone (the opponent it
 * targeted is out of the game) the loop pauses: that one question goes to the seat, and its answer takes the
 * old one's place for the rounds that are left. Nothing is ever decided for the seat that it did not decide
 * itself in the recorded round.
 */
public final class LoopReplay {
    public static final int MAX_TIMES = 500;
    /** The longest run of questions that counts as one round. */
    public static final int MAX_STEPS = 8;
    /** Question kinds a round may be made of: the ones an answer can be carried over for. */
    private static final Set<String> KINDS = Set.of("choose", "chooseMany", "targets", "mode", "number", "confirm", "order", "text", "assign");
    /** Besides kind and title, what must be the same for two prompts to be the same question. */
    private static final String[] SAME = {"detail", "source", "ability", "min", "max", "total", "mode", "optional", "reason", "note"};

    private final List<CastReplay.Step> steps;
    private int wanted;
    private final int libraryAtStart;
    private int done;
    private int cursor;
    private String stopped;
    private String paused;
    /** The newest stack item when the loop began (-1 = unknown): older items of an opponent's are not responses. */
    private int stackMark = -1;
    /** "Yes for N, then No for the rest": after the rounds asked for, give the other answer until it ends. */
    private boolean thenOther;
    private int flippedAt = -1;
    private final String nowLabel;
    private final String thenLabel;
    private int libraryLastRound = -1;

    public LoopReplay(List<CastReplay.Step> steps, int wanted, int libraryAtStart) {
        this.steps = new ArrayList<>(steps);
        this.wanted = Math.max(1, Math.min(MAX_TIMES, wanted));
        this.libraryAtStart = libraryAtStart;
        JsonObject flip = flipJson(steps);
        this.nowLabel = flip == null ? "" : flip.get("now").getAsString();
        this.thenLabel = flip == null ? "" : flip.get("then").getAsString();
    }

    public void stackMark(int newestStackId) { this.stackMark = newestStackId; }
    public int stackMark() { return stackMark; }

    /** After the rounds asked for, answer the other way until the loop ends (a single yes/no question only). */
    public void thenOther() { thenOther = flipJson(steps) != null; }
    public boolean flipped() { return flippedAt >= 0; }

    public int steps() { return steps.size(); }
    public int wanted() { return wanted; }
    /** Whole rounds answered so far. */
    public int done() { return done; }
    /** Null while running; "done" when every round went through; otherwise why it ended early. */
    public String stopReason() { return stopped; }
    public boolean active() { return stopped == null; }
    public boolean finished() { return "done".equals(stopped); }
    /** Why the question in hand went to the seat although the loop is still on; null when it did not. */
    public String pauseReason() { return paused; }

    public void stop(String why) {
        if (stopped == null) stopped = why;
        paused = null;
    }

    /**
     * The recorded answer to this prompt, for the current options. Null when the seat has to answer: then the
     * loop is either over ({@link #active} is false) or paused on this one question ({@link #pauseReason}).
     */
    public JsonObject answerFor(JsonObject prompt) {
        paused = null;
        if (!active()) return null;
        int library = libraryOf(prompt);
        if (libraryAtStart > 0 && library == 0) {
            stop("your library is empty");
            return null;
        }
        if (cursor == 0 && library >= 0) {
            // a round that draws more cards than are left would lose the game: stop before it
            int drew = libraryLastRound < 0 ? 0 : libraryLastRound - library;
            if (drew > 0 && library < drew) {
                stop("your library has only " + library + (library == 1 ? " card" : " cards") + " left");
                return null;
            }
            libraryLastRound = library;
        }
        CastReplay.Step s = steps.get(cursor);
        if (!signature(prompt).equals(signature(s.prompt()))) {
            String title = CastReplay.str(prompt, "title");
            stop("a different question came up" + (title.isEmpty() ? "" : ": \"" + title + "\""));
            return null;
        }
        JsonObject a = translate(s, prompt);
        if (a == null) {
            String gone = missing(s, prompt);
            paused = gone == null ? "an earlier choice cannot be repeated" : gone + " is no longer a choice";
            return null;
        }
        advance();
        return a;
    }

    /** The seat answered the paused question by hand: that answer stands for the rounds that are left. */
    public void resume(JsonObject prompt, JsonObject answer) {
        if (!active() || paused == null) return;
        steps.set(cursor, new CastReplay.Step(stripped(prompt), strippedAnswer(answer)));
        paused = null;
        advance();
    }

    private void advance() {
        cursor++;
        if (cursor >= steps.size()) {
            cursor = 0;
            done++;
            if (done >= wanted) {
                if (thenOther && flip()) {
                    thenOther = false;
                    flippedAt = done;
                    wanted = done + MAX_TIMES;
                } else {
                    stopped = "done";
                }
            }
        }
    }

    /** Turns the single yes/no round's answer into the other one. */
    private boolean flip() {
        if (flipJson(steps) == null) return false;
        CastReplay.Step s = steps.get(0);
        JsonObject a = s.answer().deepCopy();
        a.addProperty("confirm", !a.get("confirm").getAsBoolean());
        steps.set(0, new CastReplay.Step(s.prompt(), a));
        return true;
    }

    /** For a round that is one yes/no question: the answer given now and the other one, by their button labels; else null. */
    static JsonObject flipJson(List<CastReplay.Step> cycle) {
        if (cycle.size() != 1) return null;
        CastReplay.Step s = cycle.get(0);
        if (!"confirm".equals(CastReplay.str(s.prompt(), "prompt"))) return null;
        JsonObject a = s.answer();
        if (!a.has("confirm") || !a.get("confirm").isJsonPrimitive() || !a.get("confirm").getAsJsonPrimitive().isBoolean()) return null;
        String yes = "Yes";
        String no = "No";
        JsonElement opts = s.prompt().get("options");
        if (opts != null && opts.isJsonArray() && opts.getAsJsonArray().size() >= 2 && opts.getAsJsonArray().get(0).isJsonPrimitive() && opts.getAsJsonArray().get(1).isJsonPrimitive()) {
            yes = opts.getAsJsonArray().get(0).getAsString();
            no = opts.getAsJsonArray().get(1).getAsString();
        }
        boolean said = a.get("confirm").getAsBoolean();
        JsonObject j = new JsonObject();
        j.addProperty("now", said ? yes : no);
        j.addProperty("then", said ? no : yes);
        return j;
    }

    /** The loop's state for the paused prompt: why, rounds done, rounds left. */
    public JsonObject pausedJson() {
        JsonObject j = new JsonObject();
        j.addProperty("reason", paused == null ? "" : paused);
        j.addProperty("done", done);
        j.addProperty("left", Math.max(0, wanted - done));
        return j;
    }

    /** What the seat is told when the loop is over. */
    public String summary() {
        String ran = "The loop ran " + done + (done == 1 ? " time" : " times");
        if (flippedAt >= 0) {
            int rest = done - flippedAt;
            ran = "The loop answered \"" + nowLabel + "\" " + flippedAt + (flippedAt == 1 ? " time" : " times") + ", then \"" + thenLabel + "\" " + rest + (rest == 1 ? " time" : " times");
        }
        if (finished() || stopped == null) return ran + ".";
        return ran + "; it stopped because " + stopped + ".";
    }

    // ------------------------------------------------------------------ spotting a loop

    /** The answers a seat gave by hand, newest last; finds a run of questions answered the same way again and again. */
    public static final class Watch {
        private final List<CastReplay.Step> history = new ArrayList<>();
        private final List<String> keys = new ArrayList<>();
        private String scope = "";

        /** A new turn or phase starts a new history: the same "you may" at three upkeeps is not a loop. */
        public void scope(String s) {
            String next = s == null ? "" : s;
            if (!next.equals(scope)) {
                clear();
                scope = next;
            }
        }

        public void clear() {
            history.clear();
            keys.clear();
        }

        public int size() { return history.size(); }

        /** The seat answered `prompt` by hand. */
        public void add(JsonObject prompt, JsonObject answer) {
            String kind = CastReplay.str(prompt, "prompt");
            if ("priority".equals(kind)) {
                if (!isPlainPass(answer)) clear(); // playing something, or ending the turn, breaks the run
                return;
            }
            if (!KINDS.contains(kind) || isTrue(answer, "cancel")) {
                clear();
                return;
            }
            CastReplay.Step s = new CastReplay.Step(stripped(prompt), strippedAnswer(answer));
            history.add(s);
            keys.add(signature(s.prompt()) + "\u0001" + answerKey(s));
            int keep = MAX_STEPS * 3;
            while (history.size() > keep) {
                history.remove(0);
                keys.remove(0);
            }
        }

        /**
         * The round the seat keeps repeating, when `next` is its first question again and the recorded answer
         * still fits; else null. The shortest round wins.
         */
        public List<CastReplay.Step> cycleFor(JsonObject next) {
            int n = keys.size();
            for (int len = 1; len <= MAX_STEPS; len++) {
                int need = len == 1 ? 3 : 2;
                if (n < len * need) break;
                if (rounds(len) < need) continue;
                List<CastReplay.Step> cycle = new ArrayList<>(history.subList(n - len, n));
                CastReplay.Step first = cycle.get(0);
                if (!signature(next).equals(signature(first.prompt()))) continue;
                if (translate(first, next) == null) continue;
                return cycle;
            }
            return null;
        }

        /** How many times in a row the last `len` answers repeat at the end of the history (1 = no repeat). */
        public int rounds(int len) {
            int n = keys.size();
            if (len <= 0 || n < len) return 0;
            int r = 1;
            while (n - (r + 1) * len >= 0) {
                boolean same = true;
                for (int i = 0; i < len && same; i++) same = keys.get(n - 1 - i).equals(keys.get(n - 1 - i - r * len));
                if (!same) break;
                r++;
            }
            return r;
        }
    }

    /** The offer that rides on a prompt: how long the round is, how often it was seen, the questions in it. */
    public static JsonObject offerJson(List<CastReplay.Step> cycle, int seen) {
        JsonObject j = new JsonObject();
        j.addProperty("steps", cycle.size());
        j.addProperty("seen", seen);
        j.addProperty("max", MAX_TIMES);
        StringBuilder key = new StringBuilder();
        JsonArray titles = new JsonArray();
        for (CastReplay.Step s : cycle) {
            titles.add(CastReplay.str(s.prompt(), "title"));
            key.append(signature(s.prompt())).append('\u0001').append(answerKey(s)).append('\u0002');
        }
        j.add("titles", titles);
        JsonObject flip = flipJson(cycle);
        if (flip != null) j.add("flip", flip); // one yes/no question: "Yes for N, then No for the rest" is possible
        j.addProperty("key", Integer.toHexString(key.toString().hashCode()));
        return j;
    }

    // ------------------------------------------------------------------ carrying an answer over

    /** What makes two prompts the same question (never the options: those are matched by name). */
    static String signature(JsonObject prompt) {
        StringBuilder b = new StringBuilder(CastReplay.str(prompt, "prompt")).append('\u0001').append(CastReplay.str(prompt, "title"));
        for (String f : SAME) b.append('\u0001').append(CastReplay.str(prompt, f));
        return b.toString();
    }

    /** The recorded answer against the current prompt, or null when it cannot be given again. */
    static JsonObject translate(CastReplay.Step s, JsonObject prompt) {
        String kind = CastReplay.str(prompt, "prompt");
        switch (kind) {
            case "choose":
            case "chooseMany":
            case "targets":
                return CastReplay.translate(s, prompt);
            case "order":
                return translateOrder(s, prompt);
            case "assign":
                // positional amounts: only when the same things stand in the same places
                return keysOf(s.prompt(), "targets").equals(keysOf(prompt, "targets")) ? strippedAnswer(s.answer()) : null;
            case "mode":
                return keysOf(s.prompt(), "modes").equals(keysOf(prompt, "modes")) ? strippedAnswer(s.answer()) : null;
            case "number":
            case "confirm":
            case "text":
                return strippedAnswer(s.answer());
            default:
                return null;
        }
    }

    /** An order by item name: the same things, first to last, wherever they sit in the list this time. */
    private static JsonObject translateOrder(CastReplay.Step s, JsonObject prompt) {
        List<String> recorded = keysOf(s.prompt(), "items");
        List<String> current = keysOf(prompt, "items");
        if (recorded.size() != current.size()) return null;
        JsonObject rec = s.answer();
        List<Integer> recOrder = new ArrayList<>();
        if (rec.has("order") && rec.get("order").isJsonArray()) {
            for (JsonElement e : rec.getAsJsonArray("order")) {
                int i = e.getAsInt();
                if (i >= 0 && i < recorded.size() && !recOrder.contains(i)) recOrder.add(i);
            }
        }
        for (int i = 0; i < recorded.size(); i++) if (!recOrder.contains(i)) recOrder.add(i); // the engine's own rule for what was left out
        JsonObject recBuckets = rec.has("buckets") && rec.get("buckets").isJsonObject() ? rec.getAsJsonObject("buckets") : new JsonObject();
        Set<Integer> used = new HashSet<>();
        JsonArray order = new JsonArray();
        JsonObject buckets = new JsonObject();
        for (int ri : recOrder) {
            int ci = -1;
            for (int i = 0; i < current.size(); i++) if (!used.contains(i) && current.get(i).equals(recorded.get(ri))) { ci = i; break; }
            if (ci < 0) return null;
            used.add(ci);
            order.add(ci);
            String b = String.valueOf(ri);
            if (recBuckets.has(b) && !recBuckets.get(b).isJsonNull()) buckets.addProperty(String.valueOf(ci), recBuckets.get(b).getAsString());
        }
        JsonObject a = new JsonObject();
        a.add("order", order);
        a.add("buckets", buckets);
        return a;
    }

    /** The first recorded pick that is not among the current options, by its name; null when none is missing. */
    private static String missing(CastReplay.Step s, JsonObject prompt) {
        String list = "order".equals(CastReplay.str(prompt, "prompt")) ? "items" : "options";
        List<String> recorded = keysOf(s.prompt(), list);
        List<String> current = keysOf(prompt, list);
        JsonObject rec = s.answer();
        List<Integer> picked = new ArrayList<>();
        if (rec.has("option") && !rec.get("option").isJsonNull()) picked.add(rec.get("option").getAsInt());
        if (rec.has("options") && rec.get("options").isJsonArray()) for (JsonElement e : rec.getAsJsonArray("options")) picked.add(e.getAsInt());
        if (picked.isEmpty()) for (int i = 0; i < recorded.size(); i++) picked.add(i);
        for (int i : picked) {
            if (i < 0 || i >= recorded.size()) continue;
            String key = recorded.get(i);
            if (!current.contains(key)) return key.startsWith("n:") ? key.substring(2) : null;
        }
        return null;
    }

    /** The answer as names, so the same choice among different objects reads the same. */
    static String answerKey(CastReplay.Step s) {
        JsonObject a = s.answer();
        String kind = CastReplay.str(s.prompt(), "prompt");
        List<String> names = keysOf(s.prompt(), "order".equals(kind) ? "items" : "options");
        StringBuilder b = new StringBuilder();
        if (a.has("option")) b.append("o:").append(a.get("option").isJsonNull() ? "none" : name(names, a.get("option").getAsInt()));
        if (a.has("options") && a.get("options").isJsonArray()) {
            b.append("m:");
            for (JsonElement e : a.getAsJsonArray("options")) b.append(name(names, e.getAsInt())).append('\u0003');
        }
        if (a.has("order") && a.get("order").isJsonArray()) {
            b.append("r:");
            for (JsonElement e : a.getAsJsonArray("order")) b.append(name(names, e.getAsInt())).append('\u0003');
            if (a.has("buckets")) b.append(a.get("buckets"));
        }
        for (String f : new String[] {"confirm", "value", "text", "amounts", "modes"}) if (a.has(f)) b.append(f).append('=').append(a.get(f));
        return b.toString();
    }

    private static String name(List<String> names, int i) {
        return i >= 0 && i < names.size() ? names.get(i) : "#" + i;
    }

    /** {@link CastReplay#optionKeys} for any list of the prompt ("options", "items", "targets", "modes"). */
    static List<String> keysOf(JsonObject prompt, String list) {
        JsonObject shim = new JsonObject();
        JsonElement arr = prompt.get(list);
        if (arr != null && arr.isJsonArray()) {
            JsonArray named = new JsonArray();
            for (JsonElement e : arr.getAsJsonArray()) {
                if (!e.isJsonObject()) { // a confirm's two button labels are plain strings
                    JsonObject c = new JsonObject();
                    c.addProperty("name", e.isJsonPrimitive() ? e.getAsString() : e.toString());
                    named.add(c);
                    continue;
                }
                JsonObject o = e.getAsJsonObject();
                if (!o.has("name") && !o.has("label") && o.has("text")) { // modes carry their text
                    JsonObject c = o.deepCopy();
                    c.addProperty("name", CastReplay.str(o, "text"));
                    named.add(c);
                } else {
                    named.add(o);
                }
            }
            shim.add("options", named);
        }
        return CastReplay.optionKeys(shim);
    }

    /** The seat's own library size as the prompt's view shows it; -1 when the prompt carries no view. */
    static int libraryOf(JsonObject prompt) {
        JsonElement v = prompt.get("view");
        if (v == null || !v.isJsonObject()) return -1;
        JsonObject view = v.getAsJsonObject();
        if (!view.has("viewer") || view.get("viewer").isJsonNull() || !view.has("players") || !view.get("players").isJsonArray()) return -1;
        int me = view.get("viewer").getAsInt();
        for (JsonElement e : view.getAsJsonArray("players")) {
            JsonObject p = e.getAsJsonObject();
            if (p.has("id") && p.get("id").getAsInt() == me && p.has("libraryCount")) return p.get("libraryCount").getAsInt();
        }
        return -1;
    }

    /** Turn and phase of the prompt's view: a round never spans two of them. */
    static String scopeOf(JsonObject prompt) {
        JsonElement v = prompt.get("view");
        if (v == null || !v.isJsonObject()) return "";
        JsonObject view = v.getAsJsonObject();
        return CastReplay.str(view, "turn") + ":" + CastReplay.str(view, "phase");
    }

    /** The prompt without the table state it carries (large, and never part of the question). */
    static JsonObject stripped(JsonObject prompt) {
        JsonObject p = new JsonObject();
        for (String k : prompt.keySet()) {
            if ("view".equals(k) || "loop".equals(k) || "loopPaused".equals(k) || "promptId".equals(k) || "type".equals(k)) continue;
            p.add(k, prompt.get(k).deepCopy());
        }
        return p;
    }

    static JsonObject strippedAnswer(JsonObject answer) {
        JsonObject a = answer.deepCopy();
        a.remove("promptId");
        a.remove("loop");
        a.remove("then");
        a.remove("stopLoop");
        return a;
    }

    static boolean isTrue(JsonObject a, String key) {
        return a != null && a.has(key) && a.get(key).isJsonPrimitive() && a.get(key).getAsJsonPrimitive().isBoolean() && a.get(key).getAsBoolean();
    }

    /** A priority answer that only passes: no play, no "end turn", no concede. */
    private static boolean isPlainPass(JsonObject a) {
        if (a == null) return false;
        if (a.has("option") && !a.get("option").isJsonNull()) return false;
        if (a.has("passUntilTurn") && !a.get("passUntilTurn").isJsonNull()) return false;
        return !isTrue(a, "concede");
    }
}
