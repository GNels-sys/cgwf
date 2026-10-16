import { PRESENCE_ONLINE_MS } from "@cgwf/shared";

/**
 * Who is around right now. Every authenticated request (REST or WebSocket
 * handshake) touches the caller; the client's notification poll acts as the
 * heartbeat. In-memory only: a restart simply makes everyone offline until
 * their next request, which is the truth anyway.
 */
export class Presence {
  private lastSeen = new Map<string, number>();

  touch(userId: string, at = Date.now()): void {
    this.lastSeen.set(userId, at);
  }

  isOnline(userId: string, now = Date.now()): boolean {
    const t = this.lastSeen.get(userId);
    return t !== undefined && now - t < PRESENCE_ONLINE_MS;
  }

  /** Drop stale entries so the map never grows past the active population. */
  sweep(now = Date.now()): void {
    for (const [id, t] of this.lastSeen) if (now - t > PRESENCE_ONLINE_MS * 10) this.lastSeen.delete(id);
  }
}

/** One per process; auth.ts touches it, the social routes read it. */
export const presence = new Presence();
