package cgwf.engine.bridge;

import forge.LobbyPlayer;
import forge.ai.LobbyPlayerAi;
import forge.game.Game;
import forge.game.player.IGameEntitiesFactory;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/**
 * The seat Forge sees for a human connected through the bridge. Extends LobbyPlayerAi (not LobbyPlayer)
 * so AiProfileUtil still finds a profile for the AI fallback paths of BridgeController.
 */
public final class BridgeLobbyPlayer extends LobbyPlayerAi implements IGameEntitiesFactory {
    private final BridgeSession session;

    public BridgeLobbyPlayer(String name, BridgeSession session) {
        super(name, null);
        setAiProfile("Default");
        this.session = session;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player p = new Player(getName(), game, id);
        p.setFirstController(new BridgeController(game, p, this, session));
        return p;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return new BridgeController(slave.getGame(), slave, this, session);
    }

    @Override
    public void hear(LobbyPlayer player, String message) { }
}
