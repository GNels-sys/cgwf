import { describe, expect, it } from "vitest";
import { toEnginePrompt, toViewCard, type ConvertContext, type EngineCardJson } from "./view.js";

/**
 * Owner report 2026-11-17: nothing on screen said whether a creature was prepared, and the seat was never told
 * why it could not block. The engine now sends both; this is the relay's half.
 */
const ctx = {
  viewer: "me",
  seats: [
    { seat: 0, userId: "me", name: "Georgie", playerId: 0 },
    { seat: 1, userId: "blair", name: "Blair", playerId: 1 },
  ],
  printingOf: () => null,
  log: [],
  seq: 0,
  engine: {},
} as unknown as ConvertContext;
const base = { zone: "Battlefield", controller: 0, owner: 0, tapped: false, faceDown: false, token: false };

describe("prepared spells in the seat's view", () => {
  it("marks a prepared creature with its spell and the copy waiting in exile", () => {
    const creature: EngineCardJson = { ...base, id: 211, name: "Grave Researcher", types: "Creature Troll Warlock", power: 3, toughness: 3, prepare: { name: "Reanimate", ready: true, cardId: 212 } };
    expect(toViewCard(creature, ctx, new Map()).engine?.prepare).toEqual({ name: "Reanimate", ready: true, spellIid: "212" });
  });
  it("names the spell of a creature that is not prepared, with nothing to cast", () => {
    const creature: EngineCardJson = { ...base, id: 211, name: "Stensian Sanguinist", types: "Creature Vampire Cleric", prepare: { name: "Exsanguinate", ready: false } };
    expect(toViewCard(creature, ctx, new Map()).engine?.prepare).toEqual({ name: "Exsanguinate", ready: false, spellIid: null });
  });
  it("ties the exiled copy to its creature, and leaves other cards alone", () => {
    const copy: EngineCardJson = { ...base, zone: "Exile", token: true, id: 212, name: "Reanimate", types: "Sorcery", preparedBy: 211, preparedByName: "Grave Researcher" };
    expect(toViewCard(copy, ctx, new Map()).engine?.preparedBy).toEqual({ iid: "211", name: "Grave Researcher" });
    const plain = toViewCard({ ...base, id: 5, name: "Grizzly Bears", types: "Creature Bear", power: 2, toughness: 2 }, ctx, new Map());
    expect(plain.engine).toEqual({ power: 2, toughness: 2, damage: 0, sick: false });
  });
});

describe("the blockers prompt", () => {
  const attacker = { ...base, controller: 1, owner: 1, id: 30, name: "Herald of Hoofbeats", types: "Creature Human Knight", power: 3, toughness: 3 };
  const blocker = { ...base, id: 40, name: "Grizzly Bears", types: "Creature Bear", power: 2, toughness: 2, canBlock: [31] };
  it("carries the reasons some attackers cannot be blocked, without Forge's ids", () => {
    const p = toEnginePrompt({ prompt: "blockers", promptId: 7, title: "Declare blockers", attackers: [attacker], blockers: [blocker], notes: ["Herald of Hoofbeats (30) has horsemanship (only creatures with horsemanship can block it), so none of your untapped creatures can block it."] }, ctx);
    expect(p?.kind).toBe("blockers");
    if (p?.kind !== "blockers") return;
    expect(p.notes).toEqual(["Herald of Hoofbeats has horsemanship (only creatures with horsemanship can block it), so none of your untapped creatures can block it."]);
  });
  it("has no notes field when there is nothing to explain", () => {
    const p = toEnginePrompt({ prompt: "blockers", promptId: 8, title: "Declare blockers", attackers: [attacker], blockers: [blocker] }, ctx);
    expect(p && "notes" in p).toBe(false);
  });
});
