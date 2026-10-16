import { useEffect, useState } from "react";
import { BRACKET_NAMES, MAX_SEATS, type AgentPick, type Bracket, type RoomInfo } from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { isOwner, useUser } from "../user";
import type { RoomSocket } from "./socket";

interface DeckPick {
  id: string;
  name: string;
  commanders: string[];
}

/** Seat picking before the game: each player sits down with one of their own decks; the host starts. */
export function Lobby({ room, sock }: { room: RoomInfo; sock: RoomSocket }) {
  const me = room.you;
  const isHost = me?.userId === room.hostId;
  const { user } = useUser();
  const owner = isOwner(user);
  const [decks, setDecks] = useState<DeckPick[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.rooms
      .decks()
      .then((r) => setDecks(r.decks))
      .catch(() => setDecks([]));
  }, []);

  const myMember = room.members.find((m) => m.userId === me?.userId);
  const seated = room.members.filter((m) => m.role === "player" && m.seat !== null);
  const spectators = room.members.filter((m) => m.role !== "player");
  const ready = seated.length >= 2 && seated.every((m) => m.deckId);
  const link = `${location.origin}/room/${room.code}`;

  const share = async () => {
    const data = { title: "CGwF table", text: `Join my table with code ${room.code}`, url: link };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* cancelled */
    }
  };

  const sit = (seat: number) => sock.send({ t: "seat", seat, deckId: myMember?.deckId ?? null });
  const pickDeck = (deckId: string | null) => {
    const seat = myMember?.seat ?? firstFreeSeat(room);
    if (seat === null) return;
    sock.send({ t: "seat", seat, deckId });
  };

  return (
    <main className="page narrow lobby">
      <div className="row-between">
        <h1>
          Table <span className="room-code">{room.code}</span>
        </h1>
        <button className="btn btn-small" onClick={() => void share()}>
          {copied ? "Link copied" : "Share link"}
        </button>
      </div>
      <p className="muted small">
        Friends join with the code or the link. <a href="/settings">Personalize</a> your playmat and sleeves while you wait. {sock.status !== "open" && <span className="warn">({sock.status})</span>}
      </p>

      <ul className="seat-list">
        {Array.from({ length: MAX_SEATS }, (_, seat) => {
          const m = room.members.find((x) => x.seat === seat && x.role === "player");
          const mine = m?.userId === me?.userId;
          return (
            <li key={seat} className={`seat${mine ? " is-mine" : ""}${m ? "" : " is-empty"}`}>
              <span className="seat-no">{seat + 1}</span>
              {m ? (
                <>
                  <Avatar avatar={m.avatar} color={m.color} size={36} />
                  <span className="seat-name">
                    {m.name}
                    {m.userId === room.hostId && <span className="muted small"> (host)</span>}
                    {m.isAgent && <span className="bot-chip">BOT</span>}
                    {!m.online && !m.isAgent && <span className="muted small"> &middot; offline</span>}
                    <br />
                    <span className="muted small">{m.deckName ? `${m.deckName}${m.commanders.length ? ` - ${m.commanders.join(" / ")}` : ""}` : "no deck yet"}</span>
                  </span>
                  {mine && (
                    <button className="btn btn-small" onClick={() => sock.send({ t: "unseat" })}>
                      Stand up
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="seat-name muted">Empty</span>
                  {myMember?.seat !== seat && (
                    <button className="btn btn-small" onClick={() => sit(seat)}>
                      {myMember?.role === "player" ? "Move here" : "Sit here"}
                    </button>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>

      {myMember?.role === "player" && (
        <label className="field">
          <span>Your deck</span>
          <select value={myMember.deckId ?? ""} onChange={(e) => pickDeck(e.target.value || null)}>
            <option value="">Pick a deck...</option>
            {(decks ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.commanders.length ? ` - ${d.commanders.join(" / ")}` : ""}
              </option>
            ))}
          </select>
          {decks && decks.length === 0 && (
            <span className="muted small">
              No decks yet. <a href="/decks/new">Import one</a> first.
            </span>
          )}
        </label>
      )}

      {sock.error && <p className="error small">{sock.error}</p>}

      {owner && isHost && <AgentsControl room={room} />}

      {spectators.length > 0 && (
        <p className="muted small">
          Watching: {spectators.map((m) => m.name).join(", ")}
        </p>
      )}

      <div className="sticky-actions">
        {isHost ? (
          <button className="btn btn-primary btn-big" disabled={!ready} onClick={() => sock.send({ t: "start" })}>
            {ready ? "Start game" : seated.length < 2 ? "Need two players" : "Everyone needs a deck"}
          </button>
        ) : (
          <span className="muted">Waiting for {room.members.find((m) => m.userId === room.hostId)?.name ?? "the host"} to start...</span>
        )}
      </div>
    </main>
  );
}

/** Owner + host only: seat computer opponents from the library, picked for the bracket with different archetypes. */
function AgentsControl({ room }: { room: RoomInfo }) {
  const agents = room.members.filter((m) => m.isAgent);
  const humans = room.members.filter((m) => m.role === "player" && !m.isAgent).length;
  const free = Math.max(0, MAX_SEATS - humans);
  const [count, setCount] = useState(Math.min(3, free));
  const [bracket, setBracket] = useState<Bracket>(2);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [picks, setPicks] = useState<AgentPick[] | null>(null);

  useEffect(() => {
    api.agents
      .status()
      .then((s) => {
        setEnabled(s.enabled);
        if (s.dryRun) setNote("No API key on the server: agents play a scripted dry run.");
      })
      .catch(() => setEnabled(false));
  }, []);

  if (enabled === false) return null;

  const add = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.agents.add(room.code, { count, bracket });
      setPicks(r.agents);
      if (r.eligible === 0) setNote(`No agent-eligible decks at Bracket ${bracket}; used any eligible deck.`);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.agents.remove(room.code);
      setPicks(null);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="notice agents-control">
      <strong>Computer opponents</strong>
      <div className="agents-form">
        <label>
          Bracket{" "}
          <select value={bracket} onChange={(e) => setBracket(Number(e.target.value) as Bracket)}>
            {([1, 2, 3, 4, 5] as const).map((b) => (
              <option key={b} value={b}>
                {b} · {BRACKET_NAMES[b]}
              </option>
            ))}
          </select>
        </label>
        <label>
          How many{" "}
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: Math.max(1, free) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-small btn-primary" disabled={busy || free === 0} onClick={() => void add()}>
          {busy ? "Picking..." : agents.length ? "Re-roll decks" : "Add computer opponents"}
        </button>
        {agents.length > 0 && (
          <button className="btn btn-small" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
      {picks && picks.length > 0 && (
        <ul className="small agents-picks">
          {picks.map((p) => (
            <li key={p.userId}>
              <strong>{p.name}</strong> · seat {p.seat + 1} · {p.deckName} ({p.commanders.join(" / ")}) · B{p.bracket}
              {p.tags.length ? ` · ${p.tags.join(", ")}` : ""}
            </li>
          ))}
        </ul>
      )}
      {note && <p className="small muted">{note}</p>}
      <p className="small muted">Agents take their turns through the same table actions you use; the owner can read their reasoning from the table menu.</p>
    </section>
  );
}

function firstFreeSeat(room: RoomInfo): number | null {
  for (let s = 0; s < MAX_SEATS; s++) if (!room.members.some((m) => m.seat === s && m.role === "player")) return s;
  return null;
}
