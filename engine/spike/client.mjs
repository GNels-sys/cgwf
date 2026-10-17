#!/usr/bin/env node
// Fake CGwF server for the engine's control socket: creates a four-seat Commander game with the
// deck files in spike/decks (seat 0 = scripted human, others = Forge AI), answers every prompt
// for seat 0 with a simple policy and prints a summary when the game ends.
//
//   node engine/spike/client.mjs [ws://localhost:8081] [--token T] [--seed 42] [--name Georgie]
//                                [--humans 1] [--concede-after-turn N] [--quiet] [--dump-dir DIR]
//
// Policy: play a land when offered; cast at most two spells per step (cheapest first, never
// activated abilities); attack the lowest-life opponent with everything that has power; block
// the biggest attacker with a creature that survives it; first option for every other choice;
// always keep. Needs the `ws` package (present in the repo's node_modules).

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("ws")) ?? "ws://localhost:8081";
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const token = opt("token", process.env.ENGINE_TOKEN ?? "");
const seed = Number(opt("seed", 42));
const name = opt("name", "Georgie");
const humans = Number(opt("humans", 1));
const concedeAfterTurn = Number(opt("concede-after-turn", 0));
const quiet = args.includes("--quiet");
const dumpDir = opt("dump-dir", null);
const gameId = `spike-${Date.now()}`;

const deckFiles = readdirSync(join(here, "decks")).filter((f) => f.endsWith(".json")).sort().slice(0, 4);
const decks = deckFiles.map((f) => JSON.parse(readFileSync(join(here, "decks", f), "utf8")));

const stats = { prompts: {}, landsPlayed: 0, spellsCast: 0, attacksDeclared: 0, blocksDeclared: 0, states: 0, logs: 0, errors: [], startedAt: Date.now(), firstPromptMs: null };
const castPerStep = new Map();
let myPlayerId = null;
let conceded = false;
let frames = 0;
let lastTurn = 0;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });

const log = (...a) => { if (!quiet) console.error("[client]", ...a); };
const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const send = (o) => ws.send(JSON.stringify(o));

function answerPriority(m) {
  const view = m.view;
  if (concedeAfterTurn && view.turn >= concedeAfterTurn && !conceded) {
    conceded = true;
    return { concede: true };
  }
  const opts = m.options ?? [];
  const land = opts.find((o) => o.kind === "land");
  if (land) { stats.landsPlayed++; return { option: land.index }; }
  const key = `${view.turn}:${view.phase}`;
  const already = castPerStep.get(key) ?? 0;
  if (already < 2 && m.stackEmpty) {
    const spells = opts.filter((o) => o.kind === "spell").sort((a, b) => (a.cost ?? "").length - (b.cost ?? "").length);
    if (spells.length) { castPerStep.set(key, already + 1); stats.spellsCast++; return { option: spells[0].index }; }
  }
  return { option: null };
}
function answerTargets(m) {
  const opts = m.options ?? [];
  const foes = opts.filter((o) => (o.kind === "player" && o.id !== myPlayerId) || (o.kind === "card" && o.controller !== myPlayerId));
  const pool = foes.length ? foes : opts;
  return { options: pool.slice(0, Math.max(1, m.min ?? 1)).map((o) => o.index) };
}
function answerAttackers(m) {
  const players = (m.defenders ?? []).filter((d) => d.kind === "player").sort((a, b) => (a.life ?? 99) - (b.life ?? 99));
  const target = players[0];
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

ws.on("open", () => {
  log(`connected to ${url}; creating game ${gameId} seed=${seed}`);
  const seats = decks.map((deck, i) => ({ seat: i, kind: i < humans ? "human" : "ai", name: i === 0 ? name : `Bot ${i + 1}`, deck }));
  send({ type: "createGame", rid: "r1", gameId, seed, seats });
});
ws.on("error", (e) => { console.error("[client] socket error", e.message ?? e); process.exit(2); });
ws.on("close", (code, reason) => { log(`socket closed ${code} ${reason}`); });
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  frames++;
  if (dumpDir && frames <= 500) writeFileSync(`${dumpDir}/${String(frames).padStart(4, "0")}-${m.type}${m.prompt ? "-" + m.prompt : ""}${m.seat !== undefined ? "-s" + m.seat : ""}.json`, JSON.stringify(m, null, 1));
  switch (m.type) {
    case "hello": log(`engine hello: forge ${m.forge}, ready=${m.ready}, activeGames=${m.activeGames}`); break;
    case "gameCreated": {
      const me = m.players.find((p) => p.seat === 0);
      myPlayerId = me?.playerId ?? null;
      log(`gameCreated: ${m.players.map((p) => `${p.seat}:${p.name}[${p.deckName} ${p.resolved} ok${p.missing.length ? ` missing ${p.missing.join(",")}` : ""}]`).join(" ")}`);
      break;
    }
    case "cards": log(`cards frame: ${m.cards.length} cards mapped`); break;
    case "state": {
      stats.states++;
      if (m.seat === 0 && m.turn !== lastTurn) {
        lastTurn = m.turn;
        const me = m.players.find((p) => p.isYou);
        log(`turn ${m.turn} (${m.players.find((p) => p.id === m.activePlayer)?.name}); lives ${m.players.map((p) => `${p.name.split(" ")[0]}=${p.life}${p.lost ? "x" : ""}`).join(" ")}; my hand ${me?.hand?.length ?? "?"}, bf ${me?.battlefield?.length ?? "?"}`);
      }
      break;
    }
    case "prompt": {
      if (m.seat !== 0 && m.seat >= humans) break;
      const reply = answer(m);
      send({ type: "answer", gameId, seat: m.seat, promptId: m.promptId, ...reply });
      break;
    }
    case "log": stats.logs++; break;
    case "error": stats.errors.push(m.message); log(`engine error: ${m.message}`); break;
    case "gameOver": {
      const out = { winner: m.winner, winnerSeat: m.winnerSeat, endReason: m.endReason, turns: m.turns, wallSeconds: Math.round((Date.now() - stats.startedAt) / 100) / 10, ...stats };
      console.log(JSON.stringify(out, null, 2));
      ws.close();
      process.exit(0);
    }
    default: break;
  }
});
