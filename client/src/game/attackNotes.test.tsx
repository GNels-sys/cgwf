// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EngineEntityRef, EngineOptionCard, EnginePrompt, PlayerView } from "@cgwf/shared";
import { EngineBar, initialPick } from "./Engine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner report 2026-11-18: Phyrexian Triniform's encore made three copies that each had to attack a different
 * opponent, the attack bar said nothing about it, and every declaration was refused. The bar now starts with
 * those attackers declared at the right players, lists what the rules require, and says why an attack was refused.
 */
const empty = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
const seat = (id: string, name: string) => ({ id, name, exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 0, cards: [] }, battlefield: empty });
const view = {
  viewer: "me",
  turn: 34,
  turnOrder: ["me", "kotis", "jin"],
  players: { me: seat("me", "Georgie"), kotis: seat("kotis", "Kotis bot"), jin: seat("jin", "Jin bot") },
} as unknown as PlayerView;
const kotis: EngineEntityRef = { kind: "player", player: "kotis", name: "Kotis bot" };
const jin: EngineEntityRef = { kind: "player", player: "jin", name: "Jin bot" };
const option = (iid: string, name: string, extra: Partial<EngineOptionCard> = {}): EngineOptionCard =>
  ({ kind: "card", index: 0, iid, name, printingId: null, zone: "battlefield", controller: "me", owner: "me", tapped: false, power: 9, toughness: 9, canAttack: [kotis, jin], ...extra }) as EngineOptionCard;
const notes = ["Phyrexian Triniform must attack Kotis bot this combat if able.", "Phyrexian Triniform must attack Jin bot this combat if able."];
const prompt: EnginePrompt = {
  kind: "attackers",
  promptId: 95,
  title: "Declare attackers",
  candidates: [option("415", "Phyrexian Triniform", { mustAttack: [kotis] }), option("416", "Phyrexian Triniform", { mustAttack: [jin] }), option("51", "Platinum Angel")],
  defenders: [kotis, jin],
  notes,
};

describe("the attack bar says what the rules require", () => {
  let host: HTMLDivElement;
  let root: Root;
  const sent: EngineAnswer[] = [];
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    sent.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = (p: EnginePrompt) =>
    act(() => root.render(<EngineBar prompt={p} view={view} printings={{}} members={[]} me="me" pick={initialPick(p)} setPick={() => {}} answer={(a) => sent.push(a)} onZoom={() => {}} openList={() => {}} />));

  it("starts with the creatures that must attack declared, each at its own player", () => {
    const pick = initialPick(prompt);
    expect(pick).toMatchObject({ kind: "attack", targets: { "415": kotis, "416": jin } });
    expect(pick.kind === "attack" && pick.targets["51"]).toBeFalsy();
    render(prompt);
    const declare = [...host.querySelectorAll("button")].find((b) => /Declare/.test(b.textContent ?? ""))!;
    expect(declare.textContent).toContain("2 attackers");
    act(() => declare.click());
    expect(sent).toEqual([{ promptId: 95, attacks: [{ iid: "415", defender: kotis }, { iid: "416", defender: jin }] }]);
  });
  it("lists the requirements, and nothing was refused yet", () => {
    render(prompt);
    const list = host.querySelector(".engine-notes");
    expect(list?.getAttribute("aria-label")).toBe("What the rules require of this attack");
    expect([...list!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(notes);
    expect(host.querySelector(".engine-refused")).toBeNull();
  });
  it("says why the last attack was refused", () => {
    const refused = "That attack is not legal. Phyrexian Triniform must attack Jin bot this combat if able.";
    render({ ...prompt, promptId: 96, refused } as EnginePrompt);
    const alert = host.querySelector(".engine-refused");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toBe(refused);
  });
  it("shows neither when the rules ask for nothing", () => {
    render({ kind: "attackers", promptId: 97, title: "Declare attackers", candidates: [option("51", "Platinum Angel")], defenders: [kotis, jin] });
    expect(host.querySelector(".engine-notes")).toBeNull();
    expect(host.querySelector(".engine-refused")).toBeNull();
    expect(initialPick(prompt).kind).toBe("attack");
  });
});
