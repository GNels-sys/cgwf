import { useState } from "react";
import { normaliseInvite, type RoomInfo } from "@cgwf/shared";
import { useSettings } from "../settings";
import type { RoomSocket } from "./socket";

/** A plain headphone glyph (original vector, no Discord artwork). */
export function HeadphoneIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <rect x="3" y="14" width="5" height="7" rx="2" fill="currentColor" />
      <rect x="16" y="14" width="5" height="7" rx="2" fill="currentColor" />
    </svg>
  );
}

/** The table's small headphone button beside the menu (only when this table has a voice link). */
export function VoiceButton({ room }: { room: RoomInfo }) {
  const url = room.voice?.url;
  if (!url) return null;
  return (
    <a className="btn btn-small voice-btn" href={url} target="_blank" rel="noopener noreferrer" aria-label="Join voice on Discord" title="Join voice on Discord">
      <HeadphoneIcon />
    </a>
  );
}

/**
 * Lobby: "Join voice on Discord" for the table (the CGwF bot's channel, or a link the host pasted).
 * When the bot is off or Discord is unavailable, the host can paste an invite and save it as their default.
 */
export function VoicePanel({ room, sock, isHost }: { room: RoomInfo; sock: RoomSocket; isHost: boolean }) {
  const v = room.voice;
  const [draft, setDraft] = useState("");
  const [saveDefault, setSaveDefault] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { update } = useSettings();
  if (!v) return null;
  const showManual = isHost && (v.source !== "discord");
  const submit = async () => {
    const url = normaliseInvite(draft);
    if (!url) {
      setNote("Paste a Discord invite link (discord.gg/... or discord.com/invite/...).");
      return;
    }
    sock.send({ t: "voiceLink", url });
    setNote(null);
    setDraft("");
    if (saveDefault) {
      update({ discordInvite: url });
      setNote("Saved as your default for tables you host.");
    }
  };
  return (
    <section className="voice-panel" aria-label="Voice">
      {v.url ? (
        <a className="btn voice-join" href={v.url} target="_blank" rel="noopener noreferrer">
          <HeadphoneIcon /> Join voice on Discord
        </a>
      ) : v.botEnabled && !v.unavailable ? (
        <p className="muted small">Setting up this table&apos;s voice channel on Discord&hellip;</p>
      ) : (
        <p className="muted small">{v.unavailable ? "Voice on Discord is unavailable right now. " : ""}No voice link for this table yet{isHost ? ": paste a Discord invite below." : "."}</p>
      )}
      {v.source === "manual" && <p className="muted small">Link added by the host{v.unavailable ? " (the CGwF bot could not make a channel)" : ""}.</p>}
      {showManual && (
        <form
          className="voice-manual"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>{v.url ? "Replace the voice link" : "Discord invite link"}</span>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://discord.gg/..." inputMode="url" autoComplete="off" spellCheck={false} />
          </label>
          <label className="voice-default small">
            <input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> Use for every table I host
          </label>
          <div className="voice-manual-actions">
            <button className="btn btn-small" type="submit" disabled={!draft.trim()}>
              Save link
            </button>
            {v.source === "manual" && (
              <button className="btn btn-small" type="button" onClick={() => sock.send({ t: "voiceLink", url: null })}>
                Remove link
              </button>
            )}
          </div>
        </form>
      )}
      {note && <p className="small muted">{note}</p>}
    </section>
  );
}

/** Personalize page: the Discord invite used for tables you host when the CGwF bot is off. */
export function VoiceDefault() {
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  return (
    <section className="surface voice-default-panel" aria-label="Voice on Discord">
      <h2>Voice on Discord</h2>
      <p className="muted small">
        CGwF opens a voice channel for each table on its Discord server when the bot is running. If it is not, the tables you host use this invite instead.
      </p>
      <p className="small">{settings.discordInvite ? <>Your default: <a href={settings.discordInvite} target="_blank" rel="noopener noreferrer">{settings.discordInvite}</a></> : "No default link saved."}</p>
      <form
        className="voice-manual"
        onSubmit={(e) => {
          e.preventDefault();
          const url = normaliseInvite(draft);
          if (!url) return setNote("Paste a Discord invite link (discord.gg/... or discord.com/invite/...).");
          update({ discordInvite: url });
          setDraft("");
          setNote("Saved.");
        }}
      >
        <label className="field">
          <span>Discord invite link</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://discord.gg/..." inputMode="url" autoComplete="off" spellCheck={false} />
        </label>
        <div className="voice-manual-actions">
          <button className="btn btn-small" type="submit" disabled={!draft.trim()}>
            Save
          </button>
          {settings.discordInvite && (
            <button className="btn btn-small" type="button" onClick={() => (update({ discordInvite: null }), setNote("Removed."))}>
              Remove
            </button>
          )}
        </div>
      </form>
      {note && <p className="small muted">{note}</p>}
    </section>
  );
}
