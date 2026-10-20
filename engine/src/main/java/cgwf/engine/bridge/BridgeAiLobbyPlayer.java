package cgwf.engine.bridge;

import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/** A Forge AI seat (bots, CGwF "Computer opponents") that honours the table's starting player. */
public final class BridgeAiLobbyPlayer extends LobbyPlayerAi {
    private final StartingPlayer starting;

    public BridgeAiLobbyPlayer(String name, StartingPlayer starting) {
        super(name, null);
        setAiProfile("Default");
        this.starting = starting;
    }

    private PlayerControllerAi controllerFor(Player p) {
        return new PlayerControllerAi(p.getGame(), p, this) {
            @Override
            public Player chooseStartingPlayer(boolean isFirstGame) {
                Player fixed = starting.get();
                return fixed != null ? fixed : super.chooseStartingPlayer(isFirstGame);
            }
        };
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player p = new Player(getName(), game, id);
        p.setFirstController(controllerFor(p));
        return p;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return controllerFor(slave);
    }
}
