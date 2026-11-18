// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EnginePrompt, PlayerView } from "@cgwf/shared";
import { EngineBar, initialPick } from "./Engine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner report 2026-11-18: a stack of triggers took the better part of an hour, one "Let it resolve" per item.
 * With more than one item on the stack the priority bar offers "Resolve all": pass until the stack is empty.
 */
const empty = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
const seat = (id: string, name: string) => ({ id, name, exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 0, cards: [] }, battlefield: empty });
const item = (id: number) => ({ id: `s${id}`, controller: "me", name: "Phyrexian Golem trigger", kind: "trigger", printingId: null, targets: [] });
const viewWith = (items: number) =>
  ({ viewer: "me", turn: 38, turnOrder: ["me", "kotis"], players: { me: seat("me", "Georgie"), kotis: seat("kotis", "Kotis bot") }, stack: Array.from({ length: items }, (_, i) => item(i)) }) as unknown as PlayerView;
const priority = (stackEmpty: boolean): EnginePrompt => ({ kind: "priority", promptId: 300, title: "You have priority", options: [], phase: "COMBAT_DECLARE_ATTACKERS", myTurn: true, stackEmpty, stackTopMine: !stackEmpty, holding: false });

describe("Resolve all on the priority bar", () => {
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
  const render = (p: EnginePrompt, view: PlayerView) =>
    act(() => root.render(<EngineBar prompt={p} view={view} printings={{}} members={[]} me="me" pick={initialPick(p)} setPick={() => {}} answer={(a) => sent.push(a)} onZoom={() => {}} openList={() => {}} />));
  const button = (re: RegExp) => [...host.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));

  it("is offered with several items on the stack and passes until the stack is empty", () => {
    render(priority(false), viewWith(14));
    const all = button(/Resolve all/)!;
    expect(all.textContent).toContain("Resolve all (14)");
    act(() => all.click());
    expect(sent).toEqual([{ promptId: 300, option: null, passStack: true }]);
  });
  it("leaves the single pass as it was", () => {
    render(priority(false), viewWith(14));
    act(() => button(/Let it resolve/)!.click());
    expect(sent).toEqual([{ promptId: 300, option: null }]);
  });
  it("is not offered for one item or an empty stack", () => {
    render(priority(false), viewWith(1));
    expect(button(/Resolve all/)).toBeUndefined();
    render(priority(true), viewWith(0));
    expect(button(/Resolve all/)).toBeUndefined();
  });
});
