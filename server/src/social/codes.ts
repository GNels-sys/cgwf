import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { FRIEND_CODE_ALPHABET, FRIEND_CODE_LENGTH } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { users } from "../db/schema.js";

export function newFriendCode(): string {
  let out = "";
  for (let i = 0; i < FRIEND_CODE_LENGTH; i++) out += FRIEND_CODE_ALPHABET[randomInt(FRIEND_CODE_ALPHABET.length)];
  return out;
}

/**
 * Friend codes are assigned the first time they are needed (profile page,
 * friends page) rather than by the migration, so existing rows need no
 * backfill script. Unique index on users.friend_code catches a collision;
 * we just draw again.
 */
export function ensureFriendCode(handle: DbHandle, userId: string): string {
  const row = handle.db.select({ code: users.friendCode }).from(users).where(eq(users.id, userId)).get();
  if (row?.code) return row.code;
  for (let tries = 0; tries < 20; tries++) {
    const code = newFriendCode();
    try {
      handle.db.update(users).set({ friendCode: code }).where(eq(users.id, userId)).run();
      return code;
    } catch {
      /* collision on the unique index: draw again */
    }
  }
  throw new Error("could not assign a friend code");
}
