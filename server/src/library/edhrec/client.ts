import fs from "node:fs";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../../config.js";

/**
 * EDHREC's public JSON (https://json.edhrec.com/pages/<path>.json), politely:
 *  - at most one request per second, one at a time;
 *  - a descriptive User-Agent with the contact address from config;
 *  - every answer cached on disk under DATA_DIR/edhrec-cache, so a rerun costs nothing
 *    (`refresh` ignores the cache; 403/404 answers are cached as "missing" too);
 *  - 429 and 5xx back off (Retry-After when given, else 5, 15, 45 s) and retry three times;
 *    403 means the path does not exist (EDHREC's CDN answers 403 for unknown keys) and is not retried.
 * Data is EDHREC's; the library pages credit it with a link (see CLAUDE.md, EDHREC decks).
 */
export const EDHREC_BASE = "https://json.edhrec.com/pages/";
export const EDHREC_USER_AGENT = `${config.appName}/${config.appVersion} (private card table, deck library import; ${config.contactEmail})`;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EdhrecClientOptions {
  cacheDir?: string;
  fetchImpl?: FetchLike;
  log?: FastifyBaseLogger | null;
  /** Minimum gap between requests (tests use 0). */
  gapMs?: number;
  /** Back-off schedule for 429/5xx (tests use [0]). */
  backoffMs?: number[];
}

export class EdhrecError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EdhrecError";
  }
}

export class EdhrecClient {
  readonly cacheDir: string;
  private readonly fetchImpl: FetchLike;
  private readonly gapMs: number;
  private readonly backoff: number[];
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  requests = 0;
  cacheHits = 0;

  constructor(private readonly opts: EdhrecClientOptions = {}) {
    this.cacheDir = opts.cacheDir ?? path.join(config.dataDir, "edhrec-cache");
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.gapMs = opts.gapMs ?? 1000;
    this.backoff = opts.backoffMs ?? [5000, 15000, 45000];
  }

  private cacheFile(p: string): string {
    const safe = p.replace(/[^a-z0-9/_-]/gi, "_").replace(/\//g, "__");
    return path.join(this.cacheDir, `${safe}.json`);
  }

  /**
   * The parsed JSON for `p` (no leading slash, no .json), or null when EDHREC has no such page.
   * `maxAgeMs`: a cached answer older than this is fetched again (the Deck Doctor uses 7 days; the import
   * keeps answers forever). `failFast`: one attempt, no back-off waits (a player is waiting); when that
   * attempt fails a stale cached answer is returned instead, and only with no cache does it throw.
   */
  async get(p: string, opts: { refresh?: boolean; maxAgeMs?: number; failFast?: boolean } = {}): Promise<unknown | null> {
    const file = this.cacheFile(p);
    let stale: { missing?: boolean; body?: unknown } | null = null;
    if (!opts.refresh && fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { missing?: boolean; status?: number; body?: unknown; fetchedAt?: string };
      const age = cached.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : 0;
      if (opts.maxAgeMs === undefined || age <= opts.maxAgeMs) {
        this.cacheHits++;
        return cached.missing ? null : (cached.body ?? null);
      }
      stale = cached;
    }
    let body: unknown | null;
    try {
      body = await this.fetchWithRetry(p, opts.failFast ? 0 : this.backoff.length);
    } catch (err) {
      if (stale) {
        this.cacheHits++;
        return stale.missing ? null : (stale.body ?? null);
      }
      throw err;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body === null ? { missing: true, fetchedAt: new Date().toISOString() } : { body, fetchedAt: new Date().toISOString() }));
    return body;
  }

  private slot(): Promise<void> {
    const turn = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = turn.catch(() => undefined);
    return turn;
  }

  private async fetchWithRetry(p: string, retries = this.backoff.length): Promise<unknown | null> {
    const url = `${EDHREC_BASE}${p}.json`;
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { "User-Agent": EDHREC_USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        if (attempt >= retries) throw new EdhrecError(`EDHREC unreachable for ${p}: ${err instanceof Error ? err.message : String(err)}`, 0);
        await this.sleep(this.backoff[attempt]!);
        continue;
      }
      if (res.ok) return (await res.json()) as unknown;
      if (res.status === 403 || res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) throw new EdhrecError(`EDHREC answered ${res.status} for ${p} after ${attempt + 1} tries`, res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(300, retryAfter) * 1000 : this.backoff[attempt]!;
        this.opts.log?.warn({ status: res.status, path: p, wait }, "EDHREC asked us to slow down");
        await this.sleep(wait);
        continue;
      }
      throw new EdhrecError(`EDHREC answered ${res.status} for ${p}`, res.status);
    }
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}
