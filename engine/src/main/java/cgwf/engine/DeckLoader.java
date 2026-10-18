package cgwf.engine;

import com.google.gson.Gson;
import forge.card.CardDb;
import forge.card.CardEdition;
import forge.deck.CardPool;
import forge.deck.Deck;
import forge.deck.DeckSection;
import forge.item.PaperCard;
import forge.model.FModel;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Turns a CGwF-style deck JSON ({@code name, commanders[], main[]}; cards carry
 * {@code name, setCode, number, scryfallId, count}) into a Forge {@link Deck}.
 * Printing resolution order: exact set + collector number, then set, then name only.
 */
public final class DeckLoader {
    public record CardRef(String name, String setCode, String number, String scryfallId, int count) { }
    /** {@code companions}: the deck's companion (Forge looks for it in the sideboard before the game). */
    public record DeckSpec(String name, String code, List<CardRef> commanders, List<CardRef> main, List<CardRef> companions) {
        public DeckSpec(String name, String code, List<CardRef> commanders, List<CardRef> main) { this(name, code, commanders, main, List.of()); }
    }
    public record Loaded(Deck deck, DeckSpec spec, int exactPrinting, int bySetOnly, int byNameOnly, List<String> missing) {
        public int resolved() { return exactPrinting + bySetOnly + byNameOnly; }
    }

    private static final Gson GSON = new Gson();

    private DeckLoader() { }

    public static DeckSpec read(Path json) throws IOException {
        DeckSpec spec = GSON.fromJson(Files.readString(json), DeckSpec.class);
        if (spec == null || spec.main() == null) throw new IOException("Not a deck file: " + json);
        return new DeckSpec(spec.name() == null ? json.getFileName().toString() : spec.name(), spec.code(),
                spec.commanders() == null ? List.of() : spec.commanders(), spec.main(), spec.companions() == null ? List.of() : spec.companions());
    }

    /** A deck sent inline over the control socket (same shape as the files). */
    public static DeckSpec parse(com.google.gson.JsonElement json) {
        DeckSpec spec = GSON.fromJson(json, DeckSpec.class);
        if (spec == null || spec.main() == null) throw new IllegalArgumentException("deck needs a main list");
        return new DeckSpec(spec.name() == null ? "Deck" : spec.name(), spec.code(),
                spec.commanders() == null ? List.of() : spec.commanders(), spec.main(), spec.companions() == null ? List.of() : spec.companions());
    }

    public static Loaded build(DeckSpec spec) {
        CardDb db = FModel.getMagicDb().getCommonCards();
        Map<String, String> scryfallToForge = editionMap();
        Deck deck = new Deck(spec.name());
        int[] tally = new int[3];
        List<String> missing = new ArrayList<>();
        addAll(db, scryfallToForge, deck.getMain(), spec.main(), tally, missing);
        if (!spec.commanders().isEmpty()) {
            addAll(db, scryfallToForge, deck.getOrCreate(DeckSection.Commander), spec.commanders(), tally, missing);
        }
        if (spec.companions() != null && !spec.companions().isEmpty()) {
            // Forge's Player.assignCompanion looks in the sideboard and asks the player whether to use it
            addAll(db, scryfallToForge, deck.getOrCreate(DeckSection.Sideboard), spec.companions(), tally, missing);
        }
        return new Loaded(deck, spec, tally[0], tally[1], tally[2], missing);
    }

    private static void addAll(CardDb db, Map<String, String> map, CardPool pool, List<CardRef> refs, int[] tally, List<String> missing) {
        for (CardRef ref : refs) {
            PaperCard pc = resolve(db, map, ref, tally);
            if (pc == null) missing.add(ref.name());
            else pool.add(pc, Math.max(1, ref.count()));
        }
    }

    static PaperCard resolve(CardDb db, Map<String, String> map, CardRef c, int[] tally) {
        String set = c.setCode() == null ? null : map.getOrDefault(c.setCode().toUpperCase(Locale.ROOT), c.setCode().toUpperCase(Locale.ROOT));
        PaperCard pc;
        if (set != null && c.number() != null) {
            pc = db.getCard(c.name(), set, c.number());
            if (pc != null) { tally[0]++; return pc; }
        }
        if (set != null) {
            pc = db.getCard(c.name(), set);
            if (pc != null) { tally[1]++; return pc; }
        }
        pc = db.getCard(c.name());
        if (pc == null && c.name().contains(" // ")) pc = db.getCard(c.name().substring(0, c.name().indexOf(" // ")));
        if (pc != null) tally[2]++;
        return pc;
    }

    /** Scryfall set code (upper case) to Forge edition code; identical for most sets. */
    public static Map<String, String> editionMap() {
        Map<String, String> map = new HashMap<>();
        for (CardEdition e : FModel.getMagicDb().getEditions()) {
            map.put(e.getScryfallCode().toUpperCase(Locale.ROOT), e.getCode());
        }
        return map;
    }

    /** Loads up to {@code max} deck files (sorted by name) from a directory. */
    public static List<Loaded> loadDir(Path dir, int max) throws IOException {
        List<Path> files;
        try (var s = Files.list(dir)) {
            files = s.filter(p -> p.toString().endsWith(".json")).sorted().limit(max).toList();
        }
        List<Loaded> out = new ArrayList<>();
        for (Path p : files) out.add(build(read(p)));
        return out;
    }
}
