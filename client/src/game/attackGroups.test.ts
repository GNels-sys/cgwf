import { describe, expect, it } from "vitest";
import type { EngineEntityRef, EngineOptionCard, ViewCard } from "@cgwf/shared";
import { attackGroups, countAt, countFree, everyoneAt, sendRest, setCount, splitEvenly, toggleMany, type AttackTargets } from "./attackGroups";
import { ROLL_UP_MIN, rollUp } from "./rollup";

/**
 * Owner request 2026-11-18: a board of 110 tokens was attacked with one tap per token. Identical attackers are
 * one group; a group is sent whole, by number per player, or shared out evenly.
 */
const alex: EngineEntityRef = { kind: "player", player: "alex", name: "Alex" };
const blair: EngineEntityRef = { kind: "player", player: "blair", name: "Blair" };
const casey: EngineEntityRef = { kind: "player", player: "casey", name: "Casey" };
const everyone = [alex, blair, casey];
const option = (iid: string, name: string, extra: Partial<EngineOptionCard> = {}): EngineOptionCard =>
  ({ kind: "card", index: 0, iid, name, printingId: null, zone: "battlefield", controller: "me", owner: "me", tapped: false, power: 1, toughness: 1, canAttack: everyone, ...extra }) as EngineOptionCard;
const saprolings = Array.from({ length: 110 }, (_, i) => option(`s${i}`, "Saproling"));
const angel = option("angel", "Platinum Angel", { power: 4, toughness: 4 });
const big = option("big", "Saproling", { power: 3, toughness: 3 });
const goaded = option("goad", "Saproling", { mustAttack: [blair] });
const candidates = [...saprolings, angel, big, goaded];
const at = (targets: AttackTargets, d: EngineEntityRef) => Object.values(targets).filter((t) => t === d).length;

describe("groups of identical attackers", () => {
  const groups = attackGroups(candidates);
  const tokens = groups[0]!;
  it("puts creatures the attack cannot tell apart in one group", () => {
    expect(groups.map((g) => [g.name, g.power, g.iids.length, g.required])).toEqual([
      ["Saproling", 1, 110, false],
      ["Platinum Angel", 4, 1, false],
      ["Saproling", 3, 1, false], // a different size is a different group
      ["Saproling", 1, 1, true], // so is one the rules send somewhere
    ]);
    expect(attackGroups([option("x", "Wall", { canAttack: [] })])).toEqual([]);
  });
  it("sends 30 at one player, 30 at another and the rest at a third", () => {
    let t: AttackTargets = {};
    t = setCount(t, tokens, alex, 30);
    t = setCount(t, tokens, blair, 30);
    expect([countAt(tokens, t, alex), countAt(tokens, t, blair), countFree(tokens, t)]).toEqual([30, 30, 50]);
    t = sendRest(t, tokens, casey);
    expect([at(t, alex), at(t, blair), at(t, casey), countFree(tokens, t)]).toEqual([30, 30, 50, 0]);
    expect(Object.keys(t)).toHaveLength(110);
  });
  it("never takes from another player's share, and clamps a number that is too large", () => {
    let t = setCount({}, tokens, alex, 100);
    t = setCount(t, tokens, blair, 500);
    expect([at(t, alex), at(t, blair)]).toEqual([100, 10]);
    t = setCount(t, tokens, alex, 40); // fewer: the others attack nobody again
    expect([at(t, alex), at(t, blair), countFree(tokens, t)]).toEqual([40, 10, 60]);
    expect(at(setCount(t, tokens, alex, -5), alex)).toBe(0);
  });
  it("shares a group out evenly, the first players taking the remainder", () => {
    const t = splitEvenly(setCount({}, tokens, alex, 7), tokens, everyone);
    expect([at(t, alex), at(t, blair), at(t, casey)]).toEqual([37, 37, 36]);
  });
  it("only sends a creature where the rules allow", () => {
    const must = groups[3]!;
    expect(setCount({}, must, alex, 1)).toEqual({});
    expect(setCount({}, must, blair, 1)).toEqual({ goad: blair });
    expect(splitEvenly({}, must, everyone)).toEqual({ goad: blair });
  });
  it("'All attack Alex' sends everything at Alex, and the goaded one where it has to go", () => {
    const t = everyoneAt(candidates, alex);
    expect(Object.keys(t)).toHaveLength(113);
    expect(t.goad).toBe(blair);
    expect(at(t, alex)).toBe(112);
  });
  it("a tap on a stack sends the whole stack at the lit target, and a second tap takes it back", () => {
    const stack = saprolings.slice(0, 50);
    const sent = toggleMany({ angel: blair }, stack, casey);
    expect(at(sent, casey)).toBe(50);
    expect(sent.angel).toBe(blair);
    expect(toggleMany(sent, stack, casey)).toEqual({ angel: blair });
    expect(toggleMany({}, [goaded], alex)).toEqual({ goad: blair });
  });
});

describe("identical tokens roll up into one tile", () => {
  const card = (iid: string, extra: Partial<ViewCard> = {}): ViewCard =>
    ({ iid, printingId: "saproling", custom: null, owner: "me", zone: { kind: "battlefield", owner: "me", row: "creatures" }, tapped: false, faceDown: false, face: 0, counters: {}, attachedTo: null, isToken: true, isCommander: false, effect: null, modifier: null, anthemDismissed: false, public: true, engine: { power: 1, toughness: 1, damage: 0, sick: false }, ...extra }) as ViewCard;
  const stacks = (cards: ViewCard[]) => cards.map((host) => ({ host, attachments: [] as ViewCard[] }));
  const sizes = (cards: ViewCard[], look: Parameters<typeof rollUp>[1] = () => ({})) => rollUp(stacks(cards), look).map((p) => p.members.length);
  const ten = Array.from({ length: 10 }, (_, i) => card(`t${i}`));
  it("one tile for ten identical tokens, at the place of the first", () => {
    const bear = card("bear", { isToken: false, printingId: "bear" });
    const piles = rollUp(stacks([bear, ...ten.slice(0, 5), card("elf", { isToken: false, printingId: "elf" }), ...ten.slice(5)]), () => ({}));
    expect(piles.map((p) => [p.host.iid, p.members.length])).toEqual([["bear", 1], ["t0", 10], ["elf", 1]]);
  });
  it("keeps apart what a tile shows differently: tapped, counters, sickness, another token", () => {
    const mixed = [...ten.slice(0, 4), ...ten.slice(4, 8).map((c) => ({ ...c, tapped: true })), card("c1", { counters: { "+1/+1": 1 } }), card("z1", { engine: { power: 1, toughness: 1, damage: 0, sick: true } }), card("o1", { printingId: "treasure" })];
    expect(sizes(mixed)).toEqual([4, 4, 1, 1, 1]);
  });
  it("splits a pile by who its creatures are aimed at", () => {
    const marks = new Map(ten.slice(0, 5).map((c) => [c.iid, { label: "→ Alex" }]));
    const piles = rollUp(stacks(ten), (c) => ({ mark: marks.get(c.iid), selected: marks.has(c.iid) }));
    expect(piles.map((p) => p.members.length)).toEqual([5, 5]);
  });
  it("leaves real cards, cards with something attached, and small numbers as they are", () => {
    expect(sizes(ten.map((c) => ({ ...c, isToken: false })))).toEqual(Array(10).fill(1));
    expect(sizes(ten.slice(0, ROLL_UP_MIN - 1))).toEqual(Array(ROLL_UP_MIN - 1).fill(1));
    const equipped = stacks(ten.slice(0, 5));
    equipped[0]!.attachments = [card("axe", { isToken: false })];
    expect(rollUp(equipped, () => ({})).map((p) => p.members.length)).toEqual([1, 4]);
  });
});
