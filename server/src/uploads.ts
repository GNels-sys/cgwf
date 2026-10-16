import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { UPLOAD_MAX_BYTES } from "@cgwf/shared";
import { config } from "./config.js";

/**
 * Player image uploads (playmats, sleeve backs). Pure validation lives here so
 * it can be unit-tested without a server: we trust the bytes, never the
 * declared content type, and we never transform the image.
 */

export interface SniffedImage {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  ext: "jpg" | "png" | "webp" | "gif";
}

/** Identify a supported image from its magic bytes, or null. */
export function sniffImage(buf: Uint8Array): SniffedImage | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return { mime: "image/png", ext: "png" };
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

export type UploadCheck = { ok: true; image: SniffedImage } | { ok: false; status: 400 | 413 | 415; error: string };

/** Full validation of an upload body: size, then real image bytes. */
export function checkUpload(buf: Uint8Array, declaredType: string | undefined): UploadCheck {
  if (buf.length === 0) return { ok: false, status: 400, error: "empty upload" };
  if (buf.length > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: `images must be ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB or smaller` };
  if (declaredType && !declaredType.startsWith("image/")) return { ok: false, status: 415, error: "only images can be uploaded" };
  const image = sniffImage(buf);
  if (!image) return { ok: false, status: 415, error: "that file is not a JPEG, PNG, WebP or GIF image" };
  return { ok: true, image };
}

export function newUploadId(): string {
  return randomBytes(16).toString("hex");
}

export function uploadFile(id: string, ext: string): string {
  return path.join(config.uploadDir, `${id}.${ext}`);
}

export function extFor(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export function writeUpload(id: string, image: SniffedImage, buf: Uint8Array): string {
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const dest = uploadFile(id, image.ext);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return dest;
}

export function removeUpload(id: string, mime: string): void {
  try {
    fs.rmSync(uploadFile(id, extFor(mime)), { force: true });
  } catch {
    /* already gone */
  }
}
