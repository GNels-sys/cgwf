// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAnswer, EnginePrompt, PlayerView, ViewCard } from "@cgwf/shared";
import { EngineBar, NO_PICK } from "./Engine";
import { offZonePlays, playableIn } from "./offZonePlays";
import { LibraryLookBadge, libraryLookTitle } from "./Table";

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

describe("the top of my library when a card lets me play it (owner report 2026-11-18, Bolas's Citadel)", () => {
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

  const giant = { iid: "205", owner: "me", zone: { kind: "library", owner: "me" }, position: 0, faceDown: false, tapped: false, printingId: null, counters: {} } as unknown as ViewCard;
  const citadelView = { ...view, players: { ...view.players, me: { ...view.players.me!, library: { count: 80, known: [giant] } } } } as unknown as PlayerView;
  /** What the engine offers with the Citadel out (engine TopOfLibraryTest). */
  const citadelPrompt: EnginePrompt = { kind: "priority", promptId: 44, title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false, holding: false, options: [
    { index: 3, iid: "205", cardName: "Hill Giant", zone: "library", kind: "spell", description: "Hill Giant - Creature 3 / 3 by Bolas's Citadel (by paying 4 life instead of paying its mana cost)", cost: "{0}, Pay 4 life", targets: false },
  ] };

  it("offers the card from the top of the library for its life cost", () => {
    const plays = offZonePlays(citadelPrompt, citadelView, "me");
    expect(plays.map((p) => [p.zone, p.where, p.owner])).toEqual([["library", "Top of your library", "me"]]);
    expect(playableIn(plays, "me", "library")).toBe(1);
    const played: ViewCard[] = [];
    act(() => root.render(
      <EngineBar prompt={citadelPrompt} view={citadelView} printings={{}} members={[]} me="me" pick={NO_PICK} setPick={() => {}} answer={() => {}} onZoom={() => {}} openList={() => {}}
        offZone={plays} onPlayCard={(c) => played.push(c)} onHoldCard={() => {}} />,
    ));
    const row = host.querySelector(".offzone-plays");
    expect(row?.textContent).toContain("Hill Giant");
    expect(row?.textContent).toContain("Top of your library");
    expect(row?.textContent).toContain("Pay 4 life");
    act(() => host.querySelector<HTMLButtonElement>(".offzone-play-label")!.click());
    expect(played.map((c) => c.iid)).toEqual(["205"]);
  });

  it("marks the Library button: to play when it can be played, Look when it can only be looked at", () => {
    act(() => root.render(<LibraryLookBadge known={1} playable={1} />));
    expect(host.textContent).toBe("1 to play");
    act(() => root.render(<LibraryLookBadge known={1} playable={0} />));
    expect(host.textContent).toBe("Look");
    act(() => root.render(<LibraryLookBadge known={0} playable={0} />));
    expect(host.textContent).toBe("");
    expect(libraryLookTitle([giant])).toBe("Top of your library");
    expect(libraryLookTitle([giant, { ...giant, iid: "206", position: 1 }])).toBe("Your library: cards you may look at (top first)");
  });
});
