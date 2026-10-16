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
  /** One-time code that grants the owner flag (POST /api/me/owner-claim). Unset = claiming disabled. */
  ownerClaimCode: env("OWNER_CLAIM_CODE", ""),
  /** Phase 7 computer opponents. Off unless AGENTS_ENABLED=1; the key comes from the environment only. */
  agentsEnabled: env("AGENTS_ENABLED", "0") === "1",
  anthropicApiKey: env("ANTHROPIC_API_KEY", ""),
  /** Needed when the key is not scoped to a workspace (the API then demands an anthropic-workspace-id header). */
  anthropicWorkspaceId: env("ANTHROPIC_WORKSPACE_ID", ""),
  agentModel: env("AGENT_MODEL", "claude-sonnet-5-5"),
  agentMaxUsdPerGame: Number(env("AGENT_MAX_USD_PER_GAME", "6")),
  agentMaxUsdPerDay: Number(env("AGENT_MAX_USD_PER_DAY", "25")),
  agentMaxTokensPerDecision: Number(env("AGENT_MAX_TOKENS_PER_DECISION", "1500")),
  agentDecisionTimeoutMs: Number(env("AGENT_DECISION_TIMEOUT_MS", "60000")),
  agentMaxCallsPerTurn: Number(env("AGENT_MAX_CALLS_PER_TURN", "8")),
  agentDataDir: path.resolve(env("AGENT_DATA_DIR", path.join(serverRoot, "data", "agents"))),
  /** Recorded for the record only; ownership is never granted by email. */
  ownerEmail: env("OWNER_EMAIL", "nelson.george.edward@gmail.com"),
  appName: "CGwF",
  appVersion: env("APP_VERSION", "0.1.0"),
  /** Directory the client build lands in (served as static files in production). */
  clientDist: path.resolve(env("CLIENT_DIST", path.join(serverRoot, "../client/dist"))),
  /** Drizzle SQL migrations folder. */
  migrationsDir: path.resolve(env("MIGRATIONS_DIR", path.join(serverRoot, "drizzle"))),
  /** Hand-maintained bracket data (the Game Changers list). */
  bracketDataDir: path.resolve(env("BRACKET_DATA_DIR", path.join(serverRoot, "data", "brackets"))),
} as const;

export function ensureDataDirs(): void {
  for (const dir of [config.dataDir, config.imageDir, config.bulkDir, config.uploadDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** User-Agent Scryfall asks for: descriptive, with a way to reach us. */
export const SCRYFALL_USER_AGENT = `${config.appName}/${config.appVersion} (private card table; ${config.contactEmail})`;
