import { randomInt } from "node:crypto";
import { ROOM_CODE_LENGTH } from "@cgwf/shared";

/** Join-code alphabet: no 0/O or 1/I/L so codes survive being read out loud. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newRoomCode(): string {
  let out = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Uppercase and strip spaces/dashes so a code pasted from a chat still works. */
export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, ROOM_CODE_LENGTH);
}

export function isRoomCode(v: string): boolean {
  return v.length === ROOM_CODE_LENGTH && [...v].every((ch) => ALPHABET.includes(ch));
}
