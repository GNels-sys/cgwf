package cgwf.engine;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Non-negotiable #3 for the engine: no seat's view ever contains another seat's hand or any
 * library's contents. Needs Forge's resources: run with {@code mvn test -Dforge.assets=/path/to/forge-gui}
 * (or FORGE_ASSETS in the environment); skipped when they are absent so a plain CI build stays green.
 */
class HiddenInformationTest {

    @Test
    void noSeatEverSeesAnotherHandOrAnyLibrary() throws Exception {
        String assets = System.getProperty("forge.assets");
        if (assets == null || assets.isBlank() || assets.startsWith("${")) assets = System.getenv("FORGE_ASSETS");
        Assumptions.assumeTrue(assets != null && !assets.isBlank() && Files.isDirectory(Path.of(assets)),
                "set -Dforge.assets=/path/to/forge-gui (or FORGE_ASSETS) to run the hidden-information audit");
        Path decks = Path.of(System.getProperty("cgwf.decks", "spike/decks"));
        ForgeBoot.init(Path.of(assets), true);

        HiddenInfoAudit.Result r = HiddenInfoAudit.run(decks, 7L, 40);

        assertTrue(r.views() > 200, "expected a real game, got only " + r.views() + " views");
        assertTrue(r.turns() >= 5, "expected at least five turns, got " + r.turns());
        assertEquals(List.of(), r.leaks());
    }
}
