import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  AVATARS,
  AVATAR_COLORS,
  isBracket,
  type AgentDecisionInfo,
  type AgentGameSummary,
  type AgentPick,
  type AgentRunInfo,
  type AgentsStatus,
  type ArchetypeTag,
  type Bracket,
  type RoomAgentsResponse,
} from "@cgwf/shared";
import { primerSkeleton } from "../analysis/index.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { agentDecisions, agentRuns, deckCards, decks, libraryDecks, rooms, users } from "../db/schema.js";
import type { LibraryService } from "../library/service.js";
import { RoomError, type LiveRoom } from "../rooms/live.js";
import type { Llm } from "./llm.js";
import { costOf } from "./pricing.js";
import { loadPrimers } from "./primers.js";
import { AgentRunner, type DecisionRecord } from "./runner.js";

/**
 * Seats computer opponents, starts their runners when a game begins, records
 * every decision and enforces the spending caps. One instance per server.
 */
export interface AgentManagerDeps {
  handle: DbHandle;
  library: LibraryService;
  analyzer: DeckAnalyzer;
  log: FastifyBaseLogger | null;
  /** null = dry run (no key). Tests inject a ScriptedLlm. */
  llm: Llm | null;
  enabled?: boolean | undefined;
}

const MAX_AGENTS = 3;
const DRAFT_SPEND_KEY = (day: string) => `agent_draft_spend:${day}`;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class AgentManager {
  private runners = new Map<string, Map<string, AgentRunner>>();
  readonly enabled: boolean;

  constructor(private readonly d: AgentManagerDeps) {
    this.enabled = d.enabled ?? config.agentsEnabled;
  }

  get dryRun(): boolean {
    return this.d.llm === null;
  }

  status(): AgentsStatus {
    return {
      enabled: this.enabled,
      dryRun: this.dryRun,
      model: this.d.llm?.model ?? config.agentModel,
      maxUsdPerGame: config.agentMaxUsdPerGame,
      maxUsdPerDay: config.agentMaxUsdPerDay,
      todayUsd: this.spendToday(),
    };
  }

  // ------------------------------------------------------------ spend

  spendForRoom(roomId: string): number {
    const row = this.d.handle.db.select({ n: sql<number>`coalesce(sum(${agentDecisions.costUsd}), 0)` }).from(agentDecisions).where(eq(agentDecisions.roomId, roomId)).get();
    return row?.n ?? 0;
  }

  spendToday(): number {
    const since = `${today()}T00:00:00.000Z`;
    const row = this.d.handle.db.select({ n: sql<number>`coalesce(sum(${agentDecisions.costUsd}), 0)` }).from(agentDecisions).where(gte(agentDecisions.createdAt, since)).get();
    const drafts = Number(this.d.handle.getMeta(DRAFT_SPEND_KEY(today())) ?? "0");
    return Math.round(((row?.n ?? 0) + drafts) * 1e6) / 1e6;
  }

  private addDraftSpend(usd: number): void {
    const key = DRAFT_SPEND_KEY(today());
    this.d.handle.setMeta(key, String(Number(this.d.handle.getMeta(key) ?? "0") + usd));
  }

  /** Both caps, checked before every model call. */
  mayCall(roomId: string): { ok: true } | { ok: false; reason: string } {
    if (this.dryRun) return { ok: true };
    const game = this.spendForRoom(roomId);
    if (game >= config.agentMaxUsdPerGame) return { ok: false, reason: `game spending cap reached ($${game.toFixed(2)} of $${config.agentMaxUsdPerGame.toFixed(2)})` };
    const day = this.spendToday();
    if (day >= config.agentMaxUsdPerDay) return { ok: false, reason: `daily spending cap reached ($${day.toFixed(2)} of $${config.agentMaxUsdPerDay.toFixed(2)})` };
    return { ok: true };
  }

  // ------------------------------------------------------------ lobby: pick decks, create seats

  private agentMembers(room: LiveRoom) {
    const members = room.members().filter((m) => m.role === "player");
    if (members.length === 0) return [];
    const userRows = this.d.handle.db.select().from(users).where(inArray(users.id, members.map((m) => m.userId))).all();
    return members.flatMap((m) => {
      const u = userRows.find((x) => x.id === m.userId);
      return u?.isAgent ? [{ member: m, user: u }] : [];
    });
  }

  /** Remove every computer opponent from a lobby (their user rows and copied decks go too). */
  removeAgents(room: LiveRoom): number {
    if (room.status !== "lobby") throw new RoomError("agents can only be changed in the lobby");
    const agents = this.agentMembers(room);
    for (const { user } of agents) {
      room.leave(user.id);
      this.d.handle.db.delete(deckCards).where(inArray(deckCards.deckId, this.d.handle.db.select({ id: decks.id }).from(decks).where(eq(decks.userId, user.id)))).run();
      this.d.handle.db.delete(decks).where(eq(decks.userId, user.id)).run();
      this.d.handle.db.delete(users).where(eq(users.id, user.id)).run();
    }
    if (agents.length) room.broadcastRoom();
    return agents.length;
  }

  /** Archetype tags of the host's chosen deck, to pick agents that play differently. */
  private async hostTags(room: LiveRoom, hostId: string): Promise<{ tags: Set<ArchetypeTag>; bracket: Bracket | null }> {
    const m = room.member(hostId);
    if (!m?.deckId) return { tags: new Set(), bracket: null };
    try {
      const cards = this.d.analyzer.loadDeckCards(m.deckId);
      const a = (await this.d.analyzer.analyze(cards, { combos: "skip" })).analysis;
      return { tags: new Set(a.archetypes.map((t) => t.tag)), bracket: a.suggested };
    } catch {
      return { tags: new Set(), bracket: null };
    }
  }

  /** Replace the lobby's agents with `count` fresh picks of the given bracket. */
  async addAgents(room: LiveRoom, hostId: string, opts: { count: number; bracket: Bracket }): Promise<{ agents: AgentPick[]; eligible: number }> {
    if (!this.enabled) throw new RoomError("agents are switched off");
    const row = room.refreshRow();
    if (row.status !== "lobby") throw new RoomError("agents can only be added in the lobby");
    if (row.hostUserId !== hostId) throw new RoomError("only the host can add agents");
    const count = Math.max(1, Math.min(MAX_AGENTS, Math.floor(opts.count)));
    if (!isBracket(opts.bracket)) throw new RoomError("bracket must be 1-5");
    this.removeAgents(room);

    const humans = room.members().filter((m) => m.role === "player" && m.seat !== null);
    const freeSeats = [0, 1, 2, 3].filter((s) => !humans.some((m) => m.seat === s));
    if (freeSeats.length === 0) throw new RoomError("no free seats");

    const host = await this.hostTags(room, hostId);
    let pool = this.d.library.list({ agentEligible: true, bracket: opts.bracket });
    const eligible = pool.length;
    if (pool.length === 0) pool = this.d.library.list({ agentEligible: true });
    if (pool.length === 0) throw new RoomError("no agent-eligible decks in the library; mark some on the Library page");

    const picks: typeof pool = [];
    let candidates = shuffle(pool);
    const taken = new Set<ArchetypeTag>(host.tags);
    while (picks.length < Math.min(count, freeSeats.length) && candidates.length) {
      // Fewest tags in common with the host's deck and the picks so far; ties broken by the shuffle.
      candidates.sort((a, b) => a.tags.filter((t) => taken.has(t)).length - b.tags.filter((t) => taken.has(t)).length);
      const pick = candidates.shift()!;
      picks.push(pick);
      for (const t of pick.tags) taken.add(t);
    }

    const out: AgentPick[] = [];
    const now = new Date().toISOString();
    picks.forEach((deck, i) => {
      const seat = freeSeats[i]!;
      const userId = randomUUID();
      const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)]!;
      const colors = Object.keys(AVATAR_COLORS);
      const color = colors[Math.floor(Math.random() * colors.length)]!;
      const name = botName(deck.commanders[0] ?? deck.name);
      const deckId = randomUUID();
      const detail = this.d.library.detail(deck.id)!;
      this.d.handle.sqlite.transaction(() => {
        this.d.handle.db.insert(users).values({ id: userId, displayName: name, avatar, color, isOwner: false, isAgent: true, createdAt: now, lastSeenAt: now }).run();
        // sourceUrl remembers which library deck this copy came from (primer, analysis, run history).
        this.d.handle.db.insert(decks).values({ id: deckId, userId, name: deck.name, format: "commander", sourceText: null, sourceUrl: `library:${deck.id}`, createdAt: now, updatedAt: now }).run();
        detail.cards
          .filter((c) => c.board === "main" || c.board === "commander")
          .forEach((c, position) => {
            this.d.handle.db.insert(deckCards).values({ deckId, cardId: c.cardId, quantity: c.quantity, board: c.board, category: null, position }).run();
          });
      })();
      room.join(userId);
      room.takeSeat(userId, seat, deckId);
      out.push({ userId, seat, name, libraryDeckId: deck.id, deckName: deck.name, commanders: deck.commanders, bracket: deck.bracket, tags: deck.tags });
    });
    room.broadcastRoom();
    return { agents: out, eligible };
  }

  // ------------------------------------------------------------ games

  /** Called when a game starts (or a rematch): one runner per seated agent. */
  onGameStarted(room: LiveRoom): void {
    if (!this.enabled) return;
    this.ensureRunning(room);
  }

  /** Start runners for every seated agent that has none yet (also used to resume after a restart). */
  ensureRunning(room: LiveRoom): void {
    if (!this.enabled) return;
    if (room.status !== "playing") return;
    const agents = this.agentMembers(room);
    if (agents.length === 0) return;
    const byRoom = this.runners.get(room.id) ?? new Map<string, AgentRunner>();
    this.runners.set(room.id, byRoom);
    const primers = loadPrimers();
    for (const { member, user } of agents) {
      if (byRoom.has(user.id)) continue;
      const deckRow = member.deckId ? this.d.handle.db.select().from(decks).where(eq(decks.id, member.deckId)).get() : undefined;
      const libId = deckRow?.sourceUrl?.startsWith("library:") ? deckRow.sourceUrl.slice("library:".length) : null;
      const lib = libId ? this.d.library.detail(libId) : null;
      const existing = this.d.handle.db.select().from(agentRuns).where(and(eq(agentRuns.roomId, room.id), eq(agentRuns.userId, user.id), eq(agentRuns.status, "running"))).get();
      const runId = existing?.id ?? randomUUID();
      if (!existing) {
        this.d.handle.db
          .insert(agentRuns)
          .values({
            id: runId,
            roomId: room.id,
            userId: user.id,
            seat: member.seat ?? 0,
            libraryDeckId: lib?.id ?? null,
            deckName: deckRow?.name ?? "deck",
            model: this.d.llm?.model ?? config.agentModel,
            mode: this.dryRun ? "dry_run" : "live",
            status: "running",
            startedAt: new Date().toISOString(),
          })
          .run();
      }
      const primer = lib ? (lib.primer.trim() || (lib.analysis ? primerSkeleton(lib.name, lib.analysis, this.d.analyzer.loadCardsByIds(this.d.library.entries(lib.id))) : "")) : "";
      const runner = new AgentRunner({
        room,
        me: user.id,
        name: user.displayName,
        deck: { name: deckRow?.name ?? "deck", commanders: lib?.commanders ?? [], primer },
        rulesPrimer: primers.rules,
        effectsPrimer: primers.effects,
        llm: this.d.llm,
        limits: { maxTokensPerDecision: config.agentMaxTokensPerDecision, decisionTimeoutMs: config.agentDecisionTimeoutMs, maxCallsPerTurn: config.agentMaxCallsPerTurn },
        log: this.d.log,
        agentIds: () => new Set(this.agentMembers(room).map((a) => a.user.id)),
        mayCall: () => this.mayCall(room.id),
        record: (d) => this.record(runId, room.id, d),
        onEnded: (reason) => {
          byRoom.delete(user.id);
          this.d.handle.db.update(agentRuns).set({ status: reason === "stopped" ? "stopped" : reason, stoppedReason: reason, endedAt: new Date().toISOString() }).where(eq(agentRuns.id, runId)).run();
          if (byRoom.size === 0) this.runners.delete(room.id);
        },
      });
      byRoom.set(user.id, runner);
      runner.start();
      this.d.log?.info({ room: room.code, agent: user.displayName, mode: this.dryRun ? "dry_run" : "live" }, "agent runner started");
    }
  }

  /** Stop every runner (server shutdown). */
  close(): void {
    for (const byRoom of this.runners.values()) for (const r of byRoom.values()) r.stop("stopped");
    this.runners.clear();
  }

  private record(runId: string, roomId: string, d: DecisionRecord): void {
    this.d.handle.sqlite.transaction(() => {
      this.d.handle.db
        .insert(agentDecisions)
        .values({
          runId,
          roomId,
          turn: d.turn,
          step: d.step,
          kind: d.kind,
          inputTokens: d.usage.input_tokens,
          outputTokens: d.usage.output_tokens,
          cacheReadTokens: d.usage.cache_read_input_tokens,
          cacheWriteTokens: d.usage.cache_creation_input_tokens,
          costUsd: d.costUsd,
          latencyMs: d.latencyMs,
          outcome: d.outcome,
          rationale: d.rationale,
          toolCalls: d.toolCalls,
          error: d.error ?? null,
          createdAt: new Date().toISOString(),
        })
        .run();
      this.d.handle.db
        .update(agentRuns)
        .set({
          decisions: sql`${agentRuns.decisions} + 1`,
          inputTokens: sql`${agentRuns.inputTokens} + ${d.usage.input_tokens}`,
          outputTokens: sql`${agentRuns.outputTokens} + ${d.usage.output_tokens}`,
          cacheReadTokens: sql`${agentRuns.cacheReadTokens} + ${d.usage.cache_read_input_tokens}`,
          cacheWriteTokens: sql`${agentRuns.cacheWriteTokens} + ${d.usage.cache_creation_input_tokens}`,
          costUsd: sql`${agentRuns.costUsd} + ${d.costUsd}`,
        })
        .where(eq(agentRuns.id, runId))
        .run();
    })();
  }

  // ------------------------------------------------------------ owner views

  roomAgents(room: LiveRoom): RoomAgentsResponse {
    const runs = this.d.handle.db.select().from(agentRuns).where(eq(agentRuns.roomId, room.id)).orderBy(agentRuns.seat).all();
    const userRows = runs.length ? this.d.handle.db.select().from(users).where(inArray(users.id, runs.map((r) => r.userId))).all() : [];
    const names = new Map(userRows.map((u) => [u.id, u.displayName]));
    const byRoom = this.runners.get(room.id);
    const info = room.info(null);
    const runsOut: AgentRunInfo[] = runs.map((r) => ({
      id: r.id,
      userId: r.userId,
      name: names.get(r.userId) ?? "agent",
      seat: r.seat,
      deckName: r.deckName,
      model: r.model,
      mode: r.mode as "live" | "dry_run",
      status: byRoom?.has(r.userId) ? "running" : r.status,
      decisions: r.decisions,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      stoppedReason: r.stoppedReason,
      thinking: info.members.find((m) => m.userId === r.userId)?.thinking ?? false,
    }));
    const decisionRows = runs.length ? this.d.handle.db.select().from(agentDecisions).where(eq(agentDecisions.roomId, room.id)).orderBy(desc(agentDecisions.id)).limit(60).all() : [];
    const runUser = new Map(runs.map((r) => [r.id, r.userId]));
    const decisions: AgentDecisionInfo[] = decisionRows.map((d) => ({
      id: d.id,
      userId: runUser.get(d.runId) ?? "",
      name: names.get(runUser.get(d.runId) ?? "") ?? "agent",
      turn: d.turn,
      step: d.step,
      kind: d.kind,
      outcome: d.outcome,
      rationale: d.rationale,
      toolCalls: (d.toolCalls as AgentDecisionInfo["toolCalls"]) ?? [],
      costUsd: d.costUsd,
      latencyMs: d.latencyMs,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      createdAt: d.createdAt,
    }));
    return { runs: runsOut, decisions, totalUsd: this.spendForRoom(room.id), maxUsdPerGame: config.agentMaxUsdPerGame };
  }

  recentGames(limit = 30): AgentGameSummary[] {
    const rows = this.d.handle.db
      .select({ roomId: agentRuns.roomId, code: rooms.code, status: rooms.status, startedAt: sql<string>`min(${agentRuns.startedAt})`, agents: sql<number>`count(*)`, decisions: sql<number>`sum(${agentRuns.decisions})`, costUsd: sql<number>`sum(${agentRuns.costUsd})`, deckNames: sql<string>`group_concat(${agentRuns.deckName}, '|')` })
      .from(agentRuns)
      .innerJoin(rooms, eq(rooms.id, agentRuns.roomId))
      .groupBy(agentRuns.roomId)
      .orderBy(desc(sql`min(${agentRuns.startedAt})`))
      .limit(limit)
      .all();
    return rows.map((r) => ({ roomId: r.roomId, code: r.code, status: r.status, startedAt: r.startedAt, agents: r.agents, decisions: r.decisions ?? 0, costUsd: Math.round((r.costUsd ?? 0) * 1e4) / 1e4, deckNames: (r.deckNames ?? "").split("|").filter(Boolean) }));
  }

  // ------------------------------------------------------------ primer drafting (Phase 6 hook)

  async draftPrimer(libraryDeckId: string, opts: { force?: boolean } = {}): Promise<{ primer: string; model: string; costUsd: number; cached: boolean }> {
    const row = this.d.library.getRow(libraryDeckId);
    if (!row) throw new RoomError("library deck not found");
    if (!opts.force && row.primerDraftedAt && row.primer.trim()) return { primer: row.primer, model: row.primerModel ?? "", costUsd: 0, cached: true };
    if (!this.d.llm) throw new RoomError("no model configured (dry run): set ANTHROPIC_API_KEY");
    const day = this.spendToday();
    if (day >= config.agentMaxUsdPerDay) throw new RoomError(`daily spending cap reached ($${day.toFixed(2)})`);
    const detail = this.d.library.detail(libraryDeckId)!;
    const cards = this.d.analyzer.loadCardsByIds(this.d.library.entries(libraryDeckId));
    const analysis = detail.analysis ?? (await this.d.analyzer.analyze(cards, { combos: "cached" })).analysis;
    const skeleton = primerSkeleton(detail.name, analysis, cards);
    const list = cards.map((c) => `${c.quantity > 1 ? `${c.quantity}x ` : ""}${c.name}${c.board === "commander" ? " (commander)" : ""} [${c.typeLine}] ${c.manaCost} - ${c.oracleText.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
    const system =
      "You write concise Commander deck primers for a computer pilot. Keep EXACTLY these Markdown headings, in this order: '## Archetype', '## Game plan', '## Win conditions', '## Key synergies', '## Game Changers', '## Combos', '## Early turns', '## Weaknesses', '## Agent notes'. Replace every '(fill in ...)' placeholder with real guidance from the decklist. Be specific: name cards, say what to hold, what to mulligan for, which lines win. Under 700 words. No preamble.";
    const user = `Deck: ${detail.name}\nBracket ${detail.bracket}; engine analysis summary: ${analysis.summary}\n\nSkeleton to fill:\n${skeleton}\n\nDecklist:\n${list}`;
    const res = await this.d.llm.complete({ system, messages: [{ role: "user", content: user }], tools: [], maxTokens: 2500, timeoutMs: 120_000 });
    const text = res.content
      .filter((b): b is Extract<(typeof res.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const costUsd = costOf(this.d.llm.model, res.usage);
    this.addDraftSpend(costUsd);
    if (!text || res.stopReason === "refusal") throw new RoomError("the model returned no primer");
    this.d.handle.db.update(libraryDecks).set({ primer: text, primerDraftedAt: new Date().toISOString(), primerModel: this.d.llm.model, updatedAt: new Date().toISOString() }).where(eq(libraryDecks.id, libraryDeckId)).run();
    return { primer: text, model: this.d.llm.model, costUsd, cached: false };
  }
}

/** "Krenko, Mob Boss" -> "Krenko bot" (display names are capped at 24 characters). */
export function botName(commander: string): string {
  const first = commander.split(/[,\s]/)[0] || "Deck";
  return `${first.slice(0, 19)} bot`;
}

/** Members of a room that are agents (used by routes to hide the control for humans). */
export function isAgentUserRow(handle: DbHandle, userId: string): boolean {
  const u = handle.db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId)).get();
  return Boolean(u?.isAgent);
}

