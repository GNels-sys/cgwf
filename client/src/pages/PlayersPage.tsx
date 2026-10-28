import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  matchWith,
  PERFORMANCE_TEXT,
  PLAYER_BRACKETS,
  type BracketCounts,
  type PlayerDetailResponse,
  type PlayerMatch,
  type PlayerPerformance,
  type PlayerSummary,
} from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { PageHeading } from "../components/PageHeading";
import { PowerBadge } from "../components/PowerBadge";
import { RequireUser } from "../components/RequireUser";
import { Panel } from "../game/Panels";

type Filter = "all" | "match" | "friends" | "online";
const FILTERS: Array<[Filter, string]> = [["all", "Everyone"], ["match", "Good matches"], ["friends", "Friends"], ["online", "Online now"]];

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

/** "2 wins of 5 · 40%" and the performance label, with a small-sample note. */
function RecordLine({ p }: { p: PlayerPerformance }) {
  if (p.games === 0) return <span className="muted small">No counted games yet</span>;
  return (
    <span className="player-record">
      <strong>{p.wins}/{p.games}</strong> <span className="muted">wins · {pct(p.winRate)}</span>
      {p.level && <span className={`player-level is-${p.level}`} title={PERFORMANCE_TEXT[p.level]}>{p.level === "strong" ? "Strong" : p.level === "even" ? "Even" : "Below even"}{p.ratio !== null ? ` · ${p.ratio}×` : ""}</span>}
      {p.lowSample && <span className="muted small"> (few games)</span>}
    </span>
  );
}

/** Five small columns, one per bracket, height = share of the player's decks. */
function BracketBars({ counts, unknown }: { counts: BracketCounts; unknown: number }) {
  const max = Math.max(1, ...PLAYER_BRACKETS.map((b) => counts[b]));
  return (
    <div className="player-brackets" role="img" aria-label={`Decks by bracket: ${PLAYER_BRACKETS.map((b) => `B${b} ${counts[b]}`).join(", ")}${unknown ? `, unrated ${unknown}` : ""}`}>
      {PLAYER_BRACKETS.map((b) => (
        <span key={b} className="player-bracket" data-power={b}>
          <span className="player-bracket-bar"><i style={{ height: `${(counts[b] / max) * 100}%` }} /></span>
          <span className="player-bracket-count">{counts[b]}</span>
          <span className="player-bracket-label">B{b}</span>
        </span>
      ))}
    </div>
  );
}

function MatchChip({ match }: { match: PlayerMatch }) {
  if (match.kind === "self") return null;
  return <p className={`player-match is-${match.kind}`}>{match.text}</p>;
}

function PlayerCard({ p, mine, onOpen }: { p: PlayerSummary; mine: BracketCounts; onOpen: () => void }) {
  const match = matchWith(mine, p);
  return (
    <button type="button" className={`surface player-card${p.isMe ? " is-me" : ""}`} onClick={onOpen} aria-label={`${p.name}: open details`}>
      <span className="player-card-head">
        <Avatar avatar={p.avatar} color={p.color} size={40} />
        <span className="player-card-name">
          <strong>{p.name}</strong>
          <span className="small muted">
            {p.isMe ? "You" : p.isFriend ? "Friend" : p.hasAccount ? "Player" : "Guest profile"}
            {p.online && <span className="player-online"> · online</span>}
          </span>
        </span>
        <PowerBadge level={p.playsAt ?? p.typicalBracket} label={p.playsAt !== null ? "Plays at" : "Decks"} />
      </span>
      <span className="player-card-stats">
        <span><strong>{p.decks}</strong> <span className="muted small">deck{p.decks === 1 ? "" : "s"}</span></span>
        <span><strong>{p.averageBracket === null ? "–" : `B${p.averageBracket}`}</strong> <span className="muted small">average</span></span>
      </span>
      <BracketBars counts={p.bracketCounts} unknown={p.unknownBracket} />
      <RecordLine p={p.performance} />
      <MatchChip match={match} />
    </button>
  );
}

function PlayerDetailPanel({ id, mine, onClose, onChanged }: { id: string; mine: BracketCounts; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<PlayerDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.players.get(id).then(setD, (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const addFriend = async () => {
    setBusy(true);
    try {
      await api.players.friendRequest(id);
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={d?.name ?? "Player"} subtitle={d ? (d.isMe ? "You" : d.isFriend ? "Friend" : undefined) : undefined} onClose={onClose} className="player-detail">
      {error && <div className="notice error"><p>{error}</p></div>}
      {!d && !error && <p className="muted" role="status">Loading…</p>}
      {d && (
        <>
          <div className="player-detail-top">
            <Avatar avatar={d.avatar} color={d.color} size={56} />
            <div>
              <RecordLine p={d.performance} />
              {d.performance.avgPlace !== null && <p className="small muted">Average place {d.performance.avgPlace}</p>}
              <MatchChip match={matchWith(mine, d)} />
            </div>
            <PowerBadge level={d.playsAt ?? d.typicalBracket} label={d.playsAt !== null ? "Plays at" : "Decks"} />
          </div>
          {d.hidden && <p className="notice small">You are hidden from the Players page. Other players do not see this card. Change it on your <Link to="/me">profile</Link>.</p>}
          {!d.isMe && (
            <div className="actions">
              {d.isFriend ? (
                <span className="chip is-selected">Friends</span>
              ) : d.friendRequest === "sent" ? (
                <span className="chip">Friend request sent</span>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={() => void addFriend()}>
                  {d.friendRequest === "received" ? "Accept friend request" : "Add friend"}
                </button>
              )}
              <span className="small muted">{d.isFriend ? "Invite friends from your table's lobby." : "Friends can be invited to your tables."}</span>
            </div>
          )}

          <section className="player-section">
            <h3>Decks by bracket</h3>
            <BracketBars counts={d.bracketCounts} unknown={d.unknownBracket} />
            {d.deckList.length === 0 ? (
              <p className="muted small">No decks on the site yet.</p>
            ) : (
              <ul className="player-decks">
                {d.deckList.map((deck, i) => (
                  <li key={i}>
                    <PowerBadge level={deck.bracket} />
                    <span>{deck.commanders.length ? deck.commanders.join(" & ") : <span className="muted">No commander set</span>}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted">Shown as commanders and bracket only; deck lists stay private.</p>
          </section>

          <section className="player-section">
            <h3>Record by opponents' bracket</h3>
            {d.byOpponentBracket.length === 0 ? (
              <p className="muted small">No counted games yet. Games count when they finish on a rules-engine table that is not marked Test.</p>
            ) : (
              <table className="player-table">
                <thead><tr><th scope="col">Opponents</th><th scope="col">Wins</th><th scope="col">Win rate</th><th scope="col">vs even share</th></tr></thead>
                <tbody>
                  {d.byOpponentBracket.map((r) => (
                    <tr key={r.opponentBracket}>
                      <th scope="row"><PowerBadge level={r.opponentBracket} /></th>
                      <td>{r.wins}/{r.games}</td>
                      <td>{pct(r.winRate)}</td>
                      <td>{r.ratio === null ? "–" : `${r.ratio}×`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.byPlayers.length > 0 && (
              <p className="small">
                {d.byPlayers.map((r) => `${r.players} players: ${r.wins}/${r.games}`).join(" · ")}
              </p>
            )}
          </section>

          {d.recent.length > 0 && (
            <section className="player-section">
              <h3>Recent games</h3>
              <ul className="player-recent">
                {d.recent.map((g, i) => (
                  <li key={i}>
                    <span className={g.won ? "player-won" : "muted"}>{g.won ? "Won" : g.place ? `Place ${g.place}` : "Lost"}</span>
                    <span>{g.commanders.join(" & ") || "Unknown commander"}{g.deckBracket ? ` (B${g.deckBracket})` : ""}</span>
                    <span className="small muted">{g.players} players{g.opponentBracket ? ` · vs B${g.opponentBracket}` : ""}{g.endedAt ? ` · ${new Date(g.endedAt).toLocaleDateString()}` : ""}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Panel>
  );
}

function Players() {
  const [players, setPlayers] = useState<PlayerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api.players.list().then((r) => {
      setPlayers(r.players);
      setError(null);
    }, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const me = players?.find((p) => p.isMe);
  const mine: BracketCounts = me?.bracketCounts ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (players ?? []).filter((p) => {
      if (q && !p.name.toLowerCase().includes(q)) return false;
      if (filter === "friends") return p.isFriend;
      if (filter === "online") return p.online && !p.isMe;
      if (filter === "match") return matchWith(mine, p).kind === "match";
      return true;
    });
  }, [players, filter, query, mine]);

  return (
    <>
      {error && <div className="notice error"><p>{error}</p><button className="btn btn-small" onClick={load}>Try again</button></div>}
      {!players && !error && <p className="muted" role="status">Loading players…</p>}
      {players && (
        <>
          <section className="surface players-mine">
            <p className="eyebrow">Your decks</p>
            {me && me.decks > 0 ? (
              <p>
                {PLAYER_BRACKETS.filter((b) => mine[b] > 0).map((b) => `B${b} × ${mine[b]}`).join(" · ")}
                {me.unknownBracket ? ` · unrated × ${me.unknownBracket}` : ""}
                <span className="muted small"> · cards below say whether each player plays at a bracket you have a deck for.</span>
              </p>
            ) : (
              <p className="muted">You have no decks yet, so matches cannot be worked out. <Link to="/decks/new">Import a deck</Link>.</p>
            )}
          </section>
          <div className="players-toolbar">
            <div className="chip-row" role="group" aria-label="Show">
              {FILTERS.map(([key, label]) => (
                <button key={key} className={`chip${filter === key ? " is-selected" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            <input className="players-search" type="search" placeholder="Find a player" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a player by name" />
          </div>
          {shown.length === 0 ? (
            <p className="muted">No players here yet.</p>
          ) : (
            <div className="players-grid">
              {shown.map((p) => <PlayerCard key={p.userId} p={p} mine={mine} onOpen={() => setOpen(p.userId)} />)}
            </div>
          )}
          <p className="small muted players-note">
            "Plays at" is the bracket most of a player's opponents had in counted games; without games it is their most common deck bracket. Brackets of
            personal decks come from the deck analysis. Performance compares wins with an even share of the table (1 in 4 at a four-player table).
          </p>
        </>
      )}
      {open && <PlayerDetailPanel id={open} mine={mine} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

export function PlayersPage() {
  return (
    <main className="page players-page">
      <PageHeading title="Players" eyebrow="Who plays here">
        Everyone signed up, the brackets their decks are built for and how they do, so you can find players at your level.
      </PageHeading>
      <RequireUser>
        <Players />
      </RequireUser>
    </main>
  );
}
