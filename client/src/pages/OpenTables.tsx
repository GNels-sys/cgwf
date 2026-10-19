import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AdminOpenTable } from "@cgwf/shared";
import { api } from "../api";

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * Owner, Admin page: tables that never finished. Close one, or every table idle for more than 24 hours.
 * Closing records no result (an engine game is torn down and kept as "abandoned", never counted).
 * The server also closes tables idle for 48 hours on its own.
 */
export function OpenTables() {
  const [tables, setTables] = useState<AdminOpenTable[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTables((await api.admin.tables()).tables);
    } catch (e) {
      setNote((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const closeOne = async (code: string) => {
    if (!window.confirm(`Close table ${code}? No result is recorded.`)) return;
    setBusy(true);
    try {
      await api.admin.closeTable(code);
      setNote(`Closed ${code}.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const closeIdle = async () => {
    if (!window.confirm("Close every table idle for more than 24 hours? No results are recorded.")) return;
    setBusy(true);
    try {
      const r = await api.admin.closeIdle(24);
      setNote(`Closed ${r.closed} of ${r.open} open tables.`);
      await load();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-open-tables" aria-label="Open tables">
      <div className="admin-toolbar">
        <h2>
          Open tables <span className="muted small">({tables?.length ?? "…"})</span>
        </h2>
        <button type="button" className="btn btn-small btn-danger" disabled={busy || !tables?.length} onClick={() => void closeIdle()}>
          Close all idle &gt; 24 h
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
      {tables && tables.length === 0 && <p className="muted">No open tables.</p>}
      {tables && tables.length > 0 && (
        <ul className="admin-open-list">
          {tables.map((t) => (
            <li key={t.code}>
              <Link to={`/room/${t.code}`} className="room-code">
                {t.code}
              </Link>
              <span className="muted small">
                {t.engine ? "Rules engine" : "Casual (legacy)"} · {t.status === "lobby" ? "waiting" : "in progress"} · {t.players} player{t.players === 1 ? "" : "s"} · host {t.hostName} · last activity {ago(t.updatedAt)}
              </span>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void closeOne(t.code)}>
                Close
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Closing records no result. The server also closes tables idle for 48 hours on its own.</p>
    </section>
  );
}
