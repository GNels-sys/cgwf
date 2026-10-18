// Dev harness for rules-engine tables: a scripted second human over the REAL room socket.
// Usage: node scripts/engine-bot.mjs <BASE_URL> <join-code> [name] [seat]
// Registers a device profile, builds a legal 100-card Commander deck (Krenko + 99 Mountains),
// joins the room, sits down, and answers every engine prompt it is given: land, cheapest spell,
// attack the lowest-life opponent, block what it can survive, first option, keep. It never sees
// another seat's frames: it only has its own device token. Dev/testing only.
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://localhost:8093";
const CODE = process.argv[3];
const NAME = process.argv[4] ?? "Blair";
const SEAT = Number(process.argv[5] ?? 1);
if (!CODE) {
  console.error("usage: node scripts/engine-bot.mjs <BASE_URL> <join-code> [name] [seat]");
  process.exit(2);
}
const WS_BASE = BASE.replace(/^http/, "ws");
const LIST = `1 Krenko, Mob Boss\n\n99 Mountain\n`;

async function api(path, { token, method, json } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method: method ?? (json !== undefined ? "POST" : "GET"), headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error ?? ""}`);
  return body;
}

const reg = await api("/api/me/register", { json: { displayName: NAME, avatar: "owl", color: "ruby" } });
const parsed = await api("/api/decks/parse", { token: reg.token, json: { text: LIST } });
// first resolved line = the commander (explicit boards; the heuristic needs a headed list)
const cards = parsed.lines.filter((l) => l.card).map((l, i) => ({ cardId: l.card.id, quantity: l.line.quantity ?? 1, board: i === 0 ? "commander" : "main" }));
const deck = await api("/api/decks", { token: reg.token, json: { name: `${NAME}'s mountains`, cards } });
await api(`/api/rooms/${CODE}/join`, { token: reg.token, json: {} });
console.error(`[${NAME}] registered (${cards.length} lines, deck ${deck.deck.id}); joining ${CODE} seat ${SEAT}`);

const stats = { prompts: {}, lands: 0, spells: 0, attacks: 0, blocks: 0 };
const castPerStep = new Map();
let me = null;
let lastPrompt = -1;
let lastTurn = 0;

function answerFor(p, view) {
  const id = p.promptId;
  switch (p.kind) {
    case "priority": {
      const land = p.options.find((o) => o.kind === "land");
      if (land) { stats.lands++; return { promptId: id, option: land.index }; }
      const key = `${view.turn}:${view.step}`;
      const n = castPerStep.get(key) ?? 0;
      if (n < 2 && p.stackEmpty) {
        const spells = p.options.filter((o) => o.kind === "spell").sort((a, b) => (a.cost ?? "").length - (b.cost ?? "").length);
        if (spells.length) { castPerStep.set(key, n + 1); stats.spells++; return { promptId: id, option: spells[0].index }; }
      }
      return { promptId: id, option: null };
    }
    case "targets": {
      const foes = p.options.filter((o) => (o.kind === "player" && o.player !== me) || (o.kind === "card" && o.controller !== me));
      const pool = foes.length ? foes : p.options;
      return { promptId: id, options: pool.slice(0, Math.max(1, p.min)).map((o) => o.index) };
    }
    case "attackers": {
      const players = p.defenders.filter((d) => d.kind === "player").sort((a, b) => (a.life ?? 99) - (b.life ?? 99));
      const target = players[0];
      const attacks = [];
      for (const c of p.candidates) {
        const ok = (c.canAttack ?? []).find((d) => d.kind === "player" && target && d.player === target.player) ?? (c.canAttack ?? [])[0];
        if (ok && (c.power ?? 0) > 0) attacks.push({ iid: c.iid, defender: ok });
      }
      if (attacks.length) stats.attacks++;
      return { promptId: id, attacks };
    }
    case "blockers": {
      const attackers = [...p.attackers].sort((a, b) => (b.power ?? 0) - (a.power ?? 0));
      const used = new Set();
      const blocks = [];
      for (const att of attackers) {
        const b = p.blockers.find((x) => !used.has(x.iid) && (x.canBlock ?? []).includes(att.iid) && (x.toughness ?? 0) > (att.power ?? 0));
        if (b) { used.add(b.iid); blocks.push({ blockerIid: b.iid, attackerIid: att.iid }); }
      }
      if (blocks.length) stats.blocks++;
      return { promptId: id, blocks };
    }
    case "choose": return { promptId: id, option: p.options.length ? p.options[0].index : null };
    case "chooseMany": return { promptId: id, options: p.options.slice(0, p.min).map((o) => o.index) };
    case "confirm": return { promptId: id, confirm: true };
    case "mulligan": return { promptId: id, keep: true };
    case "number": return { promptId: id, value: p.values?.length ? p.values[0] : p.min };
    case "order": return { promptId: id, order: p.items.map((o) => o.index), buckets: {} };
    case "assign": return { promptId: id, amounts: p.targets.map((_, i) => (i === 0 ? p.total : 0)) };
    case "mode": return { promptId: id, modes: p.modes.slice(0, Math.max(1, p.min)).map((m) => m.index) };
    case "text": return { promptId: id, text: "Forest" };
    default: return null;
  }
}

const ws = new WebSocket(`${WS_BASE}/api/rooms/${CODE}/ws?token=${encodeURIComponent(reg.token)}`);
const send = (m) => ws.send(JSON.stringify(m));
ws.on("open", () => send({ t: "seat", seat: SEAT, deckId: deck.deck.id }));
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.t === "room") {
    if (m.room.status === "ended") {
      console.error(`[${NAME}] game over; ${JSON.stringify(stats)}`);
      ws.close();
      process.exit(0);
    }
    return;
  }
  if (m.t === "error") console.error(`[${NAME}] server error: ${m.message}`);
  if (m.t !== "state") return;
  const view = m.view;
  me = view.viewer;
  if (view.turn !== lastTurn) {
    lastTurn = view.turn;
    const mine = view.players[me];
    console.error(`[${NAME}] turn ${view.turn} ${view.step}; life ${Object.values(view.players).map((p) => `${p.name}=${p.life}`).join(" ")}; hand ${mine?.hand.cards.length}, bf ${mine ? Object.values(mine.battlefield).flat().length : "?"}`);
  }
  const prompt = view.engine?.prompt;
  if (!prompt || prompt.promptId === lastPrompt) return;
  lastPrompt = prompt.promptId;
  stats.prompts[prompt.kind] = (stats.prompts[prompt.kind] ?? 0) + 1;
  const answer = answerFor(prompt, view);
  if (answer) setTimeout(() => send({ t: "engine", answer }), 150);
});
ws.on("close", () => process.exit(0));
ws.on("error", (e) => {
  console.error(`[${NAME}] socket error ${e.message}`);
  process.exit(1);
});
