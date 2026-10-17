import { PageHeading } from "../components/PageHeading";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { normalizeFriendCode, type FriendsResponse } from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { RequireUser } from "../components/RequireUser";
import { useNotifications } from "../components/Bell";

/** Your friend code with a copy button; shown here and on the profile page. */
export function FriendCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code is still readable */
    }
  };
  return (
    <span className="friend-code-wrap">
      <span className="friend-code" aria-label="Your friend code">
        {code}
      </span>
      <button className="btn btn-small" type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function FriendsView() {
  const navigate = useNavigate();
  const { refresh: refreshBell } = useNotifications();
  const [data, setData] = useState<FriendsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.social.friends());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const clean = normalizeFriendCode(code);
    if (clean.length !== 6) {
      setNote("A friend code has 6 letters or numbers.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await api.social.sendRequest(clean);
      setNote(r.outcome === "accepted" ? `You and ${r.user.name} are now friends.` : `Request sent to ${r.user.name}.`);
      setCode("");
      await load();
      void refreshBell();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      void refreshBell();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;

  return (
    <>
      <div className="notice friend-invite">
        <p>
          <strong>Your friend code</strong> <FriendCode code={data.code} />
        </p>
        <p className="muted small">Give this to a friend (or get theirs) to add each other. Codes avoid mix-ups between players with the same name.</p>
        <form className="inline-field" onSubmit={(e) => void add(e)}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="Friend's code"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Friend code to add"
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
            Add friend
          </button>
        </form>
        {note && <p className="small muted">{note}</p>}
      </div>

      {data.incoming.length > 0 && (
        <>
          <h3>Requests for you</h3>
          <ul className="people-list">
            {data.incoming.map((r) => (
              <li key={r.id}>
                <Avatar avatar={r.from.avatar} color={r.from.color} size={36} />
                <span className="people-main">
                  <strong>{r.from.name}</strong>
                  <span className="muted small">wants to be friends</span>
                </span>
                <span className="actions">
                  <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void act(() => api.social.acceptRequest(r.id))}>
                    Accept
                  </button>
                  <button className="btn btn-small" disabled={busy} onClick={() => void act(() => api.social.declineRequest(r.id))}>
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {data.outgoing.length > 0 && (
        <>
          <h3>Waiting on</h3>
          <ul className="people-list">
            {data.outgoing.map((r) => (
              <li key={r.id}>
                <Avatar avatar={r.to.avatar} color={r.to.color} size={36} />
                <span className="people-main">
                  <strong>{r.to.name}</strong>
                  <span className="muted small">has not answered yet</span>
                </span>
                <button className="btn btn-small" disabled={busy} onClick={() => void act(() => api.social.cancelRequest(r.id))}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Friends {data.friends.length > 0 && <span className="muted">({data.friends.length})</span>}</h3>
      {data.friends.length === 0 ? (
        <div className="empty-state"><span className="empty-state-mark" aria-hidden="true">◇</span><h2>Good games start with good company.</h2><p className="muted">No friends yet. Swap codes with the people you play with.</p></div>
      ) : (
        <ul className="people-list">
          {data.friends.map((f) => (
            <li key={f.userId}>
              <span className={`presence-dot${f.online ? " is-online" : ""}`} aria-hidden="true" />
              <Avatar avatar={f.avatar} color={f.color} size={36} />
              <span className="people-main">
                <strong>{f.name}</strong>
                <span className="muted small">
                  {f.table ? (
                    <>
                      At table <span className="room-code small">{f.table.code}</span> ({f.table.status === "lobby" ? "waiting to start" : "playing"})
                    </>
                  ) : f.online ? (
                    "Online"
                  ) : (
                    "Offline"
                  )}
                </span>
              </span>
              <span className="actions">
                {f.table && (
                  <button className="btn btn-small btn-primary" onClick={() => navigate(`/room/${f.table!.code}`)}>
                    {f.table.status === "lobby" ? "Join" : "Watch"}
                  </button>
                )}
                <button
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`Remove ${f.name} from your friends?`)) void act(() => api.social.removeFriend(f.userId));
                  }}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Online means the app has heard from them in the last two minutes. Invite friends to a table from its lobby. <Link to="/play">Open Play</Link>
      </p>
    </>
  );
}

export function FriendsPage() {
  return (
    <main className="page narrow friends-page">
      <PageHeading title="Friends" eyebrow="Your game-night circle">Swap codes, see who is around, and find your next table.</PageHeading>
      <RequireUser>
        <FriendsView />
      </RequireUser>
    </main>
  );
}
