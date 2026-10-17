package cgwf.engine;

import forge.LobbyPlayer;
import forge.ai.LobbyPlayerAi;
import forge.deck.Deck;
import forge.game.Game;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.player.RegisteredPlayer;
import forge.util.MyRandom;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Random;

/** Builds a four-seat Commander game. Seats are Forge AI unless given another LobbyPlayer. */
public final class GameFactory {
    public record Seat(String name, Deck deck, LobbyPlayer lobbyPlayer) { }
    public record Created(Match match, Game game) { }

    private GameFactory() { }

    public static LobbyPlayerAi ai(String name) {
        LobbyPlayerAi lp = new LobbyPlayerAi(name, null);
        lp.setAiProfile("Default");
        return lp;
    }

    public static Created create(List<Seat> seats, long seed) {
        MyRandom.setRandom(new Random(seed));
        GameRules rules = new GameRules(GameType.Commander);
        rules.setAppliedVariants(EnumSet.of(GameType.Commander));
        rules.setGamesPerMatch(1);
        rules.setWarnAboutAICards(false);
        rules.setAISideboardingEnabled(false);
        List<RegisteredPlayer> players = new ArrayList<>();
        for (Seat s : seats) {
            RegisteredPlayer rp = RegisteredPlayer.forCommander(s.deck());
            rp.setPlayer(s.lobbyPlayer());
            players.add(rp);
        }
        Match match = new Match(rules, players, "CGwF");
        Game game = match.createGame();
        return new Created(match, game);
    }
}
