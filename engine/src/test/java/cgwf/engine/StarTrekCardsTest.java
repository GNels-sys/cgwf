package cgwf.engine;

import forge.StaticData;
import forge.card.CardDb;
import forge.item.PaperCard;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Star Trek (TRK) and Star Trek Commander (TRC), released 2026-11-13: every card resolves in the pinned Forge
 * to a scripted card of that set (not a name-only guess), and the scripts fixed between Forge 2.0.15 and 2.0.16
 * carry the fix. Forge 2.0.15 had scripts for only 29 of the set's new cards (spoiler-time), so games dropped
 * or refused the rest. The list is src/test/resources/star-trek-cards.tsv. After a Forge bump, a new set
 * that players can already add to decks gets the same kind of test. Needs -Dforge.assets.
 */
class StarTrekCardsTest {
    record Ref(String name, String set, String number) { }

    private static final List<Ref> CARDS = new ArrayList<>();

    @BeforeAll
    static void boot() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)),
                "set -Dforge.assets=/path/to/forge-gui (or FORGE_ASSETS) to run the Star Trek card test");
        ForgeBoot.init(Path.of(assets), true);
        try (var in = Objects.requireNonNull(StarTrekCardsTest.class.getResourceAsStream("/star-trek-cards.tsv"));
             var r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.isBlank() || line.startsWith("#")) continue;
                String[] p = line.split("\t");
                CARDS.add(new Ref(p[0], p[1], p.length > 2 ? p[2] : null));
            }
        }
    }

    @Test
    void everyStarTrekCardIsPlayable() {
        assertEquals(131, CARDS.size(), "the TRK + TRC list");
        CardDb db = StaticData.instance().getCommonCards();
        Map<String, String> editions = DeckLoader.editionMap();
        List<String> missing = new ArrayList<>();
        List<String> nameOnly = new ArrayList<>();
        for (Ref c : CARDS) {
            int[] tally = new int[3];
            PaperCard pc = DeckLoader.resolve(db, editions, new DeckLoader.CardRef(c.name(), c.set(), c.number(), null, 1), tally);
            if (pc == null) missing.add(c.name());
            else if (tally[2] > 0) nameOnly.add(c.name() + " (" + c.set() + ")");
        }
        assertTrue(missing.isEmpty(), "Forge cannot play " + missing.size() + " Star Trek cards: " + missing);
        // Reprints in TRC may resolve by name if Forge files them under another set; new cards must be in their set.
        assertTrue(nameOnly.size() <= 10, "too many Star Trek cards found only by name (no TRK/TRC printing in Forge): " + nameOnly);
    }

    @Test
    void scriptsFixedSinceForge2015CarryTheFix() {
        CardDb db = StaticData.instance().getCommonCards();
        // Seven of Nine: "Whenever you face a dilemma, draw a card." 2.0.15 drew for the triggered player.
        String seven = String.join("\n", script(db.getCard("Seven of Nine")));
        assertTrue(seven.contains("SVar:TrigDraw:DB$ Draw") && !seven.contains("TriggeredPlayer"), seven);
        // Salt Vampire: you choose the nonland card from the opponent's hand and that player exiles it.
        String vampire = String.join("\n", script(db.getCard("Salt Vampire")));
        assertTrue(vampire.contains("Chooser$ You"), vampire);
    }

    private static List<String> script(PaperCard pc) {
        assertTrue(pc != null, "card known");
        List<String> out = new ArrayList<>();
        var face = pc.getRules().getMainPart();
        for (var e : face.getVariables()) out.add("SVar:" + e.getKey() + ":" + e.getValue());
        face.getTriggers().forEach(t -> out.add("T:" + t));
        return out;
    }
}
