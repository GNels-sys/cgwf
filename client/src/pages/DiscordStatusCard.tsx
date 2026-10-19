import { useEffect, useState } from "react";
import type { DiscordStatus } from "@cgwf/shared";
import { api } from "../api";

/** Owner, Admin page: is the CGwF Discord bot connected, and if not, exactly what is wrong. */
export function DiscordStatusCard() {
  const [status, setStatus] = useState<DiscordStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.admin
      .discord()
      .then((r) => setStatus(r.status))
      .catch(() => setStatus(null));
  }, []);
  const recheck = async () => {
    setBusy(true);
    try {
      setStatus((await api.admin.discordCheck()).status);
    } finally {
      setBusy(false);
    }
  };
  if (status === undefined) return null;
  const line =
    status === null
      ? "Discord voice is not wired on this server."
      : status.state === "ok"
        ? `Discord: connected as ${status.botName} / category ${status.categoryName}${status.guildName ? ` in ${status.guildName}` : ""}`
        : status.state === "checking"
          ? "Discord: checking…"
          : status.state === "off"
            ? `Discord: off. ${status.problem ?? ""} Hosts can still paste a Discord invite per table.`
            : `Discord: not working. ${status.problem ?? ""}`;
  return (
    <section className={`admin-discord is-${status?.state ?? "off"}`} aria-label="Discord voice">
      <p className="small">
        <strong>Voice.</strong> {line}{" "}
        {status && status.state !== "off" && (
          <button type="button" className="admin-link-button" disabled={busy} onClick={() => void recheck()}>
            {busy ? "Checking…" : "Check again"}
          </button>
        )}
      </p>
    </section>
  );
}
