/**
 * A tiny Discord REST client (API v10). No gateway, no intents: the bot only creates, renames and deletes
 * voice channels and invites. Honours rate limits (per-route buckets from the X-RateLimit headers and the
 * global 429 retry_after), times out every call, and never throws past the caller's try/catch with a
 * secret in the message.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const DISCORD_API = "https://discord.com/api/v10";
export const USER_AGENT = "DiscordBot (https://cgwf.fly.dev, 1.0)";

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

export interface DiscordClientOptions {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Longest single wait for a rate limit before giving up (ms). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DiscordClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** route key -> epoch ms when the bucket opens again (remaining was 0). */
  private blockedUntil = new Map<string, number>();
  private globalUntil = 0;

  constructor(private readonly opts: DiscordClientOptions) {
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxWaitMs = opts.maxWaitMs ?? 15000;
    this.sleep = opts.sleep ?? sleepReal;
  }

  /** Route key for buckets: major parameters (channel / guild id) stay, other ids collapse. */
  static routeKey(method: string, path: string): string {
    return `${method} ${path.replace(/\/(invites|messages)\/[^/]+/g, "/$1/:id")}`;
  }

  async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const key = DiscordClient.routeKey(method, path);
    const wait = Math.max(this.globalUntil, this.blockedUntil.get(key) ?? 0) - Date.now();
    if (wait > 0) {
      if (wait > this.maxWaitMs) throw new DiscordError(`rate limited for ${Math.ceil(wait / 1000)} s`, 429);
      await this.sleep(wait);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${DISCORD_API}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.opts.token}`,
          "User-Agent": USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : null,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new DiscordError(ctrl.signal.aborted ? `timed out after ${this.timeoutMs} ms` : `network error: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(res.headers.get("x-ratelimit-reset-after") ?? "0");
    if (remaining === "0" && resetAfter > 0) this.blockedUntil.set(key, Date.now() + resetAfter * 1000);
    if (res.status === 429) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
      const ms = Math.ceil(Number(j.retry_after ?? (Number(res.headers.get("retry-after") ?? "1"))) * 1000);
      if (j.global) this.globalUntil = Date.now() + ms;
      else this.blockedUntil.set(key, Date.now() + ms);
      if (attempt >= 3 || ms > this.maxWaitMs) throw new DiscordError(`rate limited (retry after ${Math.ceil(ms / 1000)} s)`, 429);
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const j = (json ?? {}) as { message?: string; code?: number };
      throw new DiscordError(`${res.status} ${j.message ?? res.statusText}`, res.status, j.code ?? null);
    }
    return json as T;
  }
}
