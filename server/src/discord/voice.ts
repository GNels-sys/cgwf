import { eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { DiscordStatus } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { rooms } from "../db/schema.js";
import { DiscordClient, DiscordError, type FetchLike } from "./client.js";

/** 4 players + 1 spectator. */
export const VOICE_USER_LIMIT = 5;
/** Channel names the bot owns: "CGwF · ABC123". The orphan sweep only ever touches these. */
export const VOICE_NAME_PREFIX = "CGwF · ";
/** After a game ends on its own, the channel stays this long so the table can talk and start a rematch. */
export const VOICE_REMATCH_GRACE_MS = 15 * 60 * 1000;

// Discord permission bits
const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  CONNECT: 1n << 20n,
};
const NEEDED: Array<[bigint, string]> = [
  [P.VIEW_CHANNEL, "View Channels"],
  [P.MANAGE_CHANNELS, "Manage Channels"],
  [P.CREATE_INSTANT_INVITE, "Create Instant Invite"],
  [P.CONNECT, "Connect"],
];

interface Overwrite {
  id: string;
  type: number; // 0 role, 1 member
  allow: string;
  deny: string;
}
interface Channel {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
  permission_overwrites?: Overwrite[];
}

export function voiceChannelName(code: string): string {
  return `${VOICE_NAME_PREFIX}${code}`;
}

/** Effective permissions of a member on a channel (Discord's documented algorithm). */
export function effectivePermissions(o: {
  guildId: string;
  ownerId: string;
  memberId: string;
  memberRoles: string[];
  roles: Array<{ id: string; permissions: string }>;
  overwrites: Overwrite[];
}): bigint {
  if (o.memberId === o.ownerId) return ~0n;
  const roleById = new Map(o.roles.map((r) => [r.id, BigInt(r.permissions)]));
  let perms = roleById.get(o.guildId) ?? 0n; // @everyone
  for (const id of o.memberRoles) perms |= roleById.get(id) ?? 0n;
  if (perms & P.ADMINISTRATOR) return ~0n;
  const ow = (id: string) => o.overwrites.find((x) => x.id === id);
  const everyone = ow(o.guildId);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const id of o.memberRoles) {
    const r = o.overwrites.find((x) => x.id === id && x.type === 0);
    if (r) {
      allow |= BigInt(r.allow);
      deny |= BigInt(r.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const m = o.overwrites.find((x) => x.id === o.memberId && x.type === 1);
  if (m) perms = (perms & ~BigInt(m.deny)) | BigInt(m.allow);
  return perms;
}

export interface VoiceConfig {
  token: string;
  guildId: string;
  categoryId: string;
}

/**
 * The CGwF Discord bot: one temporary voice channel per table, under the owner's category. Every call is
 * fire-and-forget from the table's point of view: failures are logged and the table shows "voice
 * unavailable" (and the manual link, if any); the game never waits on Discord.
 */
export class DiscordVoice {
  status: DiscordStatus;
  private readonly client: DiscordClient | null;
  /** Serialises create / rename / delete per room (a close may arrive while the create is in flight). */
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Rooms whose channel could not be created (shown as "voice unavailable"). */
  readonly failed = new Set<string>();
  /** Called after a room's voice details change, so its members get a fresh room frame. */
  onChange: (roomId: string) => void = () => {};

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
    private readonly cfg: VoiceConfig | null,
    fetchImpl?: FetchLike,
    clientOpts: { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {},
  ) {
    this.client = cfg ? new DiscordClient({ token: cfg.token, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...clientOpts }) : null;
    this.status = cfg ? { state: "checking", botName: null, categoryName: null, problem: null } : { state: "off", botName: null, categoryName: null, problem: "Not configured: set DISCORD_BOT_TOKEN, DISCORD_GUILD_ID and DISCORD_CATEGORY_ID." };
  }

  /** The bot is configured and the last check passed. */
  get usable(): boolean {
    return this.status.state === "ok";
  }

  private chain<T>(roomId: string, fn: () => Promise<T>): Promise<T | undefined> {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch((err: unknown) => {
      this.log.warn({ roomId, err: err instanceof Error ? err.message : String(err) }, "discord voice call failed");
      return undefined;
    });
    this.chains.set(roomId, next);
    void next.finally(() => {
      if (this.chains.get(roomId) === next) this.chains.delete(roomId);
    });
    return next;
  }

  /** For tests: wait for every queued Discord call. */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  /** Boot check: the token works, the category exists in that guild, and the bot can manage it. */
  async verify(): Promise<DiscordStatus> {
    if (!this.client || !this.cfg) return this.status;
    const { guildId, categoryId } = this.cfg;
    try {
      let me: { id: string; username: string; global_name?: string | null };
      try {
        me = await this.client.request("GET", "/users/@me");
      } catch (err) {
        throw new Error(err instanceof DiscordError && err.status === 401 ? "DISCORD_BOT_TOKEN is not a valid bot token (Discord answered 401 Unauthorized)." : `could not reach Discord: ${(err as Error).message}`);
      }
      let guild: { id: string; name: string; owner_id: string; roles: Array<{ id: string; permissions: string }> };
      try {
        guild = await this.client.request("GET", `/guilds/${guildId}`);
      } catch (err) {
        throw new Error(err instanceof DiscordError && (err.status === 404 || err.status === 403) ? `DISCORD_GUILD_ID ${guildId}: the bot is not in that server (or the id is wrong).` : `reading the server failed: ${(err as Error).message}`);
      }
      const channels = await this.client.request<Channel[]>("GET", `/guilds/${guildId}/channels`);
      const category = channels.find((c) => c.id === categoryId);
      if (!category) throw new Error(`DISCORD_CATEGORY_ID ${categoryId}: no channel with that id in "${guild.name}".`);
      if (category.type !== 4) throw new Error(`DISCORD_CATEGORY_ID ${categoryId}: "${category.name}" is not a category (type ${category.type}).`);
      const member = await this.client.request<{ roles: string[] }>("GET", `/guilds/${guildId}/members/${me.id}`);
      const perms = effectivePermissions({ guildId, ownerId: guild.owner_id, memberId: me.id, memberRoles: member.roles, roles: guild.roles, overwrites: category.permission_overwrites ?? [] });
      const missing = NEEDED.filter(([bit]) => (perms & bit) === 0n).map(([, name]) => name);
      if (missing.length) throw new Error(`The bot lacks ${missing.join(", ")} on the category "${category.name}".`);
      this.status = { state: "ok", botName: me.global_name || me.username, categoryName: category.name, problem: null, guildName: guild.name };
      this.log.info({ bot: me.username, category: category.name }, "discord voice ready");
    } catch (err) {
      this.status = { state: "error", botName: this.status.botName, categoryName: null, problem: (err as Error).message };
      this.log.warn({ problem: this.status.problem }, "discord voice unavailable");
    }
    return this.status;
  }

  /** A new table (lobby): create its voice channel and invite. */
  onRoomCreated(roomId: string, code: string): void {
    if (!this.usable) return;
    void this.chain(roomId, async () => {
      const row = this.handle.db.select().from(rooms).where(eq(rooms.id, roomId)).get();
      if (!row || row.voiceChannelId || row.status === "ended") return;
      try {
        const ch = await this.client!.request<Channel>("POST", `/guilds/${this.cfg!.guildId}/channels`, { name: voiceChannelName(code), type: 2, parent_id: this.cfg!.categoryId, user_limit: VOICE_USER_LIMIT });
        const inv = await this.client!.request<{ code: string }>("POST", `/channels/${ch.id}/invites`, { max_age: 0, max_uses: 0, unique: true });
        const still = this.handle.db.select({ status: rooms.status }).from(rooms).where(eq(rooms.id, roomId)).get();
        if (!still || still.status === "ended") {
          // the table closed while Discord was answering
          await this.client!.request("DELETE", `/channels/${ch.id}`).catch(() => undefined);
          return;
        }
        this.handle.db.update(rooms).set({ voiceChannelId: ch.id, voiceInviteUrl: `https://discord.gg/${inv.code}` }).where(eq(rooms.id, roomId)).run();
        this.failed.delete(roomId);
      } catch (err) {
        this.failed.add(roomId);
        throw err;
      } finally {
        this.onChange(roomId);
      }
    });
  }

  /** Rematch: the new table takes over the old table's channel (renamed to the new code). */
  onRematch(oldRoomId: string, newRoomId: string, newCode: string): void {
    this.cancelRelease(oldRoomId);
    const old = this.handle.db.select().from(rooms).where(eq(rooms.id, oldRoomId)).get();
    if (!old?.voiceChannelId) {
      // nothing to reuse: a fresh channel (or carry the manual link over)
      if (old?.voiceManualUrl) this.handle.db.update(rooms).set({ voiceManualUrl: old.voiceManualUrl }).where(eq(rooms.id, newRoomId)).run();
      this.onRoomCreated(newRoomId, newCode);
      return;
    }
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(rooms).set({ voiceChannelId: old.voiceChannelId, voiceInviteUrl: old.voiceInviteUrl, voiceManualUrl: old.voiceManualUrl }).where(eq(rooms.id, newRoomId)).run();
      this.handle.db.update(rooms).set({ voiceChannelId: null, voiceInviteUrl: null }).where(eq(rooms.id, oldRoomId)).run();
    })();
    if (!this.client) return;
    const channelId = old.voiceChannelId;
    void this.chain(newRoomId, () => this.client!.request("PATCH", `/channels/${channelId}`, { name: voiceChannelName(newCode) }));
  }

  /** The table is gone (closed, idle-closed): delete its channel now. */
  release(roomId: string): void {
    this.cancelRelease(roomId);
    const row = this.handle.db.select({ ch: rooms.voiceChannelId }).from(rooms).where(eq(rooms.id, roomId)).get();
    if (!row?.ch && !this.chains.has(roomId)) return;
    void this.chain(roomId, async () => {
      const cur = this.handle.db.select({ ch: rooms.voiceChannelId }).from(rooms).where(eq(rooms.id, roomId)).get();
      if (!cur?.ch) return;
      this.handle.db.update(rooms).set({ voiceChannelId: null, voiceInviteUrl: null }).where(eq(rooms.id, roomId)).run();
      if (this.client) await this.deleteChannel(cur.ch);
    });
  }

  /** The game ended on its own: keep the channel for a rematch, then delete it. */
  scheduleRelease(roomId: string, ms = VOICE_REMATCH_GRACE_MS): void {
    this.cancelRelease(roomId);
    const t = setTimeout(() => {
      this.timers.delete(roomId);
      this.release(roomId);
    }, ms);
    t.unref();
    this.timers.set(roomId, t);
  }

  /** The table is open again (a reverted ending): keep its channel. */
  keep(roomId: string): void {
    this.cancelRelease(roomId);
  }

  private cancelRelease(roomId: string): void {
    const t = this.timers.get(roomId);
    if (t) clearTimeout(t);
    this.timers.delete(roomId);
  }

  private async deleteChannel(id: string): Promise<void> {
    try {
      await this.client!.request("DELETE", `/channels/${id}`);
    } catch (err) {
      if (err instanceof DiscordError && err.status === 404) return; // already gone
      throw err;
    }
  }

  /**
   * Boot / hourly: delete CGwF voice channels under the category whose table is not open any more (left
   * behind by a crash or a deploy). A table that ended within the rematch grace keeps its channel.
   */
  async sweepOrphans(): Promise<number> {
    if (!this.usable) return 0;
    const channels = await this.client!.request<Channel[]>("GET", `/guilds/${this.cfg!.guildId}/channels`);
    const ours = channels.filter((c) => c.type === 2 && c.parent_id === this.cfg!.categoryId && c.name.startsWith(VOICE_NAME_PREFIX));
    if (!ours.length) return 0;
    const owners = this.handle.db
      .select({ id: rooms.id, status: rooms.status, updatedAt: rooms.updatedAt, ch: rooms.voiceChannelId })
      .from(rooms)
      .where(inArray(rooms.voiceChannelId, ours.map((c) => c.id)))
      .all();
    const byChannel = new Map(owners.map((o) => [o.ch, o]));
    let deleted = 0;
    for (const c of ours) {
      const room = byChannel.get(c.id);
      const open = room && (room.status === "lobby" || room.status === "playing");
      const inGrace = room && room.status === "ended" && Date.now() - Date.parse(room.updatedAt) < VOICE_REMATCH_GRACE_MS;
      if (open) continue;
      if (inGrace) {
        this.scheduleRelease(room.id, VOICE_REMATCH_GRACE_MS - (Date.now() - Date.parse(room.updatedAt)));
        continue;
      }
      try {
        if (room) this.handle.db.update(rooms).set({ voiceChannelId: null, voiceInviteUrl: null }).where(eq(rooms.id, room.id)).run();
        await this.deleteChannel(c.id);
        deleted++;
      } catch (err) {
        this.log.warn({ channel: c.id, err: (err as Error).message }, "deleting an orphan voice channel failed");
      }
    }
    if (deleted) this.log.info({ deleted }, "deleted orphan CGwF voice channels");
    return deleted;
  }
}

export { normaliseInvite } from "@cgwf/shared";
