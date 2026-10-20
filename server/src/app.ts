import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { openDb, type DbHandle } from "./db/index.js";
import { registerImageRoutes } from "./images.js";
import { AgentManager } from "./agents/manager.js";
import { AnthropicLlm } from "./agents/llm.js";
import { DeckAnalyzer } from "./analysis/service.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { SpellbookClient, type FetchLike } from "./analysis/spellbook.js";
import { PreconImporter } from "./library/precons.js";
import { EdhrecClient, type FetchLike as EdhrecFetch } from "./library/edhrec/client.js";
import { EngineCoverageChecker, type CoverageChecker } from "./library/edhrec/coverage.js";
import { EdhrecImporter } from "./library/edhrec/importer.js";
import { LibraryCoverage } from "./library/coverage.js";
import { LibraryService } from "./library/service.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerDeckRoutes } from "./routes/decks.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { registerDeckOptionRoutes } from "./routes/deckOptions.js";
import { registerDeckStatsRoutes } from "./routes/deckStats.js";
import { DeckBrackets } from "./stats/brackets.js";
import { GameResults } from "./stats/results.js";
import { DiscordVoice, type VoiceConfig } from "./discord/voice.js";
import { DecisionRecorder } from "./coach/snapshots.js";
import type { FetchLike as DiscordFetch } from "./discord/client.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSinglesRoutes } from "./routes/singles.js";
import { registerDoctorRoutes } from "./routes/doctor.js";
import { DeckDoctor } from "./analysis/doctor/service.js";
import { AnthropicDoctorLlm, DoctorAi, type DoctorLlm } from "./analysis/doctor/ai.js";
import { SinglesClient } from "./singles/client.js";
import { registerSocialRoutes } from "./routes/social.js";
import { presence } from "./social/presence.js";
import { SocialService } from "./social/service.js";
import { SubmissionService } from "./social/submissions.js";
import { RoomManager } from "./rooms/live.js";
import { EngineClient } from "./engine/client.js";
import { Ingestor } from "./scryfall/ingest.js";
import { NameIndex } from "./search/index.js";

export interface AppContext {
  app: FastifyInstance;
  handle: DbHandle;
  index: NameIndex;
  ingestor: Ingestor;
  roomsManager: RoomManager;
  analyzer: DeckAnalyzer;
  library: LibraryService;
  precons: PreconImporter;
  edhrec: EdhrecImporter;
  doctorAi: DoctorAi;
  libraryCoverage: LibraryCoverage;
  agents: AgentManager;
  social: SocialService;
  submissions: SubmissionService;
  singles: SinglesClient;
  /** Rules engine control socket (enabled only when ENGINE_URL is set). */
  engine: EngineClient;
}

export interface BuildOptions {
  dbFile?: string;
  logger?: boolean | "plain";
  /** Tests inject a fake Commander Spellbook; production uses global fetch. */
  spellbookFetch?: FetchLike;
  /** Same for MTGJSON (precon import). */
  mtgjsonFetch?: FetchLike;
  /** EDHREC import: tests inject fixture JSON, a temp cache dir, no throttle and a fake coverage check. */
  edhrecFetch?: EdhrecFetch;
  edhrecCacheDir?: string;
  edhrecGapMs?: number;
  edhrecCoverage?: CoverageChecker | null;
  /** Deck Doctor AI: tests inject a scripted model, the flag and small caps. */
  doctorLlm?: DoctorLlm | null;
  doctorAiEnabled?: boolean;
  doctorCaps?: Partial<{ perRun: number; perDay: number; maxTokens: number; maxCalls: number; effort: string }>;
  /** Phase 10: tests inject a fake Singles site (and its URL/token); production reads config. */
  singlesFetch?: FetchLike;
  singlesOptions?: Partial<import("./singles/client.js").SinglesClientOptions>;
  /** Phase 7: tests pass a ScriptedLlm (or null for a dry run) and force the feature on. */
  agentLlm?: import("./agents/llm.js").Llm | null;
  agentsEnabled?: boolean;
  /** Rules engine: tests point this at a fake engine WebSocket server; production reads config. */
  engineUrl?: string;
  engineToken?: string;
  /**
   * Legacy casual (classic, no-rules) tables can no longer be created (owner, 2026-10-18); existing ones
   * still load. Only the classic table's own tests turn creation back on. Deliberately not an env var.
   */
  casualRooms?: boolean;
  /** Hourly auto-close of tables idle for TABLE_IDLE_CLOSE_HOURS (48 h). Tests turn it off. */
  idleSweep?: boolean;
  /** Discord voice: tests pass a config (or null = off) and a fake Discord API; production reads config. */
  discord?: VoiceConfig | null;
  discordFetch?: DiscordFetch;
  discordClientOpts?: { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number };
  /** Run the boot check + orphan sweep (default true; tests call verify() themselves). */
  discordBoot?: boolean;
}

/** Build the Fastify app with every route wired. Listening is the caller's job. */
export async function buildApp(opts: BuildOptions = {}): Promise<AppContext> {
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : opts.logger === "plain" || config.isProduction
          ? true
          : { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } },
    trustProxy: true,
    bodyLimit: 1_048_576,
    // One line per request is too chatty for Fly logs; errors are still logged.
    disableRequestLogging: true,
  });

  const handle = openDb(opts.dbFile);
  const index = new NameIndex(handle);
  index.build();
  const ingestor = new Ingestor(handle, app.log);
  ingestor.onComplete(() => index.build());

  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  // One WebSocket per connected client; the largest frame is a token with a full printing.
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const engine = new EngineClient({ url: opts.engineUrl ?? config.engineUrl, token: opts.engineToken ?? config.engineToken, log: app.log });
  const roomsManager = new RoomManager(handle, app.log, engine.enabled ? { client: engine, index } : null);
  engine.start();
  const spellbook = new SpellbookClient(app.log, opts.spellbookFetch);
  const analyzer = new DeckAnalyzer(handle, spellbook, app.log);

  const library = new LibraryService(handle, analyzer);
  const precons = new PreconImporter(handle, index, library, app.log, opts.mtgjsonFetch);
  const edhrecClient = new EdhrecClient({ log: app.log, ...(opts.edhrecFetch ? { fetchImpl: opts.edhrecFetch } : {}), ...(opts.edhrecCacheDir ? { cacheDir: opts.edhrecCacheDir } : {}), ...(opts.edhrecGapMs !== undefined ? { gapMs: opts.edhrecGapMs, backoffMs: [0] } : {}) });

  const llm = opts.agentLlm !== undefined ? opts.agentLlm : config.anthropicApiKey ? new AnthropicLlm(config.agentModel, config.anthropicApiKey, config.anthropicWorkspaceId) : null;
  const agents = new AgentManager({ handle, library, analyzer, log: app.log, llm, enabled: opts.agentsEnabled });

  const social = new SocialService(handle, roomsManager, presence);
  const submissions = new SubmissionService(handle, library, analyzer, social);
  const singles = new SinglesClient({
    baseUrl: config.singlesApiUrl,
    token: config.singlesApiToken,
    timeoutMs: config.singlesTimeoutMs,
    fetch: opts.singlesFetch,
    log: app.log,
    ...(opts.singlesOptions ?? {}),
  });

  registerCardRoutes(app, { handle, index, ingestor });
  registerSocialRoutes(app, { handle, social, submissions, roomsManager });
  registerAnalysisRoutes(app, { handle, analyzer });
  const coverageChecker = opts.edhrecCoverage !== undefined ? opts.edhrecCoverage : new EngineCoverageChecker(engine);
  const edhrec = new EdhrecImporter(handle, index, library, analyzer, edhrecClient, coverageChecker, app.log);
  // Library-wide Forge check (any source); precon imports run it for the decks they add.
  const libraryCoverage = new LibraryCoverage(handle, library, coverageChecker, app.log);
  precons.setCoverage(libraryCoverage);
  const doctor = new DeckDoctor({ handle, index, analyzer, edhrec: edhrecClient, singles, log: app.log });
  const doctorLlm = opts.doctorLlm !== undefined ? opts.doctorLlm : config.anthropicApiKey ? new AnthropicDoctorLlm(config.doctorModel, config.anthropicApiKey, config.anthropicWorkspaceId) : null;
  const doctorAi = new DoctorAi({ handle, index, doctor, llm: doctorLlm, enabled: opts.doctorAiEnabled, log: app.log, caps: opts.doctorCaps });
  registerDoctorRoutes(app, { handle, doctor, ai: doctorAi });
  registerLibraryRoutes(app, { handle, library, precons, edhrec, coverage: libraryCoverage });
  registerStatsRoutes(app, { handle, analyzer, library });
  registerAgentRoutes(app, { handle, agents, roomsManager });
  registerAdminRoutes(app, { handle, roomsManager, presence });
  registerImageRoutes(app, handle);
  registerMeRoutes(app, handle);
  registerAuthRoutes(app, handle);
  registerDeckRoutes(app, { handle, index });
  roomsManager.casualRooms = opts.casualRooms === true;
  const deckBrackets = new DeckBrackets(handle, analyzer);
  roomsManager.setResults(new GameResults(handle, deckBrackets));
  if (opts.idleSweep !== false) roomsManager.startIdleSweep();
  // Discord voice: one temporary voice channel per table (all three secrets set), else manual links only
  const dEnv = { token: config.discordBotToken, guildId: config.discordGuildId, categoryId: config.discordCategoryId };
  const dSet = [dEnv.token, dEnv.guildId, dEnv.categoryId].filter(Boolean).length;
  const voice = new DiscordVoice(handle, app.log, opts.discord !== undefined ? opts.discord : dSet === 3 ? dEnv : null, opts.discordFetch, opts.discordClientOpts);
  if (opts.discord === undefined && dSet > 0 && dSet < 3) {
    const missing = (["DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_CATEGORY_ID"] as const).filter((k, i) => ![dEnv.token, dEnv.guildId, dEnv.categoryId][i]);
    voice.status = { state: "error", botName: null, categoryName: null, problem: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set (fly secrets set ...).` };
  }
  roomsManager.setVoice(voice);
  // AI Coach M1: decision snapshots (own view only), kept SNAPSHOT_RETENTION_DAYS (90)
  const decisions = new DecisionRecorder(handle, app.log);
  roomsManager.setDecisions(decisions);
  if (opts.idleSweep !== false) {
    const clean = () => {
      try {
        const n = decisions.cleanup();
        if (n) app.log.info({ deleted: n }, "old decision snapshots removed");
      } catch (err) {
        app.log.warn({ err: (err as Error).message }, "decision snapshot cleanup failed");
      }
    };
    const daily = setInterval(clean, 24 * 3600_000);
    daily.unref();
    setTimeout(clean, 90_000).unref();
    app.addHook("onClose", async () => clearInterval(daily));
  }
  if (opts.discordBoot !== false && voice.status.state === "checking") {
    void voice.verify().then(() => voice.sweepOrphans()).catch((err: unknown) => app.log.warn({ err: (err as Error).message }, "discord boot sweep failed"));
    const sweep = setInterval(() => void voice.sweepOrphans().catch(() => undefined), 60 * 60 * 1000);
    sweep.unref();
    app.addHook("onClose", async () => clearInterval(sweep));
  }
  registerRoomRoutes(app, { handle, roomsManager, agents });
  registerDeckOptionRoutes(app, { handle, brackets: deckBrackets });
  registerDeckStatsRoutes(app, { handle });
  registerSettingsRoutes(app, { handle, onSettingsChanged: (userId) => roomsManager.userChanged(userId) });
  registerSinglesRoutes(app, { handle, singles, library });

  // In production the server also hosts the built client (a static SPA).
  const indexHtml = path.join(config.clientDist, "index.html");
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: config.clientDist,
      prefix: "/",
      wildcard: false,
      setHeaders(reply, filePath) {
        // Vite fingerprints everything under /assets, so those can be cached forever.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          reply.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          reply.header("Cache-Control", "no-cache");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/img/")) {
        return reply.type("text/html").header("Cache-Control", "no-cache").send(fs.readFileSync(indexHtml));
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  app.addHook("onClose", async () => {
    agents.close();
    roomsManager.close();
    engine.close();
    handle.close();
  });

  return { app, handle, index, ingestor, roomsManager, analyzer, library, precons, edhrec, libraryCoverage, doctorAi, agents, social, submissions, singles, engine };
}
