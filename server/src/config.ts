import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const here = path.dirname(fileURLToPath(import.meta.url)); // server/src or server/dist
const serverRoot = path.resolve(here, "..");
const repoRoot = path.resolve(serverRoot, "..");

// Settings come from the environment; in development a .env at the repo root fills the gaps.
// Paths are resolved against the repo root so `npm run dev -w server` and `node server/dist/index.js`
// agree on where ./data lives, whatever the current directory is.
dotenv.config({ path: path.join(repoRoot, ".env"), quiet: true });
const dataDir = path.resolve(repoRoot, env("DATA_DIR", "./data"));

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  isProduction: env("NODE_ENV", "development") === "production",
  dataDir,
  dbFile: path.join(dataDir, "cgwf.db"),
  imageDir: path.join(dataDir, "images"),
  uploadDir: path.join(dataDir, "uploads"),
  bulkDir: path.join(dataDir, "scryfall"),
  contactEmail: env("CONTACT_EMAIL", "unknown@example.com"),
  cardDataMaxAgeHours: Number(env("CARD_DATA_MAX_AGE_HOURS", "24")),
  skipAutoIngest: env("SKIP_AUTO_INGEST", "0") === "1",
  /** Optional shared secret allowing POST /api/admin/* from outside the machine. */
  adminToken: env("ADMIN_TOKEN", ""),
  appName: "CGwF",
  appVersion: env("APP_VERSION", "0.1.0"),
  /** Directory the client build lands in (served as static files in production). */
  clientDist: path.resolve(env("CLIENT_DIST", path.join(serverRoot, "../client/dist"))),
  /** Drizzle SQL migrations folder. */
  migrationsDir: path.resolve(env("MIGRATIONS_DIR", path.join(serverRoot, "drizzle"))),
} as const;

export function ensureDataDirs(): void {
  for (const dir of [config.dataDir, config.imageDir, config.bulkDir, config.uploadDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** User-Agent Scryfall asks for: descriptive, with a way to reach us. */
export const SCRYFALL_USER_AGENT = `${config.appName}/${config.appVersion} (private card table; ${config.contactEmail})`;
