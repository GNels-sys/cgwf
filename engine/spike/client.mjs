#!/usr/bin/env node
// Scripted human seat for the bridge spike. Connects to the engine, starts a four-seat Commander
// game (this client = one seat, three Forge AIs), answers every prompt with a simple policy and
// prints a summary when the game ends. No dependencies: Node 22+ has a global WebSocket.
//
//   node engine/spike/client.mjs [ws://localhost:8081] [--seat 0] [--seed 42] [--name Georgie]
//                                [--concede-after-turn N] [--quiet] [--dump-dir DIR]
//
// Policy: play a land when offered; cast at most two spells per step (cheapest first, never
// activated abilities, so the loop cannot spin); attack with every creature that may attack a
// player, at the lowest-life opponent; block the biggest attacker with a creature that survives it;
// first option for every other choice; always keep the opening hand.

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("ws")) ?? "ws://localhost:8081";
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const seat = Number(opt("seat", 0));
const seed = Number(opt("seed", 42));
const name = opt("name", "Georgie");
const concedeAfterTurn = Number(opt("concede-after-turn", 0));
const quiet = args.includes("--quiet");
const dumpDir = opt("dump-dir", null);

const stats = {
  prompts: {}, landsPlayed: 0, spellsCast: 0, attacksDeclared: 0, blocksDeclared: 0,
  statesReceived: 0, turnsSeen: 0, errors: [], startedAt: Date.now(), firstPromptMs: null, maxTurnSeen: 0,
};
const castPerStep = new Map();
let you = null;
let conceded = false;
let frames = 0;

const log = (...a) => { if (!quiet) console.error(`[client]`, ...a); };
const ws = new WebSocket(url);
const send = (o) => ws.send(JSON.stringify(o));

function myPlayer(view) { return view.players.find((p) => p.id === you); }
function opponents(view) { return view.players.filter((p) => p.id !== you && !p.lost); }

function answerPriority(m) {
  const view = m.view;
  stats.maxTurnSeen = Math.max(stats.maxTurnSeen, view.turn);
  if (concedeAfterTurn && view.turn >= concedeAfterTurn && !conceded) {
    conceded = true;
    log(`turn ${view.turn}: conceding as instructed`);
    return { concede: true };
  }
  const opts = m.options ?? [];
  const land = opts.find((o) => o.kind === "land");
  if (land) { stats.landsPlayed++; return { option: land.index }; }
  const key = `${view.turn}:${view.phase}`;
  const already = castPerStep.get(key) ?? 0;
  if (already < 2) {
    const spells = opts.filter((o) => o.kind === "spell").sort((a, b) => (a.cost ?? "").length - (b.cost ?? "").length);
    if (spells.length) {
      castPerStep.set(key, already + 1);
      stats.spellsCast++;
      return { option: spells[0].index };
    }
  }
  return { option: null }; // pass
}

function answerTargets(m) {
  const opts = m.options ?? [];
  const foes = opts.filter((o) => (o.kind === "player" && o.id !== you) || (o.kind === "card" && o.controller !== you));
  const pool = foes.length ? foes : opts;
  const n = Math.max(1, m.min ?? 1);
  return { options: pool.slice(0, n).map((o) => o.index) };
}

function answerAttackers(m) {
  const view = m.view;
  const players = (m.defenders ?? []).filter((d) => d.kind === "player");
  const target = players.sort((a, b) => (a.life ?? 99) - (b.life ?? 99))[0];
  const attacks = [];
  for (const c of m.candidates ?? []) {
    const ok = (c.canAttack ?? []).find((d) => d.kind === "player" && target && d.id === target.id) ?? (c.canAttack ?? [])[0];
    if (ok && (c.power ?? 0) > 0) attacks.push({ cardId: c.id, defender: { kind: ok.kind, id: ok.id } });
  }
  if (attacks.length) stats.attacksDeclared++;
  return { attacks };
}

function answerBlockers(m) {
  const attackers = [...(m.attackers ?? [])].sort((a, b) => (b.power ?? 0) - (a.power ?? 0));
  const used = new Set();
  const blocks = [];
  for (const att of attackers) {
    const b = (m.blockers ?? []).find((x) => !used.has(x.id) && (x.canBlock ?? []).includes(att.id) && (x.toughness ?? 0) > (att.power ?? 0));
    if (b) { used.add(b.id); blocks.push({ blockerId: b.id, attackerId: att.id }); }
  }
  if (blocks.length) stats.blocksDeclared++;
  return { blocks };
}

function answer(m) {
  stats.prompts[m.prompt] = (stats.prompts[m.prompt] ?? 0) + 1;
  if (stats.firstPromptMs === null) stats.firstPromptMs = Date.now() - stats.startedAt;
  switch (m.prompt) {
    case "priority": return answerPriority(m);
    case "targets": return answerTargets(m);
    case "attackers": return answerAttackers(m);
    case "blockers": return answerBlockers(m);
    case "choose": return { option: (m.options ?? []).length ? 0 : null };
    case "chooseMany": return { options: (m.options ?? []).slice(0, Math.max(0, m.min ?? 0)).map((o) => o.index) };
    case "confirm": return { confirm: true };
    case "mulligan": return { keep: true };
    default: return {};
  }
}

let dumpFs = null;
if (dumpDir) {
  dumpFs = await import("node:fs");
  dumpFs.mkdirSync(dumpDir, { recursive: true });
}

ws.addEventListener("open", () => {
  log(`connected to ${url}; starting game seat=${seat} seed=${seed}`);
  send({ type: "start", seat, seed, name });
});
ws.addEventListener("error", (e) => { console.error("[client] socket error", e.message ?? e); process.exit(2); });
ws.addEventListener("close", () => { log("socket closed"); });

let lastTurn = 0;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  frames++;
  if (dumpFs && frames <= 400) dumpFs.writeFileSync(`${dumpDir}/${String(frames).padStart(4, "0")}-${m.type}${m.prompt ? "-" + m.prompt : ""}.json`, JSON.stringify(m, null, 1));
  switch (m.type) {
    case "hello": log(`engine hello: forge ${m.forge}, ready=${m.ready}`); break;
    case "started": you = m.you; log(`started: you are player ${you}; seats: ${m.players.map((p) => `${p.name} [${p.deck}]`).join(", ")}`); break;
    case "state": {
      stats.statesReceived++;
      if (m.turn !== lastTurn) {
        lastTurn = m.turn;
        stats.turnsSeen++;
        const me = myPlayer(m);
        log(`turn ${m.turn} (${m.players.find((p) => p.id === m.activePlayer)?.name}); lives ${m.players.map((p) => `${p.name.split(" ")[0]}=${p.life}`).join(" ")}; my hand ${me?.hand?.length ?? "?"}, bf ${me?.battlefield?.length ?? "?"}`);
      }
      break;
    }
    case "prompt": {
      const reply = answer(m);
      send({ type: "answer", promptId: m.promptId, ...reply });
      break;
    }
    case "error": stats.errors.push(m.message); log(`engine error: ${m.message}`); break;
    case "gameOver": {
      const me = myPlayer(m);
      const result = {
        winner: m.winner, endReason: m.endReason, turns: m.turn, iLost: me?.lost ?? null, myLife: me?.life,
        wallSeconds: Math.round((Date.now() - stats.startedAt) / 100) / 10, ...stats,
      };
      console.log(JSON.stringify(result, null, 2));
      ws.close();
      process.exit(0);
    }
    default: break;
  }
});
