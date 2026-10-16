import Anthropic from "@anthropic-ai/sdk";
import type { Usage } from "./pricing.js";

/**
 * Thin wrapper over the Anthropic SDK so the runner can be tested with a
 * scripted stand-in. One request = one decision. Sonnet 5.5 defaults to
 * adaptive thinking; effort "low" keeps decisions quick and cheap (the skill's
 * guidance for interactive tool use). No forced tool choice (400 on this
 * model): the system prompt asks for tools and the runner nudges once.
 */
export interface LlmRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens: number;
  timeoutMs: number;
}

export interface LlmResponse {
  content: Anthropic.ContentBlock[];
  usage: Usage;
  stopReason: string | null;
  stopCategory: string | null;
}

export interface Llm {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        // The system prompt (rules + effects + deck primer) is identical for every decision of a
        // game, so it is the cache breakpoint; the state and tool results follow it.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools: req.tools,
        messages: req.messages,
        output_config: { effort: "low" },
      },
      { timeout: req.timeoutMs, maxRetries: 1 },
    );
    const stopDetails = (res as { stop_details?: { category?: string | null } | null }).stop_details;
    return {
      content: res.content,
      usage: {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      stopReason: res.stop_reason,
      stopCategory: stopDetails?.category ?? null,
    };
  }
}

export type Responder = (req: LlmRequest, n: number) => Partial<LlmResponse> | Error;

/** Test double: answers from a queue or a responder function; records every request it saw. */
export class ScriptedLlm implements Llm {
  readonly model = "claude-sonnet-5-5";
  readonly requests: LlmRequest[] = [];
  private queue: Array<Partial<LlmResponse> | Error>;
  private responder: Responder | null;

  constructor(responses: Array<Partial<LlmResponse> | Error> | Responder) {
    this.queue = Array.isArray(responses) ? responses.slice() : [];
    this.responder = typeof responses === "function" ? responses : null;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const next = this.responder ? this.responder(req, this.requests.length) : this.queue.shift();
    if (!next) throw new Error("ScriptedLlm: no more responses");
    if (next instanceof Error) throw next;
    return { content: [], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, stopReason: "tool_use", stopCategory: null, ...next };
  }
}

/** Build a tool_use content block for scripted responses. */
export function toolUse(name: string, input: Record<string, unknown>, id = `tu_${Math.random().toString(36).slice(2, 10)}`): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}
export function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: null } as Anthropic.TextBlock;
}
