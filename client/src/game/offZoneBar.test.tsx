// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EnginePrompt, PlayerView, ViewCard } from "@cgwf/shared";
import { EngineBar, NO_PICK } from "./Engine";
import { offZonePlays } from "./offZonePlays";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const elves = { iid: "217", owner: "blair", zone: { kind: "exile", owner: "blair" }, faceDown: false, tapped: false, printingId: null, counters: {} } as unknown as ViewCard;
const empty = { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] };
const view = {
  viewer: "me",
  turn: 5,
  turnOrder: ["me", "blair"],
  players: {
    me: { id: "me", name: "Georgie", exile: [], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 0, cards: [] }, battlefield: empty },
    blair: { id: "blair", name: "Blair", exile: [elves], graveyard: [], command: [], library: { count: 80, known: [] }, hand: { count: 3, cards: [] }, battlefield: empty },
  },
} as unknown as PlayerView;
/** What the engine offered after Inside Information resolved (engine PlayFromExileTest, 2026-10-25). */
const prompt: EnginePrompt = { kind: "priority", promptId: 31, title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false, holding: false, options: [
  { index: 8, iid: "217", cardName: "Llanowar Elves", zone: "Exile", kind: "spell", description: "Llanowar Elves - Creature 1 / 1 by Inside Information (by paying 1 life instead of paying its mana cost)", cost: "{0}, Pay 1 life", targets: false },
] };

describe("the priority bar lists cards playable from an opponent's exile", () => {
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

  it("shows where the card is and what it costs, and a tap plays it", () => {
    const played: ViewCard[] = [];
    const answers: EngineAnswer[] = [];
    act(() => root.render(
      <EngineBar prompt={prompt} view={view} printings={{}} members={[]} me="me" pick={NO_PICK} setPick={() => {}} answer={(a) => answers.push(a)} onZoom={() => {}} openList={() => {}}
        offZone={offZonePlays(prompt, view, "me")} onPlayCard={(c) => played.push(c)} onHoldCard={() => {}} />,
    ));
    const row = host.querySelector(".offzone-plays");
    expect(row?.textContent).toContain("Llanowar Elves");
    expect(row?.textContent).toContain("Blair's exile");
    expect(row?.textContent).toContain("Pay 1 life");
    expect(host.textContent).toContain("1 from elsewhere below");
    const button = host.querySelector<HTMLButtonElement>(".offzone-play-label");
    expect(button?.getAttribute("aria-label")).toBe("Play Llanowar Elves (Blair's exile)");
    act(() => button!.click());
    expect(played.map((c) => c.iid)).toEqual(["217"]);
    expect(answers).toEqual([]); // the table's tap handler answers (one option) or opens the ability picker
  });
});
