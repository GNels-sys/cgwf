package cgwf.engine.bridge;

import forge.ai.LobbyPlayerAi;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.game.spellability.SpellAbility;

import java.util.List;

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
            /** The repeat or loop of a human seat's that this bot has already looked at once and let go. */
            private Object letGo;

            /**
             * A human's repeat (owner, 2026-11-22: 500 Sprout Swarms) gives every bot priority several times per
             * cast, and each time Forge's AI weighs all its options again, slower as the board grows. It is the
             * same question every round: the bot decides once per repeat, and if it let that go it lets the rest
             * go without thinking. A bot that does respond ends the repeat anyway.
             */
            @Override
            public List<SpellAbility> chooseSpellAbilityToPlay() {
                Object running = runningRepeat(player.getGame());
                if (running == null) {
                    letGo = null;
                    return super.chooseSpellAbilityToPlay();
                }
                if (running == letGo) return null;
                List<SpellAbility> chosen = super.chooseSpellAbilityToPlay();
                if (chosen == null || chosen.isEmpty()) letGo = running;
                return chosen;
            }

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

    /** The cast repeat or loop some human seat is running right now, or null. Game thread. */
    static Object runningRepeat(Game game) {
        for (Player p : game.getPlayers()) {
            if (!(p.getController() instanceof BridgeController bc)) continue;
            BridgeSession s = bc.session();
            if (s.replay() != null && s.replay().active()) return s.replay();
            if (s.loop() != null && s.loop().active()) return s.loop();
        }
        return null;
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
