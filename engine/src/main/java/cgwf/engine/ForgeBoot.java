package cgwf.engine;

import forge.gui.GuiBase;
import forge.localinstance.properties.ForgePreferences.FPref;
import forge.model.FModel;

import java.nio.file.Files;
import java.nio.file.Path;

/** Loads Forge's card database once per JVM. */
public final class ForgeBoot {
    private static boolean ready;
    private static long startupMillis = -1;

    private ForgeBoot() { }

    /**
     * @param assets    the forge-gui directory (the one that contains {@code res/cardsfolder})
     * @param lazyCards parse card scripts on first use instead of all at boot
     * @return milliseconds spent loading (0 when already loaded)
     */
    public static synchronized long init(Path assets, boolean lazyCards) {
        if (ready) return 0L;
        if (!Files.isDirectory(assets.resolve("res").resolve("cardsfolder"))) {
            throw new IllegalArgumentException("Not a Forge assets dir (expected res/cardsfolder under " + assets.toAbsolutePath() + ")");
        }
        long t0 = System.nanoTime();
        GuiBase.setInterface(new HeadlessGui(assets.toAbsolutePath().toString()));
        FModel.initialize(null, prefs -> {
            prefs.setPref(FPref.LOAD_CARD_SCRIPTS_LAZILY, String.valueOf(lazyCards));
            prefs.setPref(FPref.DECKGEN_CARDBASED, "false");
            prefs.setPref(FPref.PERFORMANCE_MODE, "true");
            prefs.setPref(FPref.UI_LANGUAGE, "en-US");
            return null;
        });
        ready = true;
        startupMillis = (System.nanoTime() - t0) / 1_000_000L;
        return startupMillis;
    }

    public static boolean isReady() { return ready; }
    public static long startupMillis() { return startupMillis; }
}
