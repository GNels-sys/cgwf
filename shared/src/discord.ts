/**
 * Voice on Discord (2026-10-19): the CGwF bot gives every table a temporary voice channel; when the bot is
 * not configured or Discord is unavailable, the host can paste an invite link instead.
 */

/** The bot's configuration check, shown to the owner on the Admin page. */
export interface DiscordStatus {
  state: "off" | "checking" | "ok" | "error";
  botName: string | null;
  categoryName: string | null;
  /** Exactly what is wrong (which secret / which permission), or why the feature is off. */
  problem: string | null;
  guildName?: string;
}

/** A table's voice link, sent only to members of that table (players and spectators). */
export interface RoomVoice {
  /** Invite to open ("Join voice on Discord"); null when there is none yet. */
  url: string | null;
  /** "discord" = the bot's channel for this table; "manual" = a link the host pasted. */
  source: "discord" | "manual" | null;
  /** The bot is on but could not make this table's channel (or it is still being made: url null). */
  unavailable: boolean;
  /** The bot is configured and working on this server. */
  botEnabled: boolean;
}

/** A Discord invite link (discord.gg/... or discord.com/invite/...), normalised to https://discord.gg/<code>; null if not one. */
export function normaliseInvite(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?$/i.exec(s);
  return m ? `https://discord.gg/${m[1]}` : null;
}
