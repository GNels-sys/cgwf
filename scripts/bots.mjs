// Test harness: registers bot players with decks, joins a room, seats them and plays along.
// Usage: node scripts/bots.mjs <BASE_URL> [join-code]
// Without a code it creates a room as "Georgie" and prints a device token you can paste into
// localStorage ("cgwf.token") to play seat 1 from a browser. Three bots take seats 2-4, keep their
// hands, play a land and pass on their turns. Dev/testing only.
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://localhost:8080";
let CODE = process.argv[3] ?? null;
const WS_BASE = BASE.replace(/^http/, "ws");

const LISTS = {
  Georgie: `1 Atraxa, Praetors' Voice\n\n1 Sol Ring\n1 Arcane Signet\n1 Swords to Plowshares\n1 Counterspell\n1 Cultivate\n1 Eternal Witness\n1 Birds of Paradise\n1 Llanowar Elves\n1 Delver of Secrets\n1 Thassa's Oracle\n1 Rhystic Study\n1 Smothering Tithe\n4 Forest\n4 Plains\n3 Island\n3 Swamp\n`,
  Blair: `1 Krenko, Mob Boss\n\n1 Sol Ring\n1 Lightning Bolt\n1 Goblin Guide\n1 Skirk Prospector\n1 Impact Tremors\n1 Purphoros, God of the Forge\n1 Goblin Chieftain\n1 Blood Moon\n1 Chaos Warp\n12 Mountain\n`,
  Casey: `1 Yuriko, the Tiger's Shadow\n\n1 Sol Ring\n1 Brainstorm\n1 Ponder\n1 Thoughtseize\n1 Ornithopter\n1 Changeling Outcast\n1 Mana Leak\n1 Fatal Push\n6 Island\n6 Swamp\n`,
  Dana: `1 Muldrotha, the Gravetide\n\n1 Sol Ring\n1 Cultivate\n1 Kodama's Reach\n1 Eternal Witness\n1 Sakura-Tribe Elder\n1 Reanimate\n1 Animate Dead\n1 Counterspell\n5 Forest\n5 Island\n4 Swamp\n`,
};
const AVATARS = { Georgie: ["dragon", "gold"], Blair: ["owl", "ruby"], Casey: ["fox", "sapphire"], Dana: ["wolf", "jade"] };

async function api(path, { token, method, json } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method: method ?? (json !== undefined ? "POST" : "GET"), headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error ?? ""}`);
  return body;
}

async function makePlayer(name) {
  const [avatar, color] = AVATARS[name];
  const reg = await api("/api/me/register", { json: { displayName: name, avatar, color } });
  const parsed = await api("/api/decks/parse", { token: reg.token, json: { text: LISTS[name] } });
  const cards = parsed.lines.filter((l) => l.card).map((l) => ({ cardId: l.card.id, quantity: l.line.quantity ?? 1, board: l.commander ? "commander" : "main" }));
  const deck = await api("/api/decks", { token: reg.token, json: { name: `${name}'s deck`, cards } });
  return { name, token: reg.token, userId: reg.user.id, deckId: deck.deck.id, cardCount: cards.length };
}

function connectBot(p, seat) {
  const ws = new WebSocket(`${WS_BASE}/api/rooms/${CODE}/ws?token=${encodeURIComponent(p.token)}`);
  let kept = false;
  let acted = 0;
  ws.on("open", () => {
    console.log(`[${p.name}] connected`);
    ws.send(JSON.stringify({ t: "seat", seat, deckId: p.deckId }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.t === "error") console.log(`[${p.name}] error: ${msg.message}`);
    if (msg.t === "room") {
      const me = msg.room.members.find((m) => m.userId === p.userId);
      if (me && me.seat !== seat && msg.room.status === "lobby") ws.send(JSON.stringify({ t: "seat", seat, deckId: p.deckId }));
    }
    if (msg.t === "state") {
      const v = msg.view;
      const me = v.players[p.userId];
      if (!me) return;
      const last = v.log.at(-1);
      if (last) console.log(`[${p.name}] seq ${v.seq} ${v.phase} T${v.turn} ${v.step} | ${last.text}`);
      if (v.phase === "mulligan" && !me.kept && !kept) {
        kept = true;
        setTimeout(() => ws.send(JSON.stringify({ t: "event", event: { type: "HandKept", payload: { player: p.userId } } })), 400);
      }
      // When it becomes this bot's turn, play a land from hand (if any), then pass.
      if (v.phase === "playing" && v.activePlayer === p.userId && v.step === "untap" && acted < v.turn) {
        acted = v.turn;
        setTimeout(() => {
          const land = me.hand.cards.find((c) => /Land/.test(msg.printings?.[c.printingId]?.typeLine ?? catalogue[c.printingId]?.typeLine ?? ""));
          if (land) ws.send(JSON.stringify({ t: "event", event: { type: "CardMoved", payload: { iid: land.iid, to: { kind: "battlefield", owner: p.userId } } } }));
          setTimeout(() => ws.send(JSON.stringify({ t: "event", event: { type: "TurnAdvanced", payload: {} } })), 600);
        }, 800);
      }
      Object.assign(catalogue, msg.printings);
    }
  });
  ws.on("close", (c, r) => console.log(`[${p.name}] closed ${c} ${r}`));
  return ws;
}
const catalogue = {};

const host = CODE ? null : await makePlayer("Georgie");
if (host) {
  const room = await api("/api/rooms", { token: host.token, json: {} });
  CODE = room.room.code;
  console.log(`ROOM ${CODE}`);
  console.log(`HOST_TOKEN ${host.token}`);
  console.log(`HOST_DECK ${host.deckId} (${host.cardCount} cards)`);
}
const bots = [];
for (const [i, name] of ["Blair", "Casey", "Dana"].entries()) {
  const p = await makePlayer(name);
  await api(`/api/rooms/${CODE}/join`, { token: p.token, json: {} });
  bots.push({ p, ws: connectBot(p, i + 1) });
  console.log(`[${name}] joined with ${p.cardCount} cards`);
}
// Reconnect drill: press Enter (or send "drop" on stdin) to force-close Blair and rejoin 1.5 s later.
process.stdin.on("data", () => {
  const b = bots[0];
  if (b.ws.readyState === WebSocket.OPEN) {
    console.log("[Blair] force-closing socket");
    b.ws.terminate();
    setTimeout(() => {
      console.log("[Blair] reconnecting");
      b.ws = connectBot(b.p, 1);
    }, 1500);
  }
});
