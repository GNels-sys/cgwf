import { describe, expect, it } from "vitest";
import { viewFor, type PlayerView } from "@cgwf/shared";
import { apply, BEARS, BOLT, COMMANDER, ELF, FOREST, GIANT, startedGame } from "./fixtures.js";
import { dryRunTurn, shouldMulligan } from "./policy.js";
import { AGENT_TOOLS, mapToolCall, type ToolContext } from "./tools.js";

const ME = "agent";
const OPP = "blair";
const BOT2 = "bot2";

function setup() {
  const lib = [FOREST, FOREST, FOREST, BEARS, ELF, GIANT, BOLT, FOREST, FOREST, FOREST, BEARS];
  let s = startedGame(
    [
      { id: ME, name: "Krenko bot" },
      { id: OPP, name: "Blair" },
      { id: BOT2, name: "Giant bot" },
    ],
    { [ME]: { library: lib, commanders: [COMMANDER] }, [OPP]: { library: lib, commanders: [COMMANDER] }, [BOT2]: { library: lib, commanders: [COMMANDER] } },
  );
  for (const p of [ME, OPP, BOT2]) s = apply(s, p, { type: "HandKept", payload: { player: p } });
  return s;
}

function ctxFor(state: ReturnType<typeof setup>): ToolContext & { view: PlayerView } {
  const { view, printings } = viewFor(state, ME);
  return { me: ME, view, printings: Object.fromEntries(printings), agentIds: new Set([ME, BOT2]) };
}

describe("agent tools map one-to-one onto events", () => {
  it("has a schema for every tool", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("play_land accepts a land in hand and rejects a creature or a card it cannot see", () => {
    const s = setup();
    const ctx = ctxFor(s);
    const hand = ctx.view.players[ME]!.hand.cards;
    const land = hand.find((c) => ctx.printings[c.printingId!]!.typeLine.includes("Land"))!;
    const creature = hand.find((c) => ctx.printings[c.printingId!]!.typeLine.includes("Creature"))!;
    const ok = mapToolCall("play_land", { iid: land.iid }, ctx);
    expect(ok.ok && ok.call.events[0]!.type).toBe("CardMoved");
    const bad = mapToolCall("play_land", { iid: creature.iid }, ctx);
    expect(bad.ok).toBe(false);
    const unseen = mapToolCall("play_land", { iid: "nope" }, ctx);
    expect(!unseen.ok && unseen.error).toMatch(/no visible card/);
  });

  it("cast_permanent taps the listed lands first and refuses tapped or foreign ones", () => {
    let s = setup();
    const hand0 = s.players[ME]!.zones.hand;
    const landIid = hand0.find((iid) => s.cards[iid]!.printing!.name === "Forest")!;
    s = apply(s, ME, { type: "CardMoved", payload: { iid: landIid, to: { kind: "battlefield", owner: ME } } });
    const ctx = ctxFor(s);
    const creature = ctx.view.players[ME]!.hand.cards.find((c) => ctx.printings[c.printingId!]!.name === "Llanowar Elves" || ctx.printings[c.printingId!]!.name === "Grizzly Bears")!;
    const r = mapToolCall("cast_permanent", { iid: creature.iid, tap_lands: [landIid] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.call.events.map((e) => e.type)).toEqual(["CardTapped", "CardMoved"]);
    // Opponent's land cannot be tapped by me.
    const oppHand = s.players[OPP]!.zones.hand;
    const oppLand = oppHand.find((iid) => s.cards[iid]!.printing!.name === "Forest")!;
    s = apply(s, OPP, { type: "CardMoved", payload: { iid: oppLand, to: { kind: "battlefield", owner: OPP } } });
    const ctx2 = ctxFor(s);
    const bad = mapToolCall("cast_permanent", { iid: creature.iid, tap_lands: [oppLand] }, ctx2);
    expect(!bad.ok && bad.error).toMatch(/not under your control/);
  });

  it("cast_spell is for instants/sorceries only and reveals the card", () => {
    const s = setup();
    const ctx = ctxFor(s);
    const bolt = ctx.view.players[ME]!.hand.cards.find((c) => ctx.printings[c.printingId!]!.name === "Lightning Bolt");
    const bears = ctx.view.players[ME]!.hand.cards.find((c) => ctx.printings[c.printingId!]!.name === "Grizzly Bears");
    if (bolt) {
      const r = mapToolCall("cast_spell", { iid: bolt.iid, tap_lands: [] }, ctx);
      expect(r.ok && r.call.events.map((e) => e.type)).toEqual(["CardRevealed", "CardMoved"]);
    }
    if (bears) expect(mapToolCall("cast_spell", { iid: bears.iid, tap_lands: [] }, ctx).ok).toBe(false);
  });

  it("resolves players by name or 'me'; attack becomes an AttackersDeclared event", () => {
    let s = setup();
    const hand = s.players[ME]!.zones.hand;
    const bears = hand.find((iid) => s.cards[iid]!.printing!.name === "Grizzly Bears") ?? hand.find((iid) => /Creature/.test(s.cards[iid]!.printing!.typeLine))!;
    s = apply(s, ME, { type: "CardMoved", payload: { iid: bears, to: { kind: "battlefield", owner: ME } } });
    const ctx = ctxFor(s);
    const life = mapToolCall("change_life", { player: "blair", delta: -3 }, ctx);
    expect(life.ok && life.call.events[0]).toEqual({ type: "LifeChanged", payload: { player: OPP, delta: -3 } });
    const meLife = mapToolCall("change_life", { player: "me", delta: 2 }, ctx);
    expect(meLife.ok && meLife.call.events[0]!.payload).toMatchObject({ player: ME });
    expect(mapToolCall("change_life", { player: "nobody", delta: 1 }, ctx).ok).toBe(false);

    const vsHuman = mapToolCall("attack", { attacker_iids: [bears], defender: "Blair", total_power: 2 }, ctx);
    expect(vsHuman.ok && vsHuman.call.events).toEqual([{ type: "AttackersDeclared", payload: { attacks: [{ iid: bears, player: OPP }] } }]);
    const vsBot = mapToolCall("attack", { attacker_iids: [bears], defender: "Giant bot", total_power: 2 }, ctx);
    expect(vsBot.ok && vsBot.call.events.map((e) => e.type)).toEqual(["AttackersDeclared"]);
    expect(mapToolCall("attack", { attacker_iids: [bears], defender: "me", total_power: 2 }, ctx).ok).toBe(false);
  });

  it("pass_turn and attack need it to be my turn; unknown tools and bad inputs are errors", () => {
    let s = setup();
    s = apply(s, ME, { type: "TurnAdvanced", payload: {} }); // now Blair's turn
    const ctx = ctxFor(s);
    expect(mapToolCall("pass_turn", {}, ctx).ok).toBe(false);
    expect(mapToolCall("set_step", { step: "combat" }, ctx).ok).toBe(false);
    expect(mapToolCall("teleport", {}, ctx).ok).toBe(false);
    expect(mapToolCall("change_counters", { iid: "x", kind: "+1/+1", delta: "lots" }, ctx).ok).toBe(false);
    const token = mapToolCall("create_token", { name: "Goblin", type_line: "Token Creature — Goblin", power: "1", toughness: "1", colors: ["R"], text: "", count: 3 }, ctx);
    expect(token.ok && token.call.events[0]!.payload).toMatchObject({ player: ME, count: 3, row: "creatures" });
    const say = mapToolCall("say", { text: "  hello   table " }, ctx);
    expect(say.ok && say.call.events[0]!.payload).toMatchObject({ text: "hello   table" });
  });

  it("move_card keeps hidden zones private and bounces to the owner's hand", () => {
    let s = setup();
    const oppLand = s.players[OPP]!.zones.hand.find((iid) => s.cards[iid]!.printing!.name === "Forest")!;
    s = apply(s, OPP, { type: "CardMoved", payload: { iid: oppLand, to: { kind: "battlefield", owner: OPP } } });
    const ctx = ctxFor(s);
    const bounce = mapToolCall("move_card", { iid: oppLand, to: "hand" }, ctx);
    expect(bounce.ok && bounce.call.events[0]!.payload).toMatchObject({ to: { kind: "hand", owner: OPP } });
    const kill = mapToolCall("move_card", { iid: oppLand, to: "graveyard" }, ctx);
    expect(kill.ok && kill.call.events[0]!.payload).toMatchObject({ to: { kind: "graveyard", owner: OPP } });
    // A card in Blair's hand is invisible to me, so it cannot be addressed at all.
    const hidden = s.players[OPP]!.zones.hand[0]!;
    expect(mapToolCall("move_card", { iid: hidden, to: "graveyard" }, ctx).ok).toBe(false);
  });

  it("dry-run policy plays a land, casts what it can afford and always passes", () => {
    const s = setup();
    const ctx = ctxFor(s);
    const calls = dryRunTurn({ me: ME, view: ctx.view, printings: ctx.printings, enteredThisTurn: new Set() });
    expect(calls.at(-1)!.name).toBe("pass_turn");
    expect(calls[0]!.name).toBe("play_land");
    for (const c of calls) expect(mapToolCall(c.name, c.input, ctx).ok || c.name === "cast_permanent").toBe(true);
    expect(shouldMulligan(ctx.view.players[ME]!.hand.cards, ctx.printings, 0)).toBe(false);
  });
});
