import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Password hashing with Node's built-in scrypt (no native dependency).
 * Record format: scrypt$N$r$p$<salt b64url>$<hash b64url>, so the cost can be
 * raised later and old records still verify.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time check; a malformed record simply fails. */
export async function verifyPassword(password: string, record: string | null | undefined): Promise<boolean> {
  if (!record) return false;
  const parts = record.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length < 8 || expected.length < 16) return false;
  try {
    const key = await scrypt(password, salt, expected.length, { N: n, r, p });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Constant-time equality for short secrets of possibly different lengths. */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Always compare same-length buffers so the length never short-circuits the work.
  const same = ba.length === bb.length;
  const probe = same ? bb : Buffer.alloc(ba.length);
  const equal = timingSafeEqual(ba, probe);
  return equal && same;
}
