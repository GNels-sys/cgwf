import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { NotificationInfo, NotificationsResponse } from "@cgwf/shared";
import { api } from "../api";
import { useUser } from "../user";

/**
 * In-app notifications: a bell in the header polls /api/notifications every
 * 30 s while signed in (sooner when the tab comes back), which is also the
 * presence heartbeat. Nothing is pushed; see CLAUDE.md for how browser push
 * would be added later.
 */
interface NotificationsState {
  unread: number;
  notifications: NotificationInfo[];
  refresh: () => Promise<void>;
}

const Ctx = createContext<NotificationsState>({ unread: 0, notifications: [], refresh: async () => {} });

const POLL_MS = 30_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [data, setData] = useState<NotificationsResponse>({ unread: 0, notifications: [] });
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    try {
      setData(await api.social.notifications(ctl.signal));
    } catch {
      /* offline or aborted: keep what we have */
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setData({ unread: 0, notifications: [] });
      return;
    }
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [user, refresh]);

  const value = useMemo(() => ({ unread: data.unread, notifications: data.notifications, refresh }), [data, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotifications(): NotificationsState {
  return useContext(Ctx);
}

function timeAgo(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function Item({ n, onDone }: { n: NotificationInfo; onDone: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const p = n.payload as Record<string, string | boolean | null | undefined>;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  let text: ReactNode;
  let actions: ReactNode = null;
  switch (n.kind) {
    case "friend_request":
      text = (
        <>
          <strong>{String(p.fromName ?? "Someone")}</strong> wants to be friends
        </>
      );
      if (p.live)
        actions = (
          <>
            <button className="btn btn-small btn-primary" disabled={busy} onClick={() => void run(() => api.social.acceptRequest(String(p.requestId)))}>
              Accept
            </button>
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => api.social.declineRequest(String(p.requestId)))}>
              Decline
            </button>
          </>
        );
      break;
    case "friend_accepted":
      text = (
        <>
          <strong>{String(p.name ?? "A player")}</strong> accepted your friend request
        </>
      );
      break;
    case "room_invite":
      text = (
        <>
          <strong>{String(p.fromName ?? "A friend")}</strong> invited you to table <span className="room-code small">{String(p.code ?? "")}</span>
          {!p.live && <span className="muted"> (over)</span>}
        </>
      );
      if (p.live)
        actions = (
          <>
            <button
              className="btn btn-small btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.social.acceptInvite(String(p.inviteId));
                  navigate(`/room/${r.code}`);
                })
              }
            >
              Join
            </button>
            <button className="btn btn-small" disabled={busy} onClick={() => void run(() => api.social.declineInvite(String(p.inviteId)))}>
              No thanks
            </button>
          </>
        );
      break;
    case "submission_reviewed":
      text =
        p.status === "approved" ? (
          <>
            <strong>{String(p.deckName ?? "Your deck")}</strong> was added to the agent deck library. Thank you!
          </>
        ) : (
          <>
            <strong>{String(p.deckName ?? "Your deck")}</strong> was not added to the agent library{p.reason ? `: ${String(p.reason)}` : "."}
          </>
        );
      break;
    default:
      text = n.kind;
  }
  return (
    <li className={n.read ? "" : "is-unread"}>
      <span className="notif-text">
        {text}
        <span className="muted small"> &middot; {timeAgo(n.createdAt)}</span>
        {note && <span className="error small"> {note}</span>}
      </span>
      {actions && <span className="actions">{actions}</span>}
    </li>
  );
}

/** The bell in the header: badge + a dropdown with the latest notifications. */
export function Bell() {
  const { unread, notifications, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      await refresh();
    } else if (unread > 0) {
      // Closing the panel marks everything seen; live requests and invites still carry their buttons.
      await api.social.markRead().catch(() => undefined);
      await refresh();
    }
  };

  return (
    <div className="bell-wrap" ref={wrap}>
      <button className={`bell${unread ? " has-unread" : ""}`} onClick={() => void toggle()} aria-label={unread ? `${unread} new notifications` : "Notifications"} aria-expanded={open}>
        <span aria-hidden="true">&#x1F514;</span>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="row-between">
            <strong>Notifications</strong>
            <Link to="/friends" className="small" onClick={() => setOpen(false)}>
              Friends
            </Link>
          </div>
          {notifications.length === 0 ? (
            <p className="muted small">Nothing yet. Friend requests, table invites and deck-queue decisions show up here.</p>
          ) : (
            <ul className="notif-list">
              {notifications.slice(0, 20).map((n) => (
                <Item key={n.id} n={n} onDone={() => void refresh()} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
