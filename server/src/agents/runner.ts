import type Anthropic from "@anthropic-ai/sdk";
import type { FastifyBaseLogger } from "fastify";
import { viewFor, type CardPrinting, type EventInput, type GameState, type PlayerId, type PlayerView } from "@cgwf/shared";
import { RoomError, type LiveRoom } from "../rooms/live.js";
import type { Llm } from "./llm.js";
import { cardsToBottom, dryRunTriggers, dryRunTurn, shouldMulligan, type ToolCall } from "./policy.js";
import { costOf } from "./pricing.js";
import { renderDelta, renderState, systemPrompt, turnInstruction, type PromptDeck } from "./prompt.js";
import { AGENT_TOOLS, mapToolCall, TOOL_NAMES } from "./tools.js";

/**
 * One computer opponent in one room. It subscribes to the room's state
 * changes, builds ITS OWN view with viewFor(state, me) - the same filter a
 * human client gets - and acts through room.submit(me, event), the same
 * validated path as a WebSocket client. The true state never reaches the
 * prompt builder: only `view` and `printings` do (prompt.ts), which
 * prompt.test.ts proves.
 */
export interface DecisionRecord {
  kind: "turn" | "trigger" | "mulligan" | "bottom";
  turn: number;
  step: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  costUsd: number;
  latencyMs: number;
  outcome: "ok" | "invalid" | "timeout" | "error" | "capped" | "dry_run" | "refusal" | "rule";
  rationale: string;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; error?: string }>;
  error?: string | undefined;
}

export interface RunnerLimits {
  maxTokensPerDecision: number;
  decisionTimeoutMs: number;
  maxCallsPerTurn: number;
}

export interface RunnerDeps {
  room: LiveRoom;
  me: PlayerId;
  name: string;
  deck: PromptDeck;
  rulesPrimer: string;
  effectsPrimer: string;
  /** null = dry run (scripted policy, no model). */
  llm: Llm | null;
  limits: RunnerLimits;
  log: FastifyBaseLogger | null;
  /** Other computer players at the table (for attack damage). */
  agentIds: () => ReadonlySet<PlayerId>;
  /** Spend control: true when this run may make another model call. Returns the reason when not. */
  mayCall: () => { ok: true } | { ok: false; reason: string };
  record: (d: DecisionRecord) => void;
  onEnded: (reason: "ended" | "capped" | "error" | "stopped") => void;
}

type Printings = Record<string, CardPrinting>;

export class AgentRunner {
  private unsubscribe: (() => void) | null = null;
  private busy = false;
  private pending: GameState | null = null;
  private latest: GameState | null = null;
  private turnHandled = 0;
  private triggerSeqHandled = 0;
  private enteredThisTurn = new Set<string>();
  private stopped = false;
  private invalidStreak = 0;

  constructor(private readonly d: RunnerDeps) {}

  get me(): PlayerId {
    return this.d.me;
  }

  start(): void {
    this.unsubscribe = this.d.room.onState((s) => this.schedule(s));
    this.d.room.setAgentPresence(this.d.me, { thinking: false });
    const current = this.d.room.currentState();
    if (current) this.schedule(current);
  }

  stop(reason: "ended" | "capped" | "error" | "stopped" = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.d.room.setAgentPresence(this.d.me, null);
    this.d.onEnded(reason);
  }

  private schedule(state: GameState): void {
    if (this.stopped) return;
    this.latest = state;
    if (this.busy) {
      this.pending = state;
      return;
    }
    this.busy = true;
    void this.act(state)
      .catch((err) => this.d.log?.error({ err, agent: this.d.name }, "agent runner failed"))
      .finally(() => {
        this.busy = false;
        const next = this.pending;
        this.pending = null;
        if (next && !this.stopped) this.schedule(next);
      });
  }

  private viewNow(): { view: PlayerView; printings: Printings } {
    const state = this.latest ?? this.d.room.currentState();
    if (!state) throw new Error("no game state");
    const { view, printings } = viewFor(state, this.d.me);
    return { view, printings: Object.fromEntries(printings) };
  }

  private submit(ev: EventInput): void {
    this.d.room.submit(this.d.me, ev);
  }

  private async act(state: GameState): Promise<void> {
    const { view, printings } = (() => {
      const { view, printings } = viewFor(state, this.d.me);
      return { view, printings: Object.fromEntries(printings) };
    })();
    const me = view.players[this.d.me];
    if (!me) return;
    if (view.phase === "ended" || me.conceded) {
      this.stop("ended");
      return;
    }
    if (view.phase === "mulligan") {
      if (!me.kept) this.mulligan(view, printings);
      return;
    }
    if (me.toBottom > 0) {
      this.bottom(view, printings, me.toBottom);
      return;
    }
    if (view.phase !== "playing") return;
    if (view.activePlayer === this.d.me) {
      if (this.turnHandled === view.turn) return;
      this.turnHandled = view.turn;
      this.enteredThisTurn = new Set();
      await this.playTurn();
      return;
    }
    const triggers = view.pendingTriggers.filter((t) => t.controller === this.d.me);
    if (triggers.length && triggers.some((t) => t.seq > this.triggerSeqHandled)) {
      this.triggerSeqHandled = Math.max(...triggers.map((t) => t.seq));
      await this.handleTriggers();
    }
  }

  // ------------------------------------------------------------ mulligan (rule-based, no model)

  private mulligan(view: PlayerView, printings: Printings): void {
    const me = view.players[this.d.me]!;
    const mull = shouldMulligan(me.hand.cards, printings, me.mulligans);
    const ev = mull ? { type: "Mulligan" as const, payload: { player: this.d.me } } : { type: "HandKept" as const, payload: { player: this.d.me } };
    this.safeSubmit(ev);
    this.d.record({ kind: "mulligan", turn: view.turn, step: view.step, usage: zeroUsage(), costUsd: 0, latencyMs: 0, outcome: "rule", rationale: mull ? "mulligan: land count off" : "kept", toolCalls: [] });
  }

  private bottom(view: PlayerView, printings: Printings, n: number): void {
    const me = view.players[this.d.me]!;
    const picks = cardsToBottom(me.hand.cards, printings, n);
    for (const c of picks) this.safeSubmit({ type: "CardMoved", payload: { iid: c.iid, to: { kind: "library", owner: this.d.me, position: "bottom" } } });
    this.d.record({ kind: "bottom", turn: view.turn, step: view.step, usage: zeroUsage(), costUsd: 0, latencyMs: 0, outcome: "rule", rationale: `bottomed ${picks.length}`, toolCalls: [] });
  }

  private safeSubmit(ev: EventInput): string | null {
    try {
      this.submit(ev);
      return null;
    } catch (err) {
      const msg = err instanceof RoomError ? err.message : err instanceof Error ? err.message : String(err);
      this.d.log?.warn({ err: msg, type: ev.type, agent: this.d.name }, "agent event refused");
      return msg;
    }
  }

  // ------------------------------------------------------------ the turn

  private async playTurn(): Promise<void> {
    // The table does the mechanical start of the turn: untap happened on TurnAdvanced and the reducer
    // draws the turn's card when the step reaches or passes "draw", so jumping to main1 is enough.
    let { view, printings } = this.viewNow();
    if (view.step === "untap" || view.step === "upkeep" || view.step === "draw") {
      this.safeSubmit({ type: "StepSet", payload: { step: "main1" } });
      ({ view, printings } = this.viewNow());
    }
    const system = this.system();
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `${renderState(view, printings, this.d.me)}\n\n${turnInstruction("turn")}` }];
    let nudged = false;
    this.invalidStreak = 0;
    for (let call = 0; call < this.d.limits.maxCallsPerTurn; call++) {
      const gate = this.d.mayCall();
      if (!gate.ok) {
        this.capped(gate.reason);
        return;
      }
      const outcome = await this.decide("turn", system, messages, view, printings);
      if (outcome.kind === "fatal") {
        this.endTurn(outcome.note);
        return;
      }
      if (outcome.kind === "no_tools") {
        if (nudged) {
          this.endTurn("(no action chosen)");
          return;
        }
        nudged = true;
        messages.push({ role: "assistant", content: outcome.assistant });
        messages.push({ role: "user", content: "Use the tools to act, or call pass_turn to end your turn." });
        continue;
      }
      messages.push({ role: "assistant", content: outcome.assistant });
      ({ view, printings } = this.viewNow());
      if (outcome.ended) return;
      if (view.activePlayer !== this.d.me || view.phase !== "playing") return;
      if (this.invalidStreak >= 3) {
        this.endTurn("(too many invalid actions)");
        return;
      }
      messages.push({ role: "user", content: [...outcome.results, { type: "text", text: `${renderDelta(view, printings, this.d.me)}\n\n${turnInstruction("continue")}` }] });
    }
    this.endTurn("(turn limit reached)");
  }

  private async handleTriggers(): Promise<void> {
    const { view, printings } = this.viewNow();
    const gate = this.d.mayCall();
    if (!gate.ok) {
      this.safeSubmit({ type: "TriggersDismissed", payload: { player: this.d.me } });
      return;
    }
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `${renderState(view, printings, this.d.me)}\n\n${turnInstruction("trigger")}` }];
    const outcome = await this.decide("trigger", this.system(), messages, view, printings);
    const after = this.viewNow().view;
    if (outcome.kind !== "ok" || after.pendingTriggers.some((t) => t.controller === this.d.me)) {
      this.safeSubmit({ type: "TriggersDismissed", payload: { player: this.d.me } });
    }
  }

  private endTurn(note: string): void {
    const { view } = this.viewNow();
    if (view.activePlayer !== this.d.me || view.phase !== "playing") return;
    if (note) this.safeSubmit({ type: "NoteAdded", payload: { player: this.d.me, text: `passes ${note}` } });
    this.safeSubmit({ type: "TurnAdvanced", payload: {} });
  }

  private capped(reason: string): void {
    this.safeSubmit({ type: "NoteAdded", payload: { player: this.d.me, text: `stops playing: ${reason}` } });
    this.safeSubmit({ type: "PlayerConceded", payload: { player: this.d.me } });
    this.d.record({ kind: "turn", turn: this.viewNow().view.turn, step: this.viewNow().view.step, usage: zeroUsage(), costUsd: 0, latencyMs: 0, outcome: "capped", rationale: reason, toolCalls: [] });
    this.stop("capped");
  }

  private system(): string {
    return systemPrompt({ agentName: this.d.name, rulesPrimer: this.d.rulesPrimer, effectsPrimer: this.d.effectsPrimer, deck: this.d.deck });
  }

  // ------------------------------------------------------------ one decision = one model call (or one scripted batch)

  private async decide(
    kind: "turn" | "trigger",
    system: string,
    messages: Anthropic.MessageParam[],
    view: PlayerView,
    printings: Printings,
  ): Promise<{ kind: "ok"; assistant: Anthropic.ContentBlock[]; results: Anthropic.ToolResultBlockParam[]; ended: boolean } | { kind: "no_tools"; assistant: Anthropic.ContentBlock[] } | { kind: "fatal"; note: string }> {
    const started = Date.now();
    this.d.room.setAgentPresence(this.d.me, { thinking: true });
    try {
      let content: Anthropic.ContentBlock[];
      let usage = zeroUsage();
      let costUsd = 0;
      let outcome: DecisionRecord["outcome"] = "ok";
      if (!this.d.llm) {
        const calls = kind === "turn" ? dryRunTurn({ me: this.d.me, view, printings, enteredThisTurn: this.enteredThisTurn }) : dryRunTriggers({ me: this.d.me, view, printings, enteredThisTurn: this.enteredThisTurn });
        content = [{ type: "text", text: "dry run", citations: null } as Anthropic.TextBlock, ...calls.map((c, i) => ({ type: "tool_use", id: `dry_${view.seq}_${i}`, name: c.name, input: c.input }) as Anthropic.ToolUseBlock)];
        outcome = "dry_run";
      } else {
        try {
          const res = await this.d.llm.complete({ system, messages, tools: AGENT_TOOLS, maxTokens: this.d.limits.maxTokensPerDecision, timeoutMs: this.d.limits.decisionTimeoutMs });
          usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0, cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0 };
          costUsd = costOf(this.d.llm.model, usage);
          content = res.content;
          if (res.stopReason === "refusal") {
            this.d.record({ kind, turn: view.turn, step: view.step, usage, costUsd, latencyMs: Date.now() - started, outcome: "refusal", rationale: textOf(content), toolCalls: [], error: res.stopCategory ?? "refusal" });
            return { kind: "fatal", note: "(the model declined)" };
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const timeout = /timeout|timed out|aborted/i.test(msg);
          this.d.log?.warn({ err: msg, agent: this.d.name }, "agent model call failed");
          this.d.record({ kind, turn: view.turn, step: view.step, usage, costUsd, latencyMs: Date.now() - started, outcome: timeout ? "timeout" : "error", rationale: "", toolCalls: [], error: msg.slice(0, 500) });
          return { kind: "fatal", note: timeout ? "(timed out)" : "(model error)" };
        }
      }

      const toolUses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const rationale = textOf(content);
      const results: Anthropic.ToolResultBlockParam[] = [];
      const calls: DecisionRecord["toolCalls"] = [];
      let ended = false;
      let current = { view, printings };
      for (const tu of toolUses) {
        if (ended) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "ignored: the turn already ended", is_error: true });
          calls.push({ name: tu.name, input: tu.input, ok: false, error: "after pass_turn" });
          continue;
        }
        const input = (tu.input && typeof tu.input === "object" ? tu.input : {}) as Record<string, unknown>;
        const mapped = TOOL_NAMES.has(tu.name) ? mapToolCall(tu.name, input, { me: this.d.me, view: current.view, printings: current.printings, agentIds: this.d.agentIds() }) : ({ ok: false, error: `unknown tool ${tu.name}` } as const);
        if (!mapped.ok) {
          this.invalidStreak++;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `error: ${mapped.error}`, is_error: true });
          calls.push({ name: tu.name, input: tu.input, ok: false, error: mapped.error });
          continue;
        }
        let error: string | null = null;
        for (const ev of mapped.call.events) {
          error = this.safeSubmit(ev);
          if (error) break;
          if (ev.type === "CardMoved" && ev.payload.to.kind === "battlefield") this.enteredThisTurn.add(ev.payload.iid);
        }
        if (error) {
          this.invalidStreak++;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: `error: ${error}`, is_error: true });
          calls.push({ name: tu.name, input: tu.input, ok: false, error });
          continue;
        }
        this.invalidStreak = 0;
        current = this.viewNow();
        let text = `ok: ${mapped.call.summary}`;
        if (mapped.call.resultHint === "library") {
          const known = current.view.players[this.d.me]?.library.known ?? [];
          text += `\nYour library (top first): ${known.map((c) => `${c.iid} ${c.printingId ? (current.printings[c.printingId]?.name ?? "?") : "?"}`).join(", ") || "(empty)"}`;
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
        calls.push({ name: tu.name, input: tu.input, ok: true });
        if (mapped.call.endsTurn) ended = true;
      }
      this.d.record({ kind, turn: view.turn, step: view.step, usage, costUsd, latencyMs: Date.now() - started, outcome: outcome === "dry_run" ? "dry_run" : calls.some((c) => !c.ok) && !calls.some((c) => c.ok) ? "invalid" : "ok", rationale, toolCalls: calls });
      if (toolUses.length === 0) return { kind: "no_tools", assistant: content };
      return { kind: "ok", assistant: content, results, ended };
    } finally {
      if (!this.stopped) this.d.room.setAgentPresence(this.d.me, { thinking: false });
    }
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 400);
}

function zeroUsage(): DecisionRecord["usage"] {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}
