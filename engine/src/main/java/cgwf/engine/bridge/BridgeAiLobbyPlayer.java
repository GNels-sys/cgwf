package cgwf.engine.bridge;

import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/** A Forge AI seat (bots, CGwF "Computer opponents") that honours the table's starting player. */
public final class BridgeAiLobbyPlayer extends LobbyPlayerAi {
    private final StartingPlayer starting;
    private final OpeningHand opening;

    public BridgeAiLobbyPlayer(String name, StartingPlayer starting) {
        this(name, starting, OpeningHand.FORGE);
    }

    public BridgeAiLobbyPlayer(String name, StartingPlayer starting, OpeningHand opening) {
        super(name, null);
        setAiProfile("Default");
        this.starting = starting;
        this.opening = opening == null ? OpeningHand.FORGE : opening;
    }

    private PlayerControllerAi controllerFor(Player p) {
        return new PlayerControllerAi(p.getGame(), p, this) {
            @Override
            public Player chooseStartingPlayer(boolean isFirstGame) {
                Player fixed = starting.get();
                return fixed != null ? fixed : super.chooseStartingPlayer(isFirstGame);
            }

            @Override
            public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
                if (opening.drawTen()) {
                    opening.ensurePutBack();
                    return true;
                }
                return super.mulliganKeepHand(firstPlayer, opening.ownsFreeMulligans() ? opening.bottomSoFar(player) : cardsToReturn);
            }

            @Override
            public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
                int n = opening.ownsFreeMulligans() ? Math.min(opening.bottomNow(player), hand.size()) : cardsToReturn;
                return n <= 0 ? new CardCollection() : super.tuckCardsViaMulligan(hand, n);
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
