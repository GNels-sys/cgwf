// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineOptionCard, EnginePrompt, PlayerView } from "@cgwf/shared";
import { EngineBar, initialPick } from "./Engine";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner report 2026-11-17: a Knights deck with Herald of Hoofbeats (every Knight has horsemanship) attacked and
 * "blocking was disabled" with no word why. The blockers bar now shows the engine's reasons.
 */
const empty = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
const view = {
  viewer: "me",
  turn: 6,
  turnOrder: ["blair", "me"],
  players: {
    me: { id: "me", name: "Georgie", exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 0, cards: [] }, battlefield: empty },
    blair: { id: "blair", name: "Blair", exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 3, cards: [] }, battlefield: empty },
  },
} as unknown as PlayerView;
const option = (iid: string, name: string, controller: string, extra: Partial<EngineOptionCard> = {}): EngineOptionCard =>
  ({ kind: "card", index: 0, iid, name, printingId: null, zone: "battlefield", controller, owner: controller, tapped: false, power: 3, toughness: 3, ...extra }) as EngineOptionCard;
const note = "Herald of Hoofbeats has horsemanship (only creatures with horsemanship can block it), so none of your untapped creatures can block it.";
const prompt: EnginePrompt = {
  kind: "blockers",
  promptId: 12,
  title: "Declare blockers",
  attackers: [option("30", "Herald of Hoofbeats", "blair"), option("31", "Hill Giant", "blair")],
  blockers: [option("40", "Grizzly Bears", "me", { canBlock: ["31"] })],
  notes: [note],
};

describe("the blockers bar says why some blocks are not possible", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = (p: EnginePrompt) =>
    act(() => root.render(<EngineBar prompt={p} view={view} printings={{}} members={[]} me="me" pick={initialPick(p)} setPick={() => {}} answer={() => {}} onZoom={() => {}} openList={() => {}} />));

  it("lists the engine's reasons under the heading", () => {
    render(prompt);
    const notes = host.querySelector(".engine-notes");
    expect(notes?.getAttribute("aria-label")).toBe("Why some blocks are not possible");
    expect([...notes!.querySelectorAll("li")].map((li) => li.textContent)).toEqual([note]);
  });
  it("shows no list when there is nothing to explain", () => {
    const { notes: _notes, ...plain } = prompt as Extract<EnginePrompt, { kind: "blockers" }>;
    render(plain);
    expect(host.querySelector(".engine-notes")).toBeNull();
  });
});
