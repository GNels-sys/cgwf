import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PASSWORD_MIN, type SessionInfo } from "@cgwf/shared";
import { api } from "../api";
import { ProfileForm } from "../components/ProfileForm";
import { RequireUser } from "../components/RequireUser";
import { FriendCode } from "./FriendsPage";
import { useUser } from "../user";

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** The signed-in devices of this account, each with a sign-out button. */
function DeviceList() {
  const { signOut, signOutEverywhere } = useUser();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api.auth
      .sessions()
      .then((r) => setSessions(r.sessions))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const remove = async (s: SessionInfo) => {
    if (s.current) {
      if (!confirm("Sign out on this device? Your decks and settings stay in your account; sign in again any time.")) return;
      await signOut();
      navigate("/");
      return;
    }
    await api.auth.signOutSession(s.id).catch((e: Error) => setError(e.message));
    await load();
  };

  return (
    <>
      <h3>Signed-in devices</h3>
      {error && <p className="error">{error}</p>}
      {!sessions && !error && <p className="muted">Loading...</p>}
      {sessions && (
        <ul className="device-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span>
                <strong>{s.device || "Unknown device"}</strong>
                {s.current && <span className="tag">this device</span>}
                <br />
                <span className="muted small">
                  last used {timeAgo(s.lastSeenAt)} &middot; signed in {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </span>
              <button className="btn btn-small" onClick={() => void remove(s)}>
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        className="btn btn-danger btn-small"
        onClick={async () => {
          if (!confirm("Sign out on every device, including this one?")) return;
          await signOutEverywhere().catch((e: Error) => setError(e.message));
          navigate("/");
        }}
      >
        Sign out everywhere
      </button>
    </>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.auth.changePassword({ currentPassword: current, newPassword: next });
      setMsg({ ok: true, text: "Password changed. Your other devices were signed out." });
      setCurrent("");
      setNext("");
      setOpen(false);
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "something went wrong" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="profile-form" onSubmit={submit}>
      <label className="field">
        <span>Current password</span>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>New password</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} required />
      </label>
      {msg && <p className={msg.ok ? "muted" : "error"}>{msg.text}</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !current || !next}>
          {busy ? "Saving..." : "Save password"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Owner access: a one-time code from the server's secret grants the owner flag. */
function OwnerClaim() {
  const { user, setUser } = useUser();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user?.isOwner)
    return (
      <p>
        <span className="tag tag-owner">Owner</span> <span className="muted small">You have owner access on this server.</span>
      </p>
    );
  if (!open)
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        I have an owner code
      </button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.claimOwner(code);
      setUser(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="profile-form" onSubmit={submit}>
      <label className="field">
        <span>Owner code</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} required />
        <span className="muted small">Only the person who runs this server has it. Attempts are limited and logged.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy || !code.trim()}>
          {busy ? "Checking..." : "Claim owner access"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Friend code line for the profile page (the Friends page has the full list). */
function FriendCodeLine() {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    api.social
      .friendCode()
      .then((r) => setCode(r.code))
      .catch(() => setCode(null));
  }, []);
  return (
    <p>
      <strong>Friend code</strong> {code ? <FriendCode code={code} /> : <span className="muted">...</span>}
      <br />
      <span className="muted small">
        Friends add you with this code, so two players called the same thing never get mixed up. <Link to="/friends">Manage friends</Link>
      </span>
    </p>
  );
}

export function ProfilePage() {
  const { user, update, signOut } = useUser();
  const navigate = useNavigate();
  return (
    <main className="page narrow">
      <h1>Your profile</h1>
      <RequireUser>
        {user && (
          <>
            <ProfileForm
              initial={{ displayName: user.displayName, avatar: user.avatar, color: user.color }}
              submitLabel="Save"
              onSubmit={async (body) => {
                await update(body);
                navigate("/");
              }}
            />
            <hr />
            <FriendCodeLine />
            <hr />
            <p>
              <Link to="/settings" className="btn">
                Personalize your table
              </Link>
              <span className="muted small"> &nbsp; playmat, sleeves, theme, layout</span>
            </p>
            <hr />
            <h2>Account</h2>
            {user.email ? (
              <>
                <p>
                  Signed in as <strong>{user.email}</strong>
                </p>
                <div className="actions">
                  <ChangePassword />
                </div>
                <DeviceList />
                <h3>Owner access</h3>
                <OwnerClaim />
              </>
            ) : (
              <>
                <div className="notice">
                  <p>
                    <strong>Create an account to keep your decks safe and use them on other devices.</strong>
                  </p>
                  <p className="muted small">
                    Right now only this device knows you: lose the phone or clear the browser and the decks are gone. An email and password
                    keep everything (name, decks, playmats, friends) and let you sign in from your phone and your computer. It takes a minute.
                  </p>
                  <div className="actions">
                    <Link to="/signup" className="btn btn-primary">
                      Create an account
                    </Link>
                    <Link to="/signin" className="btn">
                      I already have an account
                    </Link>
                  </div>
                </div>
                <hr />
                <p className="muted small">
                  Signing out forgets this device. Your decks stay on the server but you will not be able to reach them again without an
                  account, so only do this on a shared device you are leaving.
                </p>
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    if (confirm("Forget this device? You will lose access to your decks.")) {
                      await signOut();
                      navigate("/");
                    }
                  }}
                >
                  Sign out on this device
                </button>
              </>
            )}
          </>
        )}
      </RequireUser>
    </main>
  );
}
