/**
 * Admin command line. Usage:
 *   node server/dist/cli.js ingest [--force] [--file path/to/cards.json]
 *   node server/dist/cli.js import-precons [--force] [--no-combos]
 *   node server/dist/cli.js agent-game [--agents 2] [--bracket 2] [--rounds 3]
 *
 * `agent-game` is the Phase 7 smoke test: it opens the database in this
 * process, seats a scripted human plus N computer opponents on a fresh table,
 * lets the agents play `rounds` turns each with the real model (the machine's
 * ANTHROPIC_API_KEY; dry run without it), prints every decision with its cost
 * and latency, then ends the game. Spends real money, under the usual caps.
 *
 * If the server is running on this machine the command asks it to do the work
 * (so only one process touches the database); otherwise `ingest` runs locally.
 * `import-precons` needs the running server (it is what the owner runs through
 * `fly ssh console` after a deploy); it polls progress until the import ends.
 */
import { isOut } from "@cgwf/shared";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const fileIdx = rest.indexOf("--file");
const file = fileIdx >= 0 ? rest[fileIdx + 1] : undefined;
const force = flags.has("--force");
const base = `http://127.0.0.1:${config.port}`;

if (command !== "ingest" && command !== "import-precons" && command !== "agent-game") {
  console.error("usage: cli ingest [--force] [--file cards.json] | cli import-precons [--force] [--no-combos] | cli agent-game [--agents N] [--bracket B] [--rounds R]");
  process.exit(2);
}

function numFlag(name: string, fallback: number): number {
  const i = rest.indexOf(name);
  const v = i >= 0 ? Number(rest[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

async function agentGame(): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { agentDecisions, deckCards, decks, users } = await import("./db/schema.js");
  const ctx = await buildApp({ logger: false, agentsEnabled: true });
  const { handle, roomsManager, agents, library } = ctx;
  const count = Math.max(1, Math.min(3, numFlag("--agents", 2)));
  const bracket = Math.max(1, Math.min(5, numFlag("--bracket", 2))) as 1 | 2 | 3 | 4 | 5;
  const rounds = Math.max(1, Math.min(10, numFlag("--rounds", 3)));
  console.log(`agent smoke test: ${count} agent(s), bracket ${bracket}, ${rounds} round(s), mode ${agents.dryRun ? "DRY RUN (no key)" : agents.status().model}`);

  // A scripted human: keeps, passes every turn. Its deck is a copy of any eligible library deck.
  const pool = library.list({ agentEligible: true });
  if (pool.length === 0) throw new Error("no agent-eligible library decks; mark some on the Library page first");
  const hostDeckSrc = library.detail(pool[0]!.id)!;
  const hostId = randomUUID();
  const hostDeckId = randomUUID();
  const now = new Date().toISOString();
  handle.db.insert(users).values({ id: hostId, displayName: "Smoke host", avatar: "owl", color: "slate", isOwner: false, isAgent: false, createdAt: now, lastSeenAt: now }).run();
  handle.db.insert(decks).values({ id: hostDeckId, userId: hostId, name: `${hostDeckSrc.name} (smoke host)`, format: "commander", sourceText: null, sourceUrl: null, createdAt: now, updatedAt: now }).run();
  hostDeckSrc.cards.filter((c) => c.board !== "sideboard").forEach((c, position) => handle.db.insert(deckCards).values({ deckId: hostDeckId, cardId: c.cardId, quantity: c.quantity, board: c.board, category: null, position }).run());

  const room = roomsManager.create(hostId);
  room.takeSeat(hostId, 0, hostDeckId);
  const picks = await agents.addAgents(room, hostId, { count, bracket });
  for (const p of picks.agents) console.log(`  ${p.name} (seat ${p.seat + 1}): ${p.deckName} [${p.tags.join(", ")}]`);
  room.start(hostId);
  agents.onGameStarted(room);
  console.log(`room ${room.code} started`);

  const started = Date.now();
  let seen = 0;
  let hostTurns = 0;
  const deadline = Date.now() + 25 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const s = room.currentState();
    if (!s) continue;
    if (s.phase === "mulligan" && !s.players[hostId]!.kept) room.submit(hostId, { type: "HandKept", payload: { player: hostId } });
    if (s.phase === "playing" && s.activePlayer === hostId && s.step === "untap") {
      hostTurns++;
      if (hostTurns > rounds) break;
      room.submit(hostId, { type: "TurnAdvanced", payload: {} });
    }
    const rows = handle.db.select().from(agentDecisions).where(eq(agentDecisions.roomId, room.id)).all();
    for (const d of rows.slice(seen)) {
      const calls = (d.toolCalls as Array<{ name: string; ok: boolean; error?: string }>).map((c) => `${c.name}${c.ok ? "" : `✗(${c.error ?? ""})`}`).join(", ");
      console.log(`  [T${d.turn} ${d.step} ${d.kind}] ${d.outcome} ${(d.latencyMs / 1000).toFixed(1)}s $${d.costUsd.toFixed(4)} in=${d.inputTokens} cache=${d.cacheReadTokens} out=${d.outputTokens} | ${d.rationale.slice(0, 110)} | ${calls}`);
    }
    seen = rows.length;
    if (s.phase === "ended" || Date.now() > deadline) break;
  }
  agents.close();
  const final = room.currentState();
  if (final && final.phase !== "ended") {
    // End the table: the human and then each agent but the last concede.
    const alive = final.turnOrder.filter((id) => !isOut(final.players[id]!));
    for (const id of alive.slice(0, -1)) {
      try {
        room.submit(id, { type: "PlayerConceded", payload: { player: id } });
      } catch {
        /* already over */
      }
    }
  }
  const rows = handle.db.select().from(agentDecisions).where(eq(agentDecisions.roomId, room.id)).all();
  const model = rows.filter((d) => d.kind === "turn" || d.kind === "trigger");
  const cost = rows.reduce((n, d) => n + d.costUsd, 0);
  const lat = model.length ? model.reduce((n, d) => n + d.latencyMs, 0) / model.length : 0;
  const outcomes = model.reduce<Record<string, number>>((acc, d) => ((acc[d.outcome] = (acc[d.outcome] ?? 0) + 1), acc), {});
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s: ${model.length} model decisions, $${cost.toFixed(4)} total, avg latency ${(lat / 1000).toFixed(1)}s, outcomes ${JSON.stringify(outcomes)}`);
  console.log(`log tail:\n  ${(room.currentState()?.log ?? []).slice(-12).map((l) => l.text).join("\n  ")}`);
  await ctx.app.close();
}

if (command === "agent-game") {
  await agentGame();
  process.exit(0);
}

async function viaRunningServer(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/admin/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (res.status === 202) {
      console.log("ingest started on the running server; watch /api/status for progress");
      return true;
    }
    if (res.status === 409) {
      console.log("server says an ingest is already running");
      return true;
    }
    console.error(`server answered ${res.status}; falling back to a local run`);
    return false;
  } catch {
    return false;
  }
}

async function importPrecons(): Promise<void> {
  const res = await fetch(`${base}/api/admin/import-precons`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force, combos: !flags.has("--no-combos") }),
  });
  if (res.status !== 202 && res.status !== 409) {
    console.error(`server answered ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  console.log(res.status === 409 ? "an import is already running; following it" : "precon import started");
  let last = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = (await (await fetch(`${base}/api/admin/import-status`)).json()) as { importState: { running: boolean; phase: string; total: number; done: number; imported: number; skipped: number; errors: string[]; error: string | null } };
    const s = status.importState;
    const line = `${s.phase} ${s.done}/${s.total} imported=${s.imported} skipped=${s.skipped} errors=${s.errors.length}`;
    if (line !== last) console.log(line);
    last = line;
    if (!s.running) {
      for (const e of s.errors) console.log(`  problem: ${e}`);
      if (s.error) {
        console.error(`import failed: ${s.error}`);
        process.exit(1);
      }
      return;
    }
  }
}

if (command === "import-precons") {
  await importPrecons();
  process.exit(0);
}

if (!file && (await viaRunningServer())) process.exit(0);

const { app, ingestor } = await buildApp({ logger: "plain" });
const opts: { force: boolean; file?: string } = { force };
if (file) opts.file = file;
await ingestor.run(opts);
await app.close();
if (ingestor.state.phase === "error") {
  console.error(`ingest failed: ${ingestor.state.error}`);
  process.exit(1);
}
console.log(`done: ${ingestor.cardCount()} cards`);
