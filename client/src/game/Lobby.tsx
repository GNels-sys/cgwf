import { useCallback, useEffect, useState } from "react";
import { BRACKET_NAMES, MAX_SEATS, type AgentPick, type Bracket, type FriendInfo, type RoomInfo, type RoomInviteInfo } from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { isOwner, useUser } from "../user";
import type { RoomSocket } from "./socket";
import { DeckPicker } from "./DeckPicker";

/** Seat picking before the game: each player sits down with one of their own decks or a library deck; the host starts. */
export function Lobby({ room, sock }: { room: RoomInfo; sock: RoomSocket }) {
  const me = room.you;
  const isHost = me?.userId === room.hostId;
  const { user } = useUser();
  const owner = isOwner(user);
  const [copied, setCopied] = useState(false);

  const myMember = room.members.find((m) => m.userId === me?.userId);
  const seated = room.members.filter((m) => m.role === "player" && m.seat !== null);
  const spectators = room.members.filter((m) => m.role !== "player");
  const illegal = room.engine ? seated.filter((m) => m.deckProblems.length > 0) : [];
  const ready = seated.length >= 2 && seated.every((m) => m.deckId) && illegal.length === 0;
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
      <header className="detail-heading">
        <p className="eyebrow">Your game-night table</p>
        <div className="row-between">
          <h1>
            Table <span className="room-code">{room.code}</span>
          </h1>
          <button className="btn btn-small" onClick={() => void share()}>
            {copied ? "Link copied" : "Share link"}
          </button>
        </div>
      </header>
      <p className="muted small">
        Friends join with the code or the link. <a href="/settings">Personalize</a> your playmat and sleeves while you wait. {sock.status !== "open" && <span className="warn">({sock.status})</span>}
      </p>
      {room.engine ? (
        <p className="engine-badge">
          <strong>Rules engine (beta).</strong> This table enforces the rules: one land per turn, mana, the stack and combat, and the engine untaps and draws. Everyone needs a legal Commander deck (100 cards, singleton, inside the commander&apos;s colours): one of your own, or any deck from the deck library. The host&apos;s Start button says what is wrong otherwise.
        </p>
      ) : (
        <p className="engine-badge is-casual">
          <strong>Casual (legacy).</strong> An older table where nothing is enforced: players move, tap and count land drops themselves. New tables always use the rules engine; open one from Play.
        </p>
      )}

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
                    {m.deckProblems.length > 0 && (
                      <>
                        <br />
                        <span className="warn small">Not legal for the rules engine: {m.deckProblems.join(" ")}</span>
                      </>
                    )}
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

      {myMember?.role === "player" && <DeckPicker deckId={myMember.deckId} onPick={pickDeck} />}

      {sock.error && <p className="error small">{sock.error}</p>}

      <InviteFriends room={room} />

      {owner && isHost && <AgentsControl room={room} />}

      {spectators.length > 0 && (
        <p className="muted small">
          Watching: {spectators.map((m) => m.name).join(", ")}
        </p>
      )}

      <div className="sticky-actions">
        {isHost ? (
          <button className="btn btn-primary btn-big" disabled={!ready} onClick={() => sock.send({ t: "start" })}>
            {ready ? "Start game" : seated.length < 2 ? "Need two players" : illegal.length ? `${illegal.map((m) => m.name).join(", ")}: fix the deck first` : "Everyone needs a deck"}
          </button>
        ) : (
          <span className="muted">Waiting for {room.members.find((m) => m.userId === room.hostId)?.name ?? "the host"} to start...</span>
        )}
      </div>
    </main>
  );
}

/** Any member: invite friends to this table. Invitees get a bell notification with a Join button. */
function InviteFriends({ room }: { room: RoomInfo }) {
  const [friends, setFriends] = useState<FriendInfo[] | null>(null);
  const [invites, setInvites] = useState<RoomInviteInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, i] = await Promise.all([api.social.friends(), api.social.roomInvites(room.code)]);
      setFriends(f.friends);
      setInvites(i.invites);
    } catch {
      setFriends([]);
    }
  }, [room.code]);

  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [open, load]);

  const here = new Set(room.members.map((m) => m.userId));
  const invitedState = (userId: string) => invites.find((i) => i.to.userId === userId)?.status ?? null;

  const invite = async (f: FriendInfo) => {
    setBusy(f.userId);
    setNote(null);
    try {
      await api.social.invite(room.code, [f.userId]);
      setNote(`Invited ${f.name}. They get a notification with a Join button.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!open)
    return (
      <p>
        <button className="btn btn-small" onClick={() => setOpen(true)}>
          Invite friends
        </button>
        <span className="muted small"> &nbsp; or share the code / link above</span>
      </p>
    );

  const candidates = (friends ?? []).filter((f) => !here.has(f.userId));
  return (
    <section className="notice invite-box">
      <div className="row-between">
        <strong>Invite friends</strong>
        <button className="btn btn-small" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      {friends === null ? (
        <p className="muted small">Loading...</p>
      ) : candidates.length === 0 ? (
        <p className="muted small">
          {friends.length === 0 ? (
            <>
              No friends yet. Add them by code on the <a href="/friends">Friends</a> page, or share the link above.
            </>
          ) : (
            "Everyone on your friends list is already here."
          )}
        </p>
      ) : (
        <ul className="people-list compact">
          {candidates.map((f) => {
            const st = invitedState(f.userId);
            return (
              <li key={f.userId}>
                <span className={`presence-dot${f.online ? " is-online" : ""}`} aria-hidden="true" />
                <Avatar avatar={f.avatar} color={f.color} size={28} />
                <span className="people-main">
                  <strong>{f.name}</strong>
                  <span className="muted small">{f.table ? `at table ${f.table.code}` : f.online ? "online" : "offline"}</span>
                </span>
                {st === "pending" ? (
                  <span className="muted small">invited</span>
                ) : st === "declined" ? (
                  <button className="btn btn-small" disabled={busy === f.userId} onClick={() => void invite(f)}>
                    Invite again
                  </button>
                ) : st === "accepted" ? (
                  <span className="muted small">accepted</span>
                ) : (
                  <button className="btn btn-small btn-primary" disabled={busy === f.userId} onClick={() => void invite(f)}>
                    Invite
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {note && <p className="small muted">{note}</p>}
    </section>
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
    if (room.engine) {
      // Engine tables: Forge's own AI plays the bot seats, no model and no flag needed.
      setEnabled(true);
      return;
    }
    api.agents
      .status()
      .then((s) => {
        setEnabled(s.enabled);
        if (s.dryRun) setNote("No API key on the server: agents play a scripted dry run.");
      })
      .catch(() => setEnabled(false));
  }, [room.engine]);

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
      {room.engine && <p className="muted small">On a rules-engine table the bots are played by the engine&apos;s own AI: no model, no spend, instant decisions. They pick decks from the library like the Sonnet agents do.</p>}
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
