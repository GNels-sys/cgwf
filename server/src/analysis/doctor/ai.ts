import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTool, BetaToolResultBlockParam, BetaToolUseBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { and, desc, eq, gte } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { BRACKET_NAMES, DOCTOR_ROLE_LABELS, normalizeName, type Bracket, type DoctorAiResult, type DoctorAiRun, type DoctorAiSwap, type DoctorAiUsage, type DoctorCardRef } from "@cgwf/shared";
import { config } from "../../config.js";
import type { DbHandle } from "../../db/index.js";
import { cards, doctorAiRuns, type CardRow } from "../../db/schema.js";
import type { NameIndex } from "../../search/index.js";
import { costOf } from "../../agents/pricing.js";
import { analyzeDeck, fromRow, loadGameChangers } from "../index.js";
import { isLand } from "../cards.js";
import type { SpellbookResults, SpellbookVariant } from "../combos.js";
import { edhrecValue } from "./plan.js";
import { rolesOf } from "./roles.js";
import { DoctorError, type DeckDoctor, type DoctorContext, type DoctorTarget } from "./service.js";
import type { DoctorDeckCard } from "./plan.js";

/**
 * Deck Doctor AI upgrade (M2, owner only, DOCTOR_AI_ENABLED=1). Claude (DOCTOR_MODEL, default Claude
 * Opus 5.5 at effort "high": quality over cost, volume is a handful of runs) reads the deck with full
 * oracle text, the bracket analysis, role counts, the free Doctor's shortlist and EDHREC evidence, the
 * primer and the player's keep / dismiss choices, and answers through two tools:
 *
 *   lookup_card(name)                 -> the card from OUR cards table: legality, colour identity, oracle
 *                                        text, roles, Game Changer, whether it is in the deck, and the
 *                                        bracket floor if it were added. Unknown names get suggestions.
 *   submit_recommendations(read, swaps) -> validated here with the same rules as the free Doctor (real card,
 *                                        paper, Commander-legal, inside the identity, not in the deck, not
 *                                        dismissed, cut in the deck and not a commander / kept card, lands
 *                                        only for lands, bracket floor within the target unless allowed).
 *                                        An invalid submission goes back as an error and Claude tries again.
 *
 * Spend: each model call is checked first against DOCTOR_MAX_USD_PER_RUN and DOCTOR_MAX_USD_PER_DAY (its
 * own cap, separate from the agents'), costs come from the usage the API returns (per model attempt when a
 * refusal fallback ran), every run is a row in doctor_ai_runs. A finished run is cached per deck version.
 */

export interface DoctorLlmRequest {
  system: string;
  messages: BetaMessageParam[];
  tools: BetaTool[];
  maxTokens: number;
  effort: string;
}

export interface DoctorLlm {
  readonly model: string;
  call(req: DoctorLlmRequest): Promise<BetaMessage>;
}

/** Claude through the official SDK: streamed (long thinking), auto tool choice, server-side refusal fallbacks. */
export class AnthropicDoctorLlm implements DoctorLlm {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string,
    workspaceId = "",
  ) {
    this.client = new Anthropic({ apiKey, timeout: 10 * 60 * 1000, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  async call(req: DoctorLlmRequest): Promise<BetaMessage> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
      tools: req.tools,
      tool_choice: { type: "auto" },
      output_config: { effort: req.effort as "high" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return stream.finalMessage();
  }
}

/** Cost of one response: per model attempt when the API reports iterations (refusal fallbacks). */
export function messageCost(requested: string, msg: Pick<BetaMessage, "model" | "usage">): number {
  const iterations = (msg.usage as { iterations?: Array<{ model?: string | null; input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }> | null }).iterations;
  if (iterations && iterations.length) return iterations.reduce((n, it) => n + costOf(it.model ?? requested, it), 0);
  return costOf(msg.model || requested, msg.usage);
}

const BRACKET_RULES = `Commander Brackets (Wizards, beta; what this app enforces when checking a swap):
- Bracket 1 Exhibition / 2 Core: no Game Changers, no mass land denial, no two-card infinite combos, extra turns only a few and never chained.
- Bracket 3 Upgraded: up to three Game Changers, no mass land denial, no early-game (about turn 6) two-card combos, extra turns not chained.
- Bracket 4 Optimized: anything legal. Bracket 5 cEDH: anything, built for the competitive meta.
The "floor" is the lowest bracket the written rules allow for a list.`;

const SYSTEM = `You are an expert Magic: The Gathering Commander deck builder advising one player on their deck.

Your job: find the swaps that most improve this deck as it is meant to be played, at the target bracket. A swap adds one card and cuts one card, so the deck stays at its size. Recommend at most five, best first. Prefer cards that deepen the deck's actual plan and fix its real weaknesses over generic staples, and say why in one or two concrete sentences per swap.

How to work:
- The free Deck Doctor's shortlist and EDHREC numbers are evidence, not answers. Use your own judgment; you may agree with them, improve on them, or ignore them.
- Use lookup_card for every card you intend to add and whenever you are unsure of a card's exact name, text, legality or bracket effect. Only cards that lookup_card finds are real for this app.
- Never add a card already in the deck or one the player dismissed; never cut a commander or a card the player pinned to keep; cut a land only when adding a land.
- Stay within the target bracket unless the player allowed a higher one.
- When you are done, call submit_recommendations once with a one-paragraph read of the deck (its plan, how it wins, its main weaknesses) and the swaps. If it reports problems, fix them and submit again.`;

export const DOCTOR_TOOLS: BetaTool[] = [
  {
    name: "lookup_card",
    description:
      "Look up a Magic card by exact English name in this app's card database. Returns its oracle text, type, mana cost, colour identity, Commander legality, roles, whether it is a Game Changer, whether it is already in the deck or dismissed, and the deck's bracket floor if it were added. Unknown names return close matches.",
    input_schema: { type: "object", properties: { name: { type: "string", description: "Exact card name, e.g. \"Rhystic Study\"" } }, required: ["name"], additionalProperties: false },
    strict: true,
  },
  {
    name: "submit_recommendations",
    description: "Submit the final answer: a one-paragraph read of the deck and up to five swaps (add one card, cut one card). Validated against the deck and the bracket; problems come back as an error to fix.",
    input_schema: {
      type: "object",
      properties: {
        read: { type: "string", description: "One paragraph: the deck's plan, how it wins, its main weaknesses." },
        swaps: {
          type: "array",
          description: "Best first, at most five.",
          items: {
            type: "object",
            properties: {
              add: { type: "string", description: "Exact name of the card to add" },
              cut: { type: "string", description: "Exact name of the card in the deck to cut" },
              reason: { type: "string", description: "One or two concrete sentences" },
            },
            required: ["add", "cut", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["read", "swaps"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const DAY_MS = 24 * 3600 * 1000;
const todayStart = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString();

type RunRow = typeof doctorAiRuns.$inferSelect;

export class DoctorAi {
  private running = new Set<string>();

  constructor(
    private readonly d: {
      handle: DbHandle;
      index: NameIndex;
      doctor: DeckDoctor;
      llm: DoctorLlm | null;
      enabled?: boolean | undefined;
      log?: FastifyBaseLogger | null;
      caps?: Partial<{ perRun: number; perDay: number; maxTokens: number; maxCalls: number; effort: string }> | undefined;
    },
  ) {}

  get enabled(): boolean {
    return this.d.enabled ?? config.doctorAiEnabled;
  }

  private get caps() {
    return {
      perRun: this.d.caps?.perRun ?? config.doctorMaxUsdPerRun,
      perDay: this.d.caps?.perDay ?? config.doctorMaxUsdPerDay,
      maxTokens: this.d.caps?.maxTokens ?? config.doctorMaxTokensPerCall,
      maxCalls: this.d.caps?.maxCalls ?? config.doctorMaxCalls,
      effort: this.d.caps?.effort ?? config.doctorEffort,
    };
  }

  problem(): string | null {
    if (!this.enabled) return "DOCTOR_AI_ENABLED is not set";
    if (!this.d.llm) return "ANTHROPIC_API_KEY is not set on the server";
    return null;
  }

  spentSince(iso: string): number {
    return this.d.handle.db.select({ c: doctorAiRuns.costUsd }).from(doctorAiRuns).where(gte(doctorAiRuns.startedAt, iso)).all().reduce((n, r) => n + r.c, 0);
  }

  todayUsd(): number {
    return this.spentSince(todayStart());
  }

  toRun(r: RunRow, currentVersion: string | null): DoctorAiRun {
    return {
      id: r.id,
      deckRef: r.deckRef,
      deckName: r.deckName,
      deckVersion: r.deckVersion,
      current: currentVersion === null || r.deckVersion === currentVersion,
      targetBracket: r.targetBracket,
      allowHigher: r.allowHigher,
      model: r.model,
      servedBy: r.servedBy,
      status: r.status as DoctorAiRun["status"],
      calls: r.calls,
      toolCalls: r.toolCalls,
      invalidSubmissions: r.invalidSubmissions,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      costUsd: Math.round(r.costUsd * 10000) / 10000,
      result: (r.result as DoctorAiResult | null) ?? null,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    };
  }

  /** The newest run for this deck (any version), marked current or not. */
  latest(userId: string, t: DoctorTarget): DoctorAiRun | null {
    const deck = this.d.doctor.loadDeck(t);
    if (!deck) throw new DoctorError("deck not found", 404);
    const row = this.d.handle.db.select().from(doctorAiRuns).where(and(eq(doctorAiRuns.userId, userId), eq(doctorAiRuns.deckRef, deck.deckRef))).orderBy(desc(doctorAiRuns.startedAt)).get();
    return row ? this.toRun(row, deck.version) : null;
  }

  usage(): DoctorAiUsage {
    const rows = this.d.handle.db.select().from(doctorAiRuns).orderBy(desc(doctorAiRuns.startedAt)).limit(30).all();
    return {
      enabled: this.enabled,
      model: this.d.llm?.model ?? config.doctorModel,
      maxUsdPerRun: this.caps.perRun,
      maxUsdPerDay: this.caps.perDay,
      todayUsd: Math.round(this.todayUsd() * 10000) / 10000,
      last30Usd: Math.round(this.spentSince(new Date(Date.now() - 30 * DAY_MS).toISOString()) * 10000) / 10000,
      runs: rows.map((r) => this.toRun(r, null)),
    };
  }

  /**
   * Start a run in the background (or return the finished run for this deck version unless `force`).
   * Resolves when the run row exists; poll `latest` for the result.
   */
  async start(t: DoctorTarget, opts: { target?: number | undefined; allowHigher?: boolean | undefined; force?: boolean | undefined }): Promise<DoctorAiRun> {
    const problem = this.problem();
    if (problem) throw new DoctorError(`The AI upgrade is off: ${problem}.`, 503);
    const deck = this.d.doctor.loadDeck(t);
    if (!deck) throw new DoctorError("deck not found", 404);
    if (this.running.has(deck.deckRef)) throw new DoctorError("a run for this deck is already in progress", 409);
    if (!opts.force) {
      const cached = this.d.handle.db
        .select()
        .from(doctorAiRuns)
        .where(and(eq(doctorAiRuns.userId, t.userId), eq(doctorAiRuns.deckRef, deck.deckRef), eq(doctorAiRuns.deckVersion, deck.version), eq(doctorAiRuns.status, "done")))
        .orderBy(desc(doctorAiRuns.startedAt))
        .get();
      if (cached && (opts.target === undefined || cached.targetBracket === opts.target) && Boolean(cached.allowHigher) === Boolean(opts.allowHigher)) return this.toRun(cached, deck.version);
    }
    if (this.todayUsd() >= this.caps.perDay) throw new DoctorError(`Today's AI budget ($${this.caps.perDay.toFixed(2)}) is used up; it resets at midnight UTC.`, 429);
    const ctx = await this.d.doctor.build(t, { target: opts.target, allowHigher: opts.allowHigher });
    const id = randomUUID();
    this.d.handle.db
      .insert(doctorAiRuns)
      .values({ id, userId: t.userId, deckRef: deck.deckRef, deckName: deck.name, deckVersion: deck.version, targetBracket: ctx.response.targetBracket, allowHigher: ctx.response.allowHigher, model: this.d.llm!.model, status: "running", startedAt: new Date().toISOString() })
      .run();
    this.running.add(deck.deckRef);
    void this.loop(id, ctx)
      .catch((err: unknown) => this.finish(id, "error", null, err instanceof Error ? err.message : String(err)))
      .finally(() => this.running.delete(deck.deckRef));
    return this.toRun(this.row(id)!, deck.version);
  }

  /** Run to completion (tests, CLI); same as start but awaited. */
  async runNow(t: DoctorTarget, opts: { target?: number; allowHigher?: boolean } = {}): Promise<DoctorAiRun> {
    const first = await this.start(t, { ...opts, force: true });
    for (let i = 0; i < 6000 && this.row(first.id)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    return this.toRun(this.row(first.id)!, null);
  }

  private row(id: string): RunRow | undefined {
    return this.d.handle.db.select().from(doctorAiRuns).where(eq(doctorAiRuns.id, id)).get();
  }

  private finish(id: string, status: DoctorAiRun["status"], result: DoctorAiResult | null, error: string | null): void {
    this.d.handle.db.update(doctorAiRuns).set({ status, result, error, finishedAt: new Date().toISOString() }).where(eq(doctorAiRuns.id, id)).run();
    this.d.log?.info({ run: id, status, error }, "deck doctor AI run finished");
  }

  private async loop(id: string, ctx: DoctorContext): Promise<void> {
    const llm = this.d.llm!;
    const caps = this.caps;
    const dayBefore = this.todayUsd();
    const messages: BetaMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: renderContext(ctx), cache_control: { type: "ephemeral" } },
          { type: "text", text: `Recommend up to five swaps for this deck at Bracket ${ctx.response.targetBracket}${ctx.response.allowHigher ? " (a higher bracket is allowed)" : ""}. Look cards up, then call submit_recommendations.` },
        ],
      },
    ];
    let cost = 0;
    let nudges = 0;
    for (let call = 1; call <= caps.maxCalls; call++) {
      if (cost >= caps.perRun) return this.finish(id, "capped", null, `stopped at the per-run cap ($${caps.perRun.toFixed(2)})`);
      if (dayBefore + cost >= caps.perDay) return this.finish(id, "capped", null, `stopped at the daily cap ($${caps.perDay.toFixed(2)})`);
      const msg = await llm.call({ system: SYSTEM, messages, tools: DOCTOR_TOOLS, maxTokens: caps.maxTokens, effort: caps.effort });
      const callCost = messageCost(llm.model, msg);
      cost += callCost;
      const u = msg.usage;
      const r = this.row(id)!;
      this.d.handle.db
        .update(doctorAiRuns)
        .set({
          calls: r.calls + 1,
          inputTokens: r.inputTokens + u.input_tokens,
          outputTokens: r.outputTokens + u.output_tokens,
          cacheReadTokens: r.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
          cacheWriteTokens: r.cacheWriteTokens + (u.cache_creation_input_tokens ?? 0),
          costUsd: r.costUsd + callCost,
          servedBy: msg.model,
        })
        .where(eq(doctorAiRuns.id, id))
        .run();
      if (msg.stop_reason === "refusal") {
        const cat = (msg as { stop_details?: { category?: string | null } | null }).stop_details?.category ?? null;
        return this.finish(id, "refused", null, `the model declined${cat ? ` (${cat})` : ""}`);
      }
      messages.push({ role: "assistant", content: msg.content as BetaMessageParam["content"] });
      const uses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (uses.length === 0 || msg.stop_reason === "max_tokens") {
        if (++nudges > 2) return this.finish(id, "error", null, "the model stopped without submitting recommendations");
        messages.push({ role: "user", content: msg.stop_reason === "max_tokens" ? "Your last answer was cut off. Keep it shorter, then call submit_recommendations." : "Please finish by calling submit_recommendations." });
        continue;
      }
      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        this.bump(id, "toolCalls");
        if (use.name === "lookup_card") {
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(this.lookup(ctx, String(input.name ?? ""))) });
        } else if (use.name === "submit_recommendations") {
          const v = this.validate(ctx, input);
          if (v.ok) return this.finish(id, "done", v.result, null);
          this.bump(id, "invalidSubmissions");
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Not accepted. Fix these and submit again:\n- ${v.problems.join("\n- ")}` });
        } else {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}.` });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return this.finish(id, "capped", null, `no valid answer within ${caps.maxCalls} model calls`);
  }

  private bump(id: string, field: "toolCalls" | "invalidSubmissions"): void {
    const r = this.row(id)!;
    this.d.handle.db.update(doctorAiRuns).set({ [field]: r[field] + 1 }).where(eq(doctorAiRuns.id, id)).run();
  }

  /** A card row by exact (normalised) name: the default printing. */
  private card(name: string): CardRow | null {
    const hit = this.d.index.exact(normalizeName(name));
    if (!hit || hit.isToken) return null;
    return this.d.handle.db.select().from(cards).where(eq(cards.id, hit.id)).get() ?? null;
  }

  /** Floor of the deck with these adds (and these cuts removed), counting combos the adds complete. */
  floorWith(ctx: DoctorContext, adds: CardRow[], cutNames: string[] = []): number {
    const cutLeft = new Map<string, number>();
    for (const n of cutNames) cutLeft.set(n, (cutLeft.get(n) ?? 0) + 1);
    const deck = ctx.cards
      .map((c) => {
        const k = cutLeft.get(c.name) ?? 0;
        if (!k) return c;
        cutLeft.set(c.name, 0);
        return { ...c, quantity: c.quantity - k };
      })
      .filter((c) => c.quantity > 0);
    const names = new Set([...deck.map((c) => c.name), ...adds.map((a) => a.name)]);
    const completes: SpellbookVariant[] = (ctx.combos?.almostIncluded ?? []).filter((v) => v.uses.every((u) => names.has(u.card.name)));
    const combos: SpellbookResults = { included: [...(ctx.combos?.included ?? []).filter((v) => v.uses.every((u) => names.has(u.card.name))), ...completes] };
    return analyzeDeck([...deck, ...adds.map((a) => fromRow(a, 1, "main"))], { gameChangers: loadGameChangers(), combos }).floor;
  }

  lookup(ctx: DoctorContext, name: string): Record<string, unknown> {
    const row = this.card(name);
    if (!row) {
      const close = this.d.index.search(name, { limit: 5 }).map((e) => e.name);
      return { found: false, name, message: "No card with that exact name.", closeMatches: close };
    }
    const legal = (row.legalities as Record<string, string>).commander === "legal";
    const inIdentity = (row.colorIdentity as string[]).every((c) => ctx.identity.has(c));
    const inDeck = ctx.cards.some((c) => (c.oracleId && c.oracleId === row.oracleId) || normalizeName(c.name) === normalizeName(row.name));
    const gc = loadGameChangers().index.has(normalizeName(row.name.split(" // ")[0] ?? row.name));
    const floorBefore = ctx.analysis.floor;
    const floorAfter = inDeck ? floorBefore : this.floorWith(ctx, [row]);
    const stat = ctx.edhrecCards?.get(normalizeName(row.name));
    return {
      found: true,
      name: row.name,
      manaCost: row.manaCost,
      manaValue: row.cmc,
      typeLine: row.typeLine,
      oracleText: row.oracleText,
      colorIdentity: row.colorIdentity,
      commanderLegal: legal,
      insideCommanderColours: inIdentity,
      gameChanger: gc,
      roles: rolesOf(fromRow(row, 1, "main")),
      alreadyInDeck: inDeck,
      dismissedByPlayer: row.oracleId ? ctx.dismissed.has(row.oracleId) : false,
      bracketFloorNow: floorBefore,
      bracketFloorIfAdded: floorAfter,
      edhrec: stat ? { synergy: Math.round(stat.synergy * 100) / 100, inclusion: Math.round(stat.inclusion * 100) / 100 } : null,
    };
  }

  validate(ctx: DoctorContext, input: Record<string, unknown>): { ok: true; result: DoctorAiResult } | { ok: false; problems: string[] } {
    const problems: string[] = [];
    const read = typeof input.read === "string" ? input.read.trim() : "";
    if (!read) problems.push("read: give a one-paragraph read of the deck.");
    const raw = Array.isArray(input.swaps) ? (input.swaps as Array<Record<string, unknown>>) : [];
    if (raw.length === 0) problems.push("swaps: give at least one swap.");
    if (raw.length > 5) problems.push("swaps: at most five.");
    const ceiling = Math.max(ctx.response.targetBracket, ctx.analysis.floor);
    const usedAdds = new Set<string>();
    const cutUse = new Map<string, number>();
    const adds: CardRow[] = [];
    const cutsChosen: DoctorDeckCard[] = [];
    const swaps: DoctorAiSwap[] = [];
    raw.slice(0, 5).forEach((s, i) => {
      const n = i + 1;
      const addName = String(s.add ?? "");
      const cutName = String(s.cut ?? "");
      const reason = String(s.reason ?? "").trim();
      const add = this.card(addName);
      const before = problems.length;
      if (!add || !add.oracleId) problems.push(`swap ${n}: "${addName}" is not a card in the database (use lookup_card for the exact name).`);
      else {
        if (add.isDigital) problems.push(`swap ${n}: ${add.name} has no paper printing.`);
        if ((add.legalities as Record<string, string>).commander !== "legal") problems.push(`swap ${n}: ${add.name} is not legal in Commander.`);
        if (!(add.colorIdentity as string[]).every((c) => ctx.identity.has(c))) problems.push(`swap ${n}: ${add.name} is outside the commander's colour identity.`);
        if (ctx.cards.some((c) => c.oracleId === add.oracleId)) problems.push(`swap ${n}: ${add.name} is already in the deck.`);
        if (ctx.dismissed.has(add.oracleId)) problems.push(`swap ${n}: the player dismissed ${add.name}.`);
        if (usedAdds.has(add.oracleId)) problems.push(`swap ${n}: ${add.name} is added twice.`);
      }
      const cut = ctx.cards.find((c) => normalizeName(c.name) === normalizeName(cutName) || normalizeName(c.name.split(" // ")[0] ?? c.name) === normalizeName(cutName));
      if (!cut) problems.push(`swap ${n}: "${cutName}" is not in the deck.`);
      else {
        if (cut.board === "commander") problems.push(`swap ${n}: ${cut.name} is a commander and cannot be cut.`);
        if (cut.oracleId && ctx.keep.has(cut.oracleId)) problems.push(`swap ${n}: the player pinned ${cut.name} to keep.`);
        if (add && isLand(cut) && !isLand(fromRow(add, 1, "main"))) problems.push(`swap ${n}: ${cut.name} is a land; cut a land only when adding a land.`);
        if ((cutUse.get(cut.name) ?? 0) + 1 > cut.quantity) problems.push(`swap ${n}: ${cut.name} is cut more times than the deck has copies.`);
      }
      if (!reason) problems.push(`swap ${n}: give a reason.`);
      if (problems.length > before || !add || !cut) return;
      usedAdds.add(add.oracleId!);
      cutUse.set(cut.name, (cutUse.get(cut.name) ?? 0) + 1);
      adds.push(add);
      cutsChosen.push(cut);
      const floorAfter = this.floorWith(ctx, [add], [cut.name]);
      if (floorAfter > ceiling && !ctx.response.allowHigher) {
        problems.push(`swap ${n}: adding ${add.name} raises the bracket floor to ${floorAfter}, above the target ${ctx.response.targetBracket}.`);
        return;
      }
      swaps.push({ add: this.ref(ctx, add), cut: { ...this.refDeck(ctx, cut), entryId: cut.entryId, quantity: cut.quantity }, reason: reason.slice(0, 600), bracket: { floorAfter, raises: floorAfter > ceiling } });
    });
    if (problems.length === 0 && adds.length > 1 && !ctx.response.allowHigher) {
      const together = this.floorWith(ctx, adds, cutsChosen.map((c) => c.name));
      if (together > ceiling) problems.push(`together these swaps raise the bracket floor to ${together}, above the target ${ctx.response.targetBracket}; drop or replace one.`);
    }
    if (problems.length) return { ok: false, problems };
    return { ok: true, result: { read: read.slice(0, 2000), swaps } };
  }

  private ref(ctx: DoctorContext, row: CardRow): DoctorCardRef {
    const stat = ctx.edhrecCards?.get(normalizeName(row.name));
    return { cardId: row.id, oracleId: row.oracleId, name: row.name, typeLine: row.typeLine, manaCost: row.manaCost, faceCount: row.imageBack ? 2 : 1, roles: rolesOf(fromRow(row, 1, "main")), synergy: stat?.synergy ?? null, inclusion: stat?.inclusion ?? null };
  }

  private refDeck(ctx: DoctorContext, c: DoctorDeckCard): DoctorCardRef {
    const stat = ctx.edhrecCards?.get(normalizeName(c.name));
    return { cardId: c.cardId, oracleId: c.oracleId, name: c.name, typeLine: c.typeLine, manaCost: c.manaCost, faceCount: c.faceCount, roles: rolesOf(c), synergy: stat?.synergy ?? null, inclusion: stat?.inclusion ?? null };
  }
}

/** Everything Claude reads about the deck (one cached block). */
export function renderContext(ctx: DoctorContext): string {
  const r = ctx.response;
  const a = ctx.analysis;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const stat = (name: string) => ctx.edhrecCards?.get(normalizeName(name));
  const lines: string[] = [];
  lines.push(`# Deck: ${ctx.name}`);
  lines.push(`Commander(s): ${r.commanders.join(" + ") || "none marked"}. Colour identity: ${[...ctx.identity].join("") || "colourless"}.`);
  lines.push(`Target bracket: ${r.targetBracket} (${BRACKET_NAMES[r.targetBracket as Bracket]}). The analysis suggests ${a.suggested}; the written-rules floor is ${a.floor}.${r.allowHigher ? " The player allows a higher bracket." : ""}`);
  lines.push("", BRACKET_RULES, "");
  lines.push(`## Bracket analysis`, a.summary);
  if (a.reasons.length) lines.push(...a.reasons.map((x) => `- Bracket ${x.bracket}: ${x.text}`));
  if (a.gameChangers?.length) lines.push(`Game Changers in the deck: ${a.gameChangers.join(", ")}.`);
  if (a.combos?.length) lines.push(`Known combos in the deck (Commander Spellbook): ${a.combos.map((c) => `${c.cards.join(" + ")}${c.early ? " (early)" : ""}`).join("; ")}.`);
  lines.push("", "## Role counts (heuristic; rule-of-thumb targets)", r.roles.map((x) => `${DOCTOR_ROLE_LABELS[x.role]} ${x.have}/${x.want}`).join(", "));
  lines.push("", "## Decklist (with oracle text; EDHREC synergy / inclusion for this commander where listed)");
  for (const c of ctx.cards) {
    const s = stat(c.name);
    const kept = c.oracleId && ctx.keep.has(c.oracleId) ? " [PINNED: keep]" : "";
    lines.push(`- ${c.quantity} ${c.name}${c.board === "commander" ? " [COMMANDER]" : ""}${kept} | ${c.manaCost || "no cost"} | ${c.typeLine}${s ? ` | EDHREC ${pct(s.synergy)} syn, ${pct(s.inclusion)} incl` : ""}`);
    if (c.oracleText) lines.push(`  ${c.oracleText.replace(/\n/g, " / ")}`);
  }
  if (r.swaps.length) {
    lines.push("", "## The free Deck Doctor's shortlist (evidence; you decide)");
    for (const s of r.swaps) lines.push(`- Add ${s.add.name} / cut ${s.cut.name}: ${s.reason}${s.combos.length ? ` Combo: ${s.combos[0]}.` : ""}`);
  }
  if (ctx.edhrecCards) {
    const inDeck = new Set(ctx.cards.map((c) => normalizeName(c.name)));
    const top = [...ctx.edhrecCards.values()].filter((s) => !inDeck.has(normalizeName(s.name))).sort((x, y) => edhrecValue(y) - edhrecValue(x)).slice(0, 60);
    lines.push("", `## Top EDHREC cards for this commander not in the deck (${r.edhrec.page ?? "all brackets"})`, top.map((s) => `${s.name} (${pct(s.synergy)} syn, ${pct(s.inclusion)} incl)`).join("; "));
  } else {
    lines.push("", `EDHREC: ${r.edhrec.message ?? "no data"}`);
  }
  if (ctx.primer.trim()) lines.push("", "## The deck's primer", ctx.primer.trim().slice(0, 6000));
  if (r.dismissed.length) lines.push("", `Dismissed by the player (never suggest): ${r.dismissed.map((d) => d.name).join(", ")}.`);
  if (r.keep.length) lines.push(`Pinned to keep (never cut): ${r.keep.map((k) => k.name).join(", ")}.`);
  return lines.join("\n");
}
