import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import type { DbHandle } from "../db/index.js";
import { cards, coachFollowups, coachReports } from "../db/schema.js";
import type { NameIndex } from "../search/index.js";
import { normalizeName } from "@cgwf/shared";
import type { DecisionRecorder } from "./snapshots.js";
import { buildCoachGame, type CoachGame } from "./context.js";
import { costOf, type CoachLlm, type CoachUsage } from "./llm.js";

export interface CoachLimits {
  maxUsdPerReport: number;
  maxUsdPerDay: number;
  maxTokensPerReport: number;
}

/** The report the model writes (structured output). */
export interface CoachReport {
  summary: string;
  turningPoints: Array<{ round: number; turn: number; title: string; had: string; chose: string; betterLine: string; why: string; theme: string; cards: string[] }>;
  habits: string[];
  hiddenInfoNote: string;
}

export const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "turningPoints", "habits", "hiddenInfoNote"],
  properties: {
    summary: { type: "string", description: "Two to four sentences: how the game went for the player and why." },
    turningPoints: {
      type: "array",
      description: "Three to six turning points, in game order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["round", "turn", "title", "had", "chose", "betterLine", "why", "theme", "cards"],
        properties: {
          round: { type: "integer", description: "Round number (0 if unknown)." },
          turn: { type: "integer", description: "Game turn number (0 if unknown)." },
          title: { type: "string" },
          had: { type: "string", description: "What the player had: relevant cards in hand, mana, board, life." },
          chose: { type: "string", description: "What the player did." },
          betterLine: { type: "string", description: "The stronger line, or 'This was the right play' when it was." },
          why: { type: "string" },
          theme: { type: "string", enum: ["sequencing", "mana", "combat", "threat assessment", "holding interaction", "mulligan", "deck plan", "other"] },
          cards: { type: "array", items: { type: "string" }, description: "Exact names of the cards involved." },
        },
      },
    },
    habits: { type: "array", items: { type: "string" }, description: "Exactly three habits to practise." },
    hiddenInfoNote: { type: "string", description: "What the review could not know (opponents' hands, libraries) and how that limits it." },
  },
};

const CARD_TOOL: Anthropic.Tool = {
  name: "card_text",
  description: "Look up a Magic card's exact rules (oracle) text, mana cost and type line by its name. Use it whenever a card's exact wording matters to your analysis.",
  input_schema: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", description: "The card's English name." } } },
  strict: true,
} as Anthropic.Tool;

const SYSTEM = `You are an experienced Commander (EDH) coach for Magic: The Gathering. You review one finished game played on CGwF, where the Forge rules engine enforced every rule, and help one player see where better plays were available.

What you can know: the player's decklist and primer, the public game log, the opponents' cards that became public, and (in a full review) every decision the player made with exactly what they could see then: their own hand, every public zone, the options offered and their choice. You never see an opponent's hand or any library. Never claim what an opponent held or what a library contained unless it became public; phrase such lines conditionally ("if Blair still held a counterspell..."). Do not invent events that are not in the record.

How to review: identify the 3 to 6 turning points that most changed the outcome for the player. For each, say what the player had, what they chose, the stronger line (or that their play was right) and why, drawing on sequencing, mana use, combat math, threat assessment, holding interaction, mulligans and the deck's own plan. Then give three habits to practise. Be concrete, cite rounds and turns, use exact card names, and be honest: if the player played well and lost to variance, say so. Use the card_text tool when exact card wording matters. Write for a capable player: plain language, no filler.`;

const FOLLOWUP_SYSTEM = `${SYSTEM}

You already wrote a report on this game (below). Now answer one follow-up question from the player about the game, in plain prose (a few short paragraphs at most), under the same rules about hidden information.`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsage(): CoachUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function add(a: CoachUsage, b: CoachUsage): CoachUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

function totalTokens(u: CoachUsage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

export class CoachError extends Error {}

/**
 * AI Coach (owner only). One report per game and player, generated in the background, cached; one
 * follow-up at a time. Spend: every call's usage is recorded on the report / follow-up row; a report
 * stops ("capped") when it passes COACH_MAX_USD_PER_REPORT or COACH_MAX_TOKENS_PER_REPORT, and nothing
 * new starts once today's coach spend (reports + follow-ups, UTC day) reaches COACH_MAX_USD_PER_DAY
 * (separate from the agents' daily cap).
 */
export class CoachService {
  private running = new Set<Promise<void>>();

  constructor(
    private readonly handle: DbHandle,
    private readonly log: FastifyBaseLogger,
    private readonly llm: CoachLlm | null,
    private readonly decisions: DecisionRecorder | null,
    private readonly index: NameIndex,
    readonly limits: CoachLimits,
  ) {}

  get enabled(): boolean {
    return this.llm !== null;
  }

  get model(): string | null {
    return this.llm?.model ?? null;
  }

  /** For tests: wait for background work. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private background(job: () => Promise<void>): void {
    const p = job().catch((err: unknown) => this.log.error({ err }, "coach job failed"));
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  spentToday(): number {
    const start = `${today()}T00:00:00.000Z`;
    const reports = this.handle.db.select({ c: coachReports.costUsd, u: coachReports.updatedAt }).from(coachReports).where(gte(coachReports.updatedAt, start)).all();
    const follow = this.handle.db.select({ c: coachFollowups.costUsd }).from(coachFollowups).where(gte(coachFollowups.createdAt, start)).all();
    return reports.reduce((n, r) => n + r.c, 0) + follow.reduce((n, r) => n + r.c, 0);
  }

  report(roomId: string, userId: string) {
    const row = this.handle.db.select().from(coachReports).where(and(eq(coachReports.roomId, roomId), eq(coachReports.userId, userId))).get();
    if (!row) return null;
    const followups = this.handle.db.select().from(coachFollowups).where(eq(coachFollowups.reportId, row.id)).orderBy(coachFollowups.id).all();
    return { ...row, followups };
  }

  /** Start (or return) the report for one game. Cached: a finished report is never regenerated; an errored one is. */
  start(roomId: string, userId: string): { id: string; status: string } {
    if (!this.llm) throw new CoachError("the AI coach is not enabled");
    const existing = this.handle.db.select().from(coachReports).where(and(eq(coachReports.roomId, roomId), eq(coachReports.userId, userId))).get();
    if (existing && existing.status !== "error") return { id: existing.id, status: existing.status };
    if (this.spentToday() >= this.limits.maxUsdPerDay) throw new CoachError(`today's AI coach budget ($${this.limits.maxUsdPerDay}) is used up; try again tomorrow`);
    const game = buildCoachGame(this.handle, this.decisions, roomId, userId);
    if (!game) throw new CoachError("that game has no recorded result for you to review");
    if (existing) this.handle.db.delete(coachReports).where(eq(coachReports.id, existing.id)).run();
    const id = randomUUID();
    const now = new Date().toISOString();
    this.handle.db
      .insert(coachReports)
      .values({ id, roomId, roomCode: game.code, userId, kind: game.kind, status: "running", model: this.llm.model, report: null, error: null, createdAt: now, updatedAt: now })
      .run();
    this.background(() => this.generate(id, game));
    return { id, status: "running" };
  }

  /** Oracle text for the card_text tool. */
  cardText(name: string): string {
    const entry = this.index.exact(normalizeName(name)) ?? this.index.search(name, { limit: 1 })[0] ?? null;
    if (!entry) return `No card named "${name}" was found.`;
    const row = this.handle.db.select().from(cards).where(eq(cards.id, entry.id)).get();
    if (!row) return `No card named "${name}" was found.`;
    return `${row.name} ${row.manaCost}\n${row.typeLine}\n${row.oracleText}${row.power ? `\n${row.power}/${row.toughness}` : ""}${row.loyalty ? `\nLoyalty ${row.loyalty}` : ""}`;
  }

  private contextBlocks(game: CoachGame): Anthropic.TextBlockParam[] {
    const intro =
      game.kind === "full"
        ? `Review this game for ${game.playerName} (seat ${game.seat}). They ${game.won ? "won" : `finished in place ${game.place ?? "?"} of ${game.playerCount}`}.`
        : `Review this game for ${game.playerName} (seat ${game.seat}). LIGHT REVIEW: this game has no decision record, so you only have the public log and the player's raw answers; say clearly where that limits you. They ${game.won ? "won" : `finished in place ${game.place ?? "?"} of ${game.playerCount}`}.`;
    // the big record is cached: the tool loop and every follow-up re-read it at the cache price
    return [{ type: "text", text: `${intro}\n\n${game.text}`, cache_control: { type: "ephemeral" } }];
  }

  /** The tool loop. Records usage after every call; stops at the per-report caps. */
  private async loop(
    req: { system: string; first: Anthropic.ContentBlockParam[]; json: boolean; effort: "medium" | "high"; maxCalls: number },
    onUsage: (u: CoachUsage, calls: number) => void,
  ): Promise<{ text: string; capped: string | null; refusal: string | null }> {
    const llm = this.llm!;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.first }];
    let usage = emptyUsage();
    for (let call = 1; call <= req.maxCalls; call++) {
      const res = await llm.create({
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages,
        tools: [CARD_TOOL],
        maxTokens: 16000,
        effort: req.effort,
        ...(req.json ? { jsonSchema: REPORT_SCHEMA } : {}),
      });
      usage = add(usage, res.usage);
      onUsage(usage, call);
      if (res.stopReason === "refusal") return { text: "", capped: null, refusal: res.stopCategory ?? "declined" };
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const cost = costOf(llm.model, usage);
      const over = cost >= this.limits.maxUsdPerReport ? `spend cap ($${this.limits.maxUsdPerReport}) reached` : totalTokens(usage) >= this.limits.maxTokensPerReport ? `token cap (${this.limits.maxTokensPerReport}) reached` : null;
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (res.stopReason !== "tool_use" || !toolUses.length) return { text, capped: null, refusal: null };
      if (over) return { text, capped: over, refusal: null };
      messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
      messages.push({
        role: "user",
        content: toolUses.map((t) => {
          const name = typeof (t.input as { name?: unknown })?.name === "string" ? (t.input as { name: string }).name : "";
          return { type: "tool_result" as const, tool_use_id: t.id, content: name ? this.cardText(name) : "Give a card name.", ...(name ? {} : { is_error: true }) };
        }),
      });
    }
    return { text: "", capped: `stopped after ${req.maxCalls} model calls`, refusal: null };
  }

  private save(id: string, u: CoachUsage, calls: number, extra: Partial<typeof coachReports.$inferInsert> = {}): void {
    this.handle.db
      .update(coachReports)
      .set({
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens,
        cacheWriteTokens: u.cache_creation_input_tokens,
        costUsd: costOf(this.llm!.model, u),
        calls,
        updatedAt: new Date().toISOString(),
        ...extra,
      })
      .where(eq(coachReports.id, id))
      .run();
  }

  private async generate(id: string, game: CoachGame): Promise<void> {
    let last = emptyUsage();
    let calls = 0;
    try {
      const out = await this.loop(
        { system: SYSTEM, first: [...this.contextBlocks(game), { type: "text", text: "Write the coaching report as JSON matching the schema." }], json: true, effort: "high", maxCalls: 8 },
        (u, c) => {
          last = u;
          calls = c;
          this.save(id, u, c);
        },
      );
      if (out.refusal) return this.save(id, last, calls, { status: "error", error: `the model declined (${out.refusal})` });
      let report: CoachReport | null = null;
      try {
        report = out.text ? (JSON.parse(out.text) as CoachReport) : null;
      } catch {
        report = null;
      }
      if (out.capped) return this.save(id, last, calls, { status: "capped", error: out.capped, report });
      if (!report) return this.save(id, last, calls, { status: "error", error: "the model's answer was not a readable report" });
      this.save(id, last, calls, { status: "done", report });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "coach report failed");
      this.save(id, last, calls, { status: "error", error: (err as Error).message.slice(0, 300) });
    }
  }

  /** One follow-up question at a time on a finished report. */
  followup(reportId: string, userId: string, question: string): { id: number } {
    if (!this.llm) throw new CoachError("the AI coach is not enabled");
    const q = question.trim();
    if (!q) throw new CoachError("ask a question");
    if (q.length > 1000) throw new CoachError("keep the question under 1000 characters");
    const row = this.handle.db.select().from(coachReports).where(and(eq(coachReports.id, reportId), eq(coachReports.userId, userId))).get();
    if (!row || row.status !== "done") throw new CoachError("the report is not ready");
    if (this.handle.db.select().from(coachFollowups).where(and(eq(coachFollowups.reportId, reportId), eq(coachFollowups.status, "running"))).get()) throw new CoachError("one question at a time: the last one is still being answered");
    if (this.spentToday() >= this.limits.maxUsdPerDay) throw new CoachError(`today's AI coach budget ($${this.limits.maxUsdPerDay}) is used up; try again tomorrow`);
    const game = buildCoachGame(this.handle, this.decisions, row.roomId, userId);
    if (!game) throw new CoachError("that game is no longer available");
    const earlier = this.handle.db.select().from(coachFollowups).where(and(eq(coachFollowups.reportId, reportId), eq(coachFollowups.status, "done"))).orderBy(desc(coachFollowups.id)).limit(5).all().reverse();
    const id = Number(this.handle.db.insert(coachFollowups).values({ reportId, question: q, answer: null, status: "running", createdAt: new Date().toISOString() }).run().lastInsertRowid);
    const prior = earlier.map((f) => `Q: ${f.question}\nA: ${f.answer ?? ""}`).join("\n\n");
    this.background(async () => {
      let last = emptyUsage();
      const saveF = (u: CoachUsage, extra: Partial<typeof coachFollowups.$inferInsert> = {}) =>
        this.handle.db
          .update(coachFollowups)
          .set({ inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens, costUsd: costOf(this.llm!.model, u), ...extra })
          .where(eq(coachFollowups.id, id))
          .run();
      try {
        const out = await this.loop(
          {
            system: FOLLOWUP_SYSTEM,
            first: [...this.contextBlocks(game), { type: "text", text: `Your report:\n${JSON.stringify(row.report)}\n\n${prior ? `Earlier follow-ups:\n${prior}\n\n` : ""}The player asks: ${q}` }],
            json: false,
            effort: "medium",
            maxCalls: 4,
          },
          (u) => {
            last = u;
            saveF(u);
          },
        );
        if (out.refusal) saveF(last, { status: "error", answer: `The model declined to answer (${out.refusal}).` });
        else saveF(last, { status: out.text ? "done" : "error", answer: out.text || out.capped || "No answer." });
      } catch (err) {
        saveF(last, { status: "error", answer: `Failed: ${(err as Error).message.slice(0, 200)}` });
      }
    });
    return { id };
  }

  /** Owner's Admin page: spend per report. */
  usage() {
    const rows = this.handle.db.select().from(coachReports).orderBy(desc(coachReports.createdAt)).limit(50).all();
    return rows.map((r) => {
      const f = this.handle.db.select({ c: coachFollowups.costUsd }).from(coachFollowups).where(eq(coachFollowups.reportId, r.id)).all();
      return { code: r.roomCode, kind: r.kind, status: r.status, model: r.model, calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd: r.costUsd, followups: f.length, followupUsd: f.reduce((n, x) => n + x.c, 0), createdAt: r.createdAt };
    });
  }
}
