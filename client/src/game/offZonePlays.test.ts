import { describe, expect, it } from "vitest";
import type { EnginePlayable, EnginePrompt, PlayerView, ViewCard, ViewPlayer } from "@cgwf/shared";
import { offZonePlays, playableIn, playCostLabel } from "./offZonePlays";

const card = (iid: string, kind: ViewCard["zone"]["kind"], owner: string) => ({ iid, owner, zone: { kind, owner }, faceDown: false, tapped: false, printingId: null }) as unknown as ViewCard;
const player = (id: string, name: string, zones: Partial<Pick<ViewPlayer, "exile" | "graveyard" | "command">> & { known?: ViewCard[]; hand?: ViewCard[] }) =>
  ({ id, name, exile: zones.exile ?? [], graveyard: zones.graveyard ?? [], command: zones.command ?? [], library: { count: 90, known: zones.known ?? [] }, hand: { count: zones.hand?.length ?? 0, cards: zones.hand ?? [] }, battlefield: { other: [], creatures: [], enchantments: [], lands: [], artifacts: [] } }) as unknown as ViewPlayer;
const play = (index: number, iid: string, cardName: string, zone: string, cost: string | null, kind: EnginePlayable["kind"] = "spell"): EnginePlayable => ({ index, iid, cardName, zone, kind, description: cardName, cost, targets: false });

// The owner's game: Party Thrasher's pick in my exile, two cards from Inside Information in Blair's exile, Zuko in the command zone.
const view = {
  turnOrder: ["blair", "me", "cara"],
  players: {
    me: player("me", "Georgie", { exile: [card("goblin", "exile", "me")], command: [card("zuko", "command", "me")], hand: [card("bolt", "hand", "me")] }),
    blair: player("blair", "Blair", { exile: [card("elves", "exile", "blair"), card("mystic", "exile", "blair"), card("lost", "exile", "blair")] }),
    cara: player("cara", "Cara", { graveyard: [card("gy", "graveyard", "cara")] }),
  },
} as unknown as PlayerView;
const prompt: EnginePrompt = { kind: "priority", promptId: 9, title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false, holding: false, options: [
  play(0, "bolt", "Lightning Bolt", "Hand", "{R}"),
  play(1, "goblin", "Raging Goblin", "Exile", "{R}"),
  play(2, "elves", "Llanowar Elves", "Exile", "{0}, Pay 1 life"),
  play(3, "mystic", "Elvish Mystic", "Exile", "{0}, Pay 1 life"),
  play(4, "zuko", "Fire Lord Zuko", "Command", "{R}{W}{B}"),
  play(5, "zuko", "Fire Lord Zuko", "Command", "{R}{W}{B}"),
] };

describe("cards playable from outside the hand and battlefield", () => {
  it("lists exile, the command zone and opponents' exile, mine first, then turn order", () => {
    const plays = offZonePlays(prompt, view, "me");
    expect(plays.map((p) => [p.card.iid, p.where])).toEqual([
      ["goblin", "Your exile"],
      ["zuko", "Your command zone"],
      ["elves", "Blair's exile"],
      ["mystic", "Blair's exile"],
    ]);
    expect(plays.find((p) => p.card.iid === "zuko")!.options.map((o) => o.index)).toEqual([4, 5]);
  });
  it("never lists the hand, cards that are not options, or anything when it is not a priority question", () => {
    const iids = offZonePlays(prompt, view, "me").map((p) => p.card.iid);
    expect(iids).not.toContain("bolt");
    expect(iids).not.toContain("lost");
    expect(iids).not.toContain("gy");
    expect(offZonePlays(null, view, "me")).toEqual([]);
    expect(offZonePlays({ kind: "confirm", promptId: 1, title: "?", detail: null, mode: null, options: ["Yes", "No"], source: null, card: null }, view, "me")).toEqual([]);
  });
  it("counts my own zones for the zone button badges", () => {
    const plays = offZonePlays(prompt, view, "me");
    expect(playableIn(plays, "me", "exile")).toBe(1); // Blair's exile is not on my button
    expect(playableIn(plays, "me", "command")).toBe(1);
    expect(playableIn(plays, "me", "graveyard")).toBe(0);
  });
  it("shows the alternative cost the engine reports", () => {
    expect(playCostLabel(play(0, "x", "Llanowar Elves", "Exile", "{0}, Pay 1 life"))).toBe("Pay 1 life");
    expect(playCostLabel(play(0, "x", "Raging Goblin", "Exile", "{R}"))).toBe("{R}");
    expect(playCostLabel(play(0, "x", "Mountain", "Exile", null, "land"))).toBe("Play land");
  });
});
