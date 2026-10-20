import Anthropic from "@anthropic-ai/sdk";

/**
 * The coach's model call, behind an interface so tests use a scripted stand-in (no network in CI).
 *
 * Model: Claude Opus 5.5 (`claude-opus-5-5`), the strongest generally priced Opus-class model and the
 * claude-api skill's default: reviewing a whole game (sequencing, combat math, threat assessment) is
 * exactly the deep-reasoning work it is for, and a report is a handful of calls, so the per-token price
 * matters less than quality. Adaptive thinking (always on for this model) at effort "high" for the
 * report, "medium" for follow-ups. Server-side refusal fallbacks (`fallbacks: "default"`, beta
 * `server-side-fallback-2026-07-01`) re-run a policy decline on Anthropic's recommended fallback model.
 */
export interface CoachUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface CoachRequest {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Structured output: the final text must be JSON matching this schema. */
  jsonSchema?: Record<string, unknown>;
}

export interface CoachResponse {
  content: Anthropic.ContentBlock[];
  usage: CoachUsage;
  stopReason: string | null;
  stopCategory: string | null;
}

export interface CoachLlm {
  readonly model: string;
  create(req: CoachRequest): Promise<CoachResponse>;
}

/** USD per million tokens for Claude Opus 5.5 (skill table): input $4, output $20, cache write 1.25x, cache read $0.20. */
export const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};

export function costOf(model: string, u: CoachUsage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  return (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_creation_input_tokens * p.cacheWrite + u.cache_read_input_tokens * p.cacheRead) / 1_000_000;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Sum every attempt (a refusal fallback reports each attempt in usage.iterations; top-level covers only the last). */
export function usageOf(raw: Record<string, unknown> | undefined): CoachUsage {
  const u = raw ?? {};
  const iterations = Array.isArray(u.iterations) ? (u.iterations as Array<Record<string, unknown>>) : null;
  const rows = iterations && iterations.length ? iterations : [u];
  const out: CoachUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const r of rows) {
    out.input_tokens += num(r.input_tokens);
    out.output_tokens += num(r.output_tokens);
    out.cache_read_input_tokens += num(r.cache_read_input_tokens);
    out.cache_creation_input_tokens += num(r.cache_creation_input_tokens);
  }
  return out;
}

export class AnthropicCoachLlm implements CoachLlm {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    workspaceId = "",
  ) {
    this.client = new Anthropic({ apiKey, timeout: 10 * 60 * 1000, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  async create(req: CoachRequest): Promise<CoachResponse> {
    const params = {
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      thinking: { type: "adaptive" },
      output_config: { effort: req.effort, ...(req.jsonSchema ? { format: { type: "json_schema", schema: req.jsonSchema } } : {}) },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    // The SDK version in use may not type `fallbacks` yet; the request shape follows the claude-api skill.
    const res = (await this.client.beta.messages.create(params as never)) as unknown as {
      content: Anthropic.ContentBlock[];
      usage: Record<string, unknown>;
      stop_reason: string | null;
      stop_details?: { category?: string | null } | null;
    };
    return { content: res.content, usage: usageOf(res.usage), stopReason: res.stop_reason, stopCategory: res.stop_details?.category ?? null };
  }
}

/** Tests: hands out queued responses in order and records every request. */
export class ScriptedCoachLlm implements CoachLlm {
  readonly requests: CoachRequest[] = [];
  constructor(
    readonly script: Array<CoachResponse | ((req: CoachRequest) => CoachResponse)>,
    readonly model = "claude-opus-5-5",
  ) {}
  async create(req: CoachRequest): Promise<CoachResponse> {
    this.requests.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("scripted coach model ran out of responses");
    return typeof next === "function" ? next(req) : next;
  }
}
