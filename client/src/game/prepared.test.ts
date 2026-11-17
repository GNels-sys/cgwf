import { describe, expect, it } from "vitest";
import type { EnginePlayable, EnginePrompt, PlayerView, ViewCard, ViewPlayer } from "@cgwf/shared";
import { optionsForCard, preparedCasters, prepareLine, withoutPrepareKeyword } from "./prepared";
import { offZonePlays } from "./offZonePlays";

const card = (iid: string, kind: ViewCard["zone"]["kind"], owner: string, engine?: Partial<NonNullable<ViewCard["engine"]>>) =>
  ({ iid, owner, zone: { kind, owner }, faceDown: false, tapped: false, printingId: null, engine: { power: null, toughness: null, damage: 0, sick: false, ...engine } }) as unknown as ViewCard;
const player = (id: string, name: string, creatures: ViewCard[], exile: ViewCard[] = []) =>
  ({ id, name, exile, graveyard: [], command: [], library: { count: 90, known: [] }, hand: { count: 0, cards: [] }, battlefield: { other: [], creatures, enchantments: [], lands: [], artifacts: [] } }) as unknown as ViewPlayer;
const play = (index: number, iid: string, cardName: string, zone: string, cost: string | null, kind: EnginePlayable["kind"] = "spell"): EnginePlayable => ({ index, iid, cardName, zone, kind, description: cardName, cost, targets: false });

// The owner's game: Grave Researcher prepared (Reanimate waits in exile), Stensian Sanguinist not prepared.
const researcher = card("211", "battlefield", "me", { prepare: { name: "Reanimate", ready: true, spellIid: "212" } });
const sanguinist = card("90", "battlefield", "me", { prepare: { name: "Exsanguinate", ready: false, spellIid: null } });
const bears = card("5", "battlefield", "me");
const copy = card("212", "exile", "me", { preparedBy: { iid: "211", name: "Grave Researcher" } });
const theirs = card("300", "battlefield", "blair", { prepare: { name: "Seething Song", ready: true, spellIid: "301" } });
const view = {
  turnOrder: ["me", "blair"],
  players: { me: player("me", "Georgie", [researcher, sanguinist, bears], [copy]), blair: player("blair", "Blair", [theirs], [card("301", "exile", "blair", { preparedBy: { iid: "300", name: "Blazing Firesinger" } })]) },
} as unknown as PlayerView;
const prompt: EnginePrompt = { kind: "priority", promptId: 4, title: "You have priority", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false, holding: false, options: [
  play(0, "212", "Reanimate", "Exile", "{B}"),
  play(1, "5", "Grizzly Bears", "Battlefield", "{T}", "ability"),
] };

describe("a prepared creature stands for its spell", () => {
  it("glows when its spell is one of the plays, and only then", () => {
    expect(preparedCasters(prompt, view)).toEqual(["211"]);
    expect(preparedCasters({ ...prompt, options: [prompt.options[1]!] }, view)).toEqual([]);
    expect(preparedCasters(null, view)).toEqual([]);
  });
  it("a tap on it finds the spell's option; other cards keep their own", () => {
    expect(optionsForCard(prompt, researcher).map((o) => o.index)).toEqual([0]);
    expect(optionsForCard(prompt, copy).map((o) => o.index)).toEqual([0]);
    expect(optionsForCard(prompt, bears).map((o) => o.index)).toEqual([1]);
    expect(optionsForCard(prompt, sanguinist)).toEqual([]);
    expect(optionsForCard(prompt, theirs)).toEqual([]);
  });
  it("says where the creature stands in the card view", () => {
    expect(prepareLine(researcher, true)).toBe("Prepared. You may cast Reanimate: tap this card while it glows. Casting it unprepares this creature.");
    expect(prepareLine(theirs, false)).toBe("Prepared. Its controller may cast Seething Song; casting it unprepares this creature.");
    expect(prepareLine(sanguinist, true)).toBe("Not prepared. Exsanguinate can be cast only while this creature is prepared, and its own text says when that happens.");
    expect(prepareLine(copy, true)).toBe("Grave Researcher's prepared spell. It waits here until it is cast or that creature leaves the battlefield.");
    expect(prepareLine(bears, true)).toBeNull();
  });
  it("drops the card database's always-on \"prepared\" keyword where the real state is known", () => {
    expect(withoutPrepareKeyword(["treasure", "prepared"], sanguinist)).toEqual(["treasure"]);
    expect(withoutPrepareKeyword(["flying", "Prepared"], researcher)).toEqual(["flying"]);
    expect(withoutPrepareKeyword(["prepared", "trample"], bears)).toEqual(["prepared", "trample"]);
  });
  it("the play button in the bar names the creature, not just the exile", () => {
    expect(offZonePlays(prompt, view, "me").map((p) => [p.card.iid, p.where])).toEqual([["212", "Grave Researcher's prepared spell"]]);
  });
});
