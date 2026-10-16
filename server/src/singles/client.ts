import type { FastifyBaseLogger } from "fastify";
import type { SinglesAvailabilityResponse, SinglesStoresResponse } from "@cgwf/shared";

/**
 * Client for the Singles site's service API (vegas-mtg `/api/v1/*`), built so
 * a Singles outage can never slow CGwF down:
 *
 * - every call has a hard timeout (default 4 s);
 * - answers are cached in memory for 15 minutes, keyed by the exact set of
 *   oracle ids asked for (deck pages ask for the whole deck at once);
 * - concurrent callers asking for the same key share one request;
 * - a circuit breaker opens after three consecutive failures and answers
 *   "unavailable" instantly for 60 s, then lets one request through to probe;
 * - while the breaker is open, or on a failed call, a cached answer up to
 *   six times the TTL old is served instead (marked `stale`).
 *
 * The client reads only: CGwF links out to stores and never sells anything.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface SinglesClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  cacheTtlMs?: number | undefined;
  /** Consecutive failures that open the breaker. */
  breakerFailures?: number | undefined;
  breakerCooldownMs?: number | undefined;
  /** Most ids the Singles API accepts per request; larger sets are chunked. */
  batchSize?: number | undefined;
  maxCacheEntries?: number | undefined;
  now?: (() => number) | undefined;
  log?: FastifyBaseLogger | null | undefined;
}

export type SinglesResult<T> =
  | { status: "ok"; data: T; fetchedAt: string; cached: boolean; stale: boolean }
  | { status: "unavailable"; reason: string }
  | { status: "unconfigured"; reason: string };

export interface SinglesClientStatus {
  configured: boolean;
  baseUrl: string;
  breaker: { state: "closed" | "open" | "half-open"; failures: number; openUntil: string | null };
  cacheEntries: number;
  requests: number;
  failures: number;
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export const DEFAULT_TIMEOUT_MS = 4_000;
export const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_BREAKER_FAILURES = 3;
export const DEFAULT_BREAKER_COOLDOWN_MS = 60 * 1000;
export const DEFAULT_BATCH_SIZE = 400;
const STALE_FACTOR = 6;

class SinglesError extends Error {
  constructor(
    message: string,
    /** Whether this failure should count toward opening the breaker. */
    readonly countsAsFailure: boolean,
  ) {
    super(message);
  }
}

export class SinglesClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly breakerFailures: number;
  private readonly breakerCooldownMs: number;
  private readonly batchSize: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly log: FastifyBaseLogger | null;

  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private consecutiveFailures = 0;
  private openUntil = 0;
  private probing = false;
  private requestCount = 0;
  private failureCount = 0;

  constructor(opts: SinglesClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.breakerFailures = opts.breakerFailures ?? DEFAULT_BREAKER_FAILURES;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxCacheEntries = opts.maxCacheEntries ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? null;
  }

  get configured(): boolean {
    return this.baseUrl !== "" && this.token !== "";
  }

  status(): SinglesClientStatus {
    const now = this.now();
    const state = this.openUntil > now ? "open" : this.consecutiveFailures >= this.breakerFailures ? "half-open" : "closed";
    return {
      configured: this.configured,
      baseUrl: this.baseUrl,
      breaker: { state, failures: this.consecutiveFailures, openUntil: this.openUntil > now ? new Date(this.openUntil).toISOString() : null },
      cacheEntries: this.cache.size,
      requests: this.requestCount,
      failures: this.failureCount,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** In-stock listings for a set of oracle ids. Every requested id is present in `data.cards`. */
  async availability(oracleIds: string[]): Promise<SinglesResult<SinglesAvailabilityResponse>> {
    const ids = [...new Set(oracleIds.map((s) => s.trim().toLowerCase()).filter(Boolean))].sort();
    if (ids.length === 0) {
      return { status: "ok", data: { dataAsOf: null, source: "vegas-mtg", requested: 0, cards: {} }, fetchedAt: new Date(this.now()).toISOString(), cached: false, stale: false };
    }
    return this.cached(`availability:${ids.join(",")}`, () => this.fetchAvailability(ids));
  }

  /** Active stores on the Singles site. */
  async stores(): Promise<SinglesResult<SinglesStoresResponse>> {
    return this.cached("stores", () => this.request<SinglesStoresResponse>("GET", "/api/v1/stores"));
  }

  /* ---------------------------------------------------------------- */

  private async fetchAvailability(ids: string[]): Promise<SinglesAvailabilityResponse> {
    const merged: SinglesAvailabilityResponse = { dataAsOf: null, source: "vegas-mtg", requested: ids.length, cards: {} };
    for (let i = 0; i < ids.length; i += this.batchSize) {
      const chunk = ids.slice(i, i + this.batchSize);
      const part = await this.request<SinglesAvailabilityResponse>("POST", "/api/v1/availability", { oracleIds: chunk });
      if (part.source) merged.source = part.source;
      if (part.dataAsOf && (!merged.dataAsOf || part.dataAsOf > merged.dataAsOf)) merged.dataAsOf = part.dataAsOf;
      for (const [k, v] of Object.entries(part.cards ?? {})) merged.cards[k.toLowerCase()] = { oracleId: k.toLowerCase(), name: v.name ?? "", listings: Array.isArray(v.listings) ? v.listings : [] };
    }
    for (const id of ids) if (!merged.cards[id]) merged.cards[id] = { oracleId: id, name: "", listings: [] };
    return merged;
  }

  /** Cache + in-flight dedupe + breaker around one fetch. */
  private async cached<T>(key: string, load: () => Promise<T>): Promise<SinglesResult<T>> {
    if (!this.configured) return { status: "unconfigured", reason: "SINGLES_API_URL and SINGLES_API_TOKEN are not set" };
    const now = this.now();
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && now - hit.fetchedAt < this.ttlMs) {
      return { status: "ok", data: hit.data, fetchedAt: new Date(hit.fetchedAt).toISOString(), cached: true, stale: false };
    }
    const stale = (reason: string): SinglesResult<T> => {
      if (hit && now - hit.fetchedAt < this.ttlMs * STALE_FACTOR) {
        return { status: "ok", data: hit.data, fetchedAt: new Date(hit.fetchedAt).toISOString(), cached: true, stale: true };
      }
      return { status: "unavailable", reason };
    };

    if (this.openUntil > now) return stale("local store data is temporarily unavailable (circuit open)");
    if (this.consecutiveFailures >= this.breakerFailures && this.probing) {
      // Half-open: one probe at a time; everyone else gets the quick answer.
      return stale("local store data is temporarily unavailable (probing)");
    }

    let promise = this.inFlight.get(key) as Promise<T> | undefined;
    if (!promise) {
      promise = load();
      this.inFlight.set(key, promise);
      if (this.consecutiveFailures >= this.breakerFailures) this.probing = true;
    }
    try {
      const data = await promise;
      this.consecutiveFailures = 0;
      this.probing = false;
      const fetchedAt = this.now();
      this.cache.set(key, { data, fetchedAt });
      this.trimCache();
      return { status: "ok", data, fetchedAt: new Date(fetchedAt).toISOString(), cached: false, stale: false };
    } catch (err) {
      const e = err instanceof SinglesError ? err : new SinglesError(err instanceof Error ? err.message : String(err), true);
      this.probing = false;
      if (e.countsAsFailure) {
        this.failureCount++;
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.breakerFailures) {
          this.openUntil = this.now() + this.breakerCooldownMs;
          this.log?.warn({ failures: this.consecutiveFailures, reason: e.message }, "singles: circuit opened");
        } else {
          this.log?.warn({ reason: e.message }, "singles: request failed");
        }
      } else {
        this.log?.warn({ reason: e.message }, "singles: request rejected");
      }
      return stale(e.message);
    } finally {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    }
  }

  private trimCache(): void {
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    this.requestCount++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "x-service-token": this.token,
          accept: "application/json",
          "user-agent": "CGwF/0.1 (local stores bridge)",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError" || controller.signal.aborted;
      throw new SinglesError(aborted ? `singles timeout after ${this.timeoutMs} ms` : `singles network error: ${(err as Error)?.message ?? err}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new SinglesError("singles rejected the service token (check SINGLES_API_TOKEN)", true);
    if (res.status === 429) throw new SinglesError("singles rate limit reached", true);
    if (res.status >= 500) throw new SinglesError(`singles answered ${res.status}`, true);
    if (!res.ok) throw new SinglesError(`singles answered ${res.status}`, false);
    try {
      return (await res.json()) as T;
    } catch {
      throw new SinglesError("singles returned invalid JSON", true);
    }
  }
}
