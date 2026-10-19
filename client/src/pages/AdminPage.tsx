import { PageHeading } from "../components/PageHeading";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ADMIN_USERS_LIMIT_MAX, type AdminStatsResponse, type AdminTotals, type AdminUserDetail, type AdminUserRow, type AdminUserSort, type AdminWeekPoint } from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { RequireUser } from "../components/RequireUser";
import { isOwner, useUser } from "../user";
import "../admin.css";
import { OpenTables } from "./OpenTables";
import { DiscordStatusCard } from "./DiscordStatusCard";

/**
 * Owner-only: who is on the platform and who is using it. Everything comes
 * from GET /api/admin/stats (totals, two weekly series, one row per player);
 * a row expands to that player's decks and submission history via
 * GET /api/admin/users/:id. Charts are plain CSS bars in the theme accent with
 * a table alternative, like the deck Stats panel. No card-game information here.
 */

const SORT_LABELS: Record<AdminUserSort, string> = { lastSeen: "Last seen", created: "Joined", decks: "Decks", games: "Games" };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "just now", "3 h ago", "12 days ago" for the table; the full date sits in the title. */
function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? "" : "s"} ago`;
  return fmtDate(iso);
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ------------------------------------------------------------ stat tiles

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="admin-tile">
      <span className="admin-tile-label">{label}</span>
      <span className="admin-tile-value">{value}</span>
      {note && <span className="admin-tile-note muted small">{note}</span>}
    </div>
  );
}

function Tiles({ t }: { t: AdminTotals }) {
  const subs = t.submissions;
  return (
    <section className="admin-tiles" aria-label="Totals">
      <Tile label="Players" value={t.users} note={`${t.usersWithEmail} with email · ${t.usersDeviceOnly} device only · ${t.owners} owner${t.owners === 1 ? "" : "s"}`} />
      <Tile label="Online now" value={t.onlineNow} note="connected to a table or seen in the last 5 min" />
      <Tile label="Active 24 h" value={t.activeToday} note={`${t.active7d} in 7 days · ${t.active30d} in 30 days`} />
      <Tile label="Decks" value={t.decks} note={`${t.libraryDecks} in the library`} />
      <Tile label="Submissions" value={subs.pending + subs.approved + subs.rejected} note={`${subs.pending} pending · ${subs.approved} approved · ${subs.rejected} rejected`} />
      <Tile label="Games started" value={t.gamesStarted7d} note={`in 7 days · ${t.gamesStarted30d} in 30 days`} />
      <Tile label="Tables created" value={t.roomsCreated7d} note={`in 7 days · ${t.roomsCreated30d} in 30 days`} />
      <Tile label="Agent games" value={t.agentGames30d} note={`in 30 days · ${usd(t.agentSpendUsd30d)} model spend`} />
    </section>
  );
}

// ------------------------------------------------------------ weekly bars

/**
 * One series of weekly counts as a column chart: thin bars from a shared
 * baseline in the accent colour, direct labels on the latest and the highest
 * week only, every value in a table underneath for anyone who prefers text.
 */
function WeeklyChart({ title, points, unit, summary }: { title: string; points: AdminWeekPoint[]; unit: string; summary: "total" | "latest" }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const peak = points.findIndex((p) => p.value === max && max > 0);
  const last = points.length - 1;
  const total = points.reduce((n, p) => n + p.value, 0);
  const aside = summary === "total" ? `${total} ${unit} in 12 weeks` : `${points[last]?.value ?? 0} ${unit} this week`;
  const weekLabel = (p: AdminWeekPoint) => {
    const d = new Date(`${p.weekStart}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const text = `${title}: ${points.map((p) => `week of ${weekLabel(p)}: ${p.value}`).join(", ")}.`;
  return (
    <figure className="admin-chart">
      <figcaption className="admin-chart-title">
        <span>{title}</span>
        <span className="muted small">{aside}</span>
      </figcaption>
      <ol className="admin-chart-bars" aria-hidden="true">
        {points.map((p, i) => (
          <li key={p.weekStart} className={i === last ? "admin-chart-bar is-latest" : "admin-chart-bar"} title={`Week of ${weekLabel(p)}: ${p.value} ${unit}`}>
            {(i === peak || i === last) && <span className="admin-chart-value">{p.value}</span>}
            <span className="admin-chart-fill" style={{ height: `${(p.value / max) * 100}%` }} />
            {(i === 0 || i === last) && <span className="admin-chart-tick muted">{weekLabel(p)}</span>}
          </li>
        ))}
      </ol>
      <p className="sr-only">{text}</p>
      <details className="admin-chart-table">
        <summary className="small">Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">{unit}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.weekStart}>
                <td>{weekLabel(p)}</td>
                <td>{p.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

// ------------------------------------------------------------ CSV

const CSV_COLUMNS: Array<[string, (u: AdminUserRow) => string | number | boolean]> = [
  ["id", (u) => u.id],
  ["name", (u) => u.displayName],
  ["email", (u) => u.email ?? ""],
  ["owner", (u) => u.isOwner],
  ["joined", (u) => u.createdAt],
  ["last_seen", (u) => u.lastSeenAt],
  ["online", (u) => u.online],
  ["devices", (u) => u.devices],
  ["decks", (u) => u.decks],
  ["submissions_pending", (u) => u.submissions.pending],
  ["submissions_approved", (u) => u.submissions.approved],
  ["submissions_rejected", (u) => u.submissions.rejected],
  ["games_played", (u) => u.gamesPlayed],
  ["games_hosted", (u) => u.gamesHosted],
  ["friends", (u) => u.friends],
];

export function usersCsv(rows: AdminUserRow[]): string {
  const cell = (v: string | number | boolean) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const u of rows) lines.push(CSV_COLUMNS.map(([, pick]) => cell(pick(u))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function downloadCsv(rows: AdminUserRow[]) {
  const blob = new Blob([usersCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cgwf-players-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------ users table

function UserDetail({ userId }: { userId: string }) {
  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.admin
      .user(userId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);
  if (error) return <p className="error small">{error}</p>;
  if (!detail) return <p className="muted small">Loading...</p>;
  return (
    <div className="admin-detail">
      <div>
        <h4>Decks ({detail.decks.length})</h4>
        {detail.decks.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="admin-detail-list">
            {detail.decks.map((d) => (
              <li key={d.id}>
                <span>{d.name}</span>
                <span className="muted small">
                  {d.bracket !== null ? (
                    <>
                      <span className={`bracket-pill b${d.bracket}`}>B{d.bracket}</span> in the library ·{" "}
                    </>
                  ) : null}
                  {fmtDate(d.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4>Submissions ({detail.submissions.length})</h4>
        {detail.submissions.length === 0 ? (
          <p className="muted small">None.</p>
        ) : (
          <ul className="admin-detail-list">
            {detail.submissions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.deckName} <span className={`admin-status is-${s.status}`}>{s.status}</span>
                </span>
                <span className="muted small">
                  {fmtDate(s.createdAt)}
                  {s.reviewedAt ? ` · reviewed ${fmtDate(s.reviewedAt)}` : ""}
                  {s.reason ? ` · "${s.reason}"` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UsersTable({ rows, open, onToggle }: { rows: AdminUserRow[]; open: string | null; onToggle: (id: string) => void }) {
  const now = Date.now();
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th scope="col">Player</th>
          <th scope="col">Account</th>
          <th scope="col">Last seen</th>
          <th scope="col">Joined</th>
          <th scope="col" className="is-num">
            Devices
          </th>
          <th scope="col" className="is-num">
            Decks
          </th>
          <th scope="col" className="is-num">
            Submissions
          </th>
          <th scope="col" className="is-num">
            Games
          </th>
          <th scope="col" className="is-num">
            Friends
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => {
          const expanded = open === u.id;
          const subs = u.submissions.pending + u.submissions.approved + u.submissions.rejected;
          return [
            <tr key={u.id} className={expanded ? "admin-row is-open" : "admin-row"}>
              <td data-label="Player">
                <button type="button" className="admin-row-toggle" aria-expanded={expanded} onClick={() => onToggle(u.id)}>
                  <Avatar avatar={u.avatar} color={u.color} size={28} />
                  <span className="admin-row-name">
                    {u.displayName}
                    {u.isOwner && <span className="tag">Owner</span>}
                  </span>
                  <span className={u.online ? "admin-online is-on" : "admin-online"} title={u.online ? "Online now" : "Offline"}>
                    <span className="sr-only">{u.online ? "online" : "offline"}</span>
                  </span>
                </button>
              </td>
              <td data-label="Account" className="admin-cell-email">
                {u.email ?? <span className="muted">device only</span>}
              </td>
              <td data-label="Last seen" title={new Date(u.lastSeenAt).toLocaleString()}>
                {ago(u.lastSeenAt, now)}
              </td>
              <td data-label="Joined" title={new Date(u.createdAt).toLocaleString()}>
                {fmtDate(u.createdAt)}
              </td>
              <td data-label="Devices" className="is-num">
                {u.devices}
              </td>
              <td data-label="Decks" className="is-num">
                {u.decks}
              </td>
              <td data-label="Submissions" className="is-num" title={`${u.submissions.pending} pending, ${u.submissions.approved} approved, ${u.submissions.rejected} rejected`}>
                <span>
                  {subs}
                  {u.submissions.pending > 0 && <span className="admin-pending"> ({u.submissions.pending} pending)</span>}
                </span>
              </td>
              <td data-label="Games" className="is-num" title={`${u.gamesPlayed} played, ${u.gamesHosted} hosted`}>
                <span>
                  {u.gamesPlayed}
                  <span className="muted small"> / {u.gamesHosted} hosted</span>
                </span>
              </td>
              <td data-label="Friends" className="is-num">
                {u.friends}
              </td>
            </tr>,
            expanded ? (
              <tr key={`${u.id}-detail`} className="admin-row-detail">
                <td colSpan={9}>
                  <UserDetail userId={u.id} />
                </td>
              </tr>
            ) : null,
          ];
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------ page

function Overview() {
  const [data, setData] = useState<AdminStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<AdminUserSort>("lastSeen");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        setData(await api.admin.stats({ sort, q: filter.trim(), limit: ADMIN_USERS_LIMIT_MAX, refresh }));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [sort, filter],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), filter ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, filter]);

  const rows = useMemo(() => data?.users ?? [], [data]);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading...</p>;
  return (
    <>
      <p className="notice small admin-privacy">
        <strong>Private to you.</strong> This page is visible only to the owner; players never see each other&rsquo;s emails or activity. Nothing here touches a
        game: no hands, libraries or face-down cards are involved, only who signed up, when they were last around and what they built.
      </p>
      <Tiles t={data.totals} />
      <DiscordStatusCard />
      <OpenTables />
      <section className="admin-charts" aria-label="Twelve-week trends">
        <WeeklyChart title="Sign-ups per week" points={data.signupsPerWeek} unit="sign-ups" summary="total" />
        <WeeklyChart title="Active players per week" points={data.activePerWeek} unit="players" summary="latest" />
      </section>
      <p className="muted small admin-generated">
        Computed {ago(data.generatedAt)}
        {data.cached ? " (cached for a minute)" : ""} ·{" "}
        <button type="button" className="admin-link-button" disabled={busy} onClick={() => void load(true)}>
          Refresh
        </button>
        {error && <span className="error"> · {error}</span>}
      </p>

      <section className="admin-users" aria-label="Players">
        <div className="admin-toolbar">
          <h2>
            Players <span className="muted small">({data.usersTotal})</span>
          </h2>
          <label className="admin-filter">
            <span className="sr-only">Filter by name or email</span>
            <input type="search" placeholder="Filter by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <label className="admin-sort">
            <span className="small muted">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as AdminUserSort)}>
              {(Object.keys(SORT_LABELS) as AdminUserSort[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-small" disabled={rows.length === 0} onClick={() => downloadCsv(rows)}>
            Download CSV
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="muted">No players match.</p>
        ) : (
          <UsersTable rows={rows} open={open} onToggle={(id) => setOpen((cur) => (cur === id ? null : id))} />
        )}
        {data.usersTotal > rows.length && (
          <p className="muted small">
            Showing the first {rows.length} of {data.usersTotal}; narrow the filter to see the rest.
          </p>
        )}
      </section>
      <p className="muted small">
        Games count a table once the host pressed Start; &ldquo;hosted&rdquo; is by the current host. Weekly activity is a lower bound built from stored
        timestamps (last visit, sessions, decks, tables, submissions, game events). The deck library and the agent deck queue live under{" "}
        <Link to="/admin/library">Library</Link>; computer opponents under <Link to="/admin/agents">Agents</Link>.
      </p>
    </>
  );
}

export function AdminPage() {
  const { user } = useUser();
  return (
    <main className="page admin-page">
      <RequireUser>
        <PageHeading title="Admin" eyebrow="Behind the game nights">A clear view of your players, decks, and table activity.</PageHeading>
        {isOwner(user) ? <Overview /> : <p className="muted">Owner only.</p>}
      </RequireUser>
    </main>
  );
}
