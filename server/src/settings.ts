import { and, eq, sql } from "drizzle-orm";
import { DEFAULT_SETTINGS, sanitizeSettings, type UserSettings } from "@cgwf/shared";
import type { DbHandle } from "./db/index.js";
import { roomMembers, uploads, userSettings } from "./db/schema.js";

/** Reading personalization settings; shared by the REST routes and the room broadcaster. */

/** Load a user's settings, falling back to defaults and dropping uploads that no longer exist. */
export function loadSettings(handle: DbHandle, userId: string): UserSettings {
  const row = handle.db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  const s = sanitizeSettings(row?.settings ?? {});
  for (const key of ["playmat", "sleeve"] as const) {
    const t = s[key];
    if (t.kind === "upload" && !handle.db.select({ id: uploads.id }).from(uploads).where(and(eq(uploads.id, t.id), eq(uploads.userId, userId))).get()) {
      s[key] = DEFAULT_SETTINGS[key];
    }
  }
  return s;
}

/** May `viewer` see `owner`'s uploads? Yes for the owner and for anyone sharing a room with them. */
export function canSeeUploadsOf(handle: DbHandle, viewer: string, owner: string): boolean {
  if (viewer === owner) return true;
  const a = roomMembers;
  const hit = handle.db
    .select({ roomId: a.roomId })
    .from(a)
    .where(and(eq(a.userId, owner), sql`exists (select 1 from room_members b where b.room_id = ${a.roomId} and b.user_id = ${viewer})`))
    .limit(1)
    .get();
  return Boolean(hit);
}

