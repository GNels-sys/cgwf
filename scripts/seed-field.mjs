// Dev helper: as a seated player, pull named cards from the library straight onto the battlefield.
// Usage: node scripts/seed-field.mjs <BASE_URL> <join-code> <device-token> "Card A" "Card B" ...
import WebSocket from "ws";

const [BASE, CODE, TOKEN, ...NAMES] = process.argv.slice(2);
if (!BASE || !CODE || !TOKEN || NAMES.length === 0) {
  console.error("usage: node scripts/seed-field.mjs <base-url> <code> <token> <card name>...");
  process.exit(1);
}
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/rooms/${CODE}/ws?token=${encodeURIComponent(TOKEN)}`);
const printings = {};
let me = null;
let phase = "search";
const wanted = new Set(NAMES.map((n) => n.toLowerCase()));

ws.on("open", () => console.log("connected"));
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.t === "error") console.log("error:", msg.message);
  if (msg.t !== "state") return;
  Object.assign(printings, msg.printings);
  const v = msg.view;
  me = v.viewer;
  const p = v.players[me];
  if (!p) return;
  if (phase === "search") {
    phase = "move";
    ws.send(JSON.stringify({ t: "event", event: { type: "LibrarySearched", payload: { player: me } } }));
    return;
  }
  if (phase === "move") {
    const known = [...p.library.known, ...p.hand.cards];
    const next = known.find((c) => wanted.has((printings[c.printingId]?.name ?? "").toLowerCase()));
    if (next) {
      wanted.delete(printings[next.printingId].name.toLowerCase());
      console.log("moving", printings[next.printingId].name);
      ws.send(JSON.stringify({ t: "event", event: { type: "CardMoved", payload: { iid: next.iid, to: { kind: "battlefield", owner: me } } } }));
      return;
    }
    phase = "done";
    if (wanted.size) console.log("not found:", [...wanted].join(", "));
    ws.send(JSON.stringify({ t: "event", event: { type: "LibraryShuffled", payload: { player: me } } }));
    setTimeout(() => ws.close(), 500);
  }
});
ws.on("close", () => console.log("done"));
