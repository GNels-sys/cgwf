import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnginePrompt, ViewCard } from "@cgwf/shared";
import { playableHand, zoomOptions, ZoomActions } from "./ZoomActions";
import { cardEnergy } from "./ElectricArc";

const prompt: EnginePrompt = { kind: "priority", promptId: 42, title: "Your move", phase: "MAIN1", myTurn: true, stackEmpty: true, stackTopMine: false, holding: false, options: [
  { index: 7, iid: "land", cardName: "Forest", zone: "hand", kind: "land", description: "Play Forest", cost: null, targets: false },
  { index: 12, iid: "walker", cardName: "Walker", zone: "battlefield", kind: "ability", description: "+1: Draw a card", cost: "+1", targets: false },
  { index: 18, iid: "walker", cardName: "Walker", zone: "battlefield", kind: "ability", description: "−2: Make a token", cost: "-2", targets: false },
] };

describe("zoom decisions use the live engine prompt", () => {
  it("retains the exact legal ability indices for one source", () => {
    expect(zoomOptions(prompt, "walker").map((option) => option.index)).toEqual([12, 18]);
    expect(zoomOptions(prompt, "unplayable")).toEqual([]);
  });
  it("offers no plays when waiting or answering another kind of question", () => {
    expect(zoomOptions(null, "walker")).toEqual([]);
    expect(zoomOptions({ kind: "confirm", promptId: 43, title: "Pay?", detail: null, mode: null, options: ["Yes", "No"], source: null, card: null }, "walker")).toEqual([]);
    expect(playableHand([], null)).toEqual([]);
  });
  it("browses only legal cards in hand, excluding hidden faces and preserving hand order", () => {
    const cards = [{ iid: "unplayable", faceDown: false }, { iid: "land", faceDown: false }, { iid: "walker", faceDown: true }] as ViewCard[];
    expect(playableHand(cards, prompt).map((card) => card.iid)).toEqual(["land"]);
    expect(playableHand(cards, null)).toEqual([]);
  });
  it("renders all loyalty descriptions and disables Play now when unavailable", () => {
    const abilities = renderToStaticMarkup(<ZoomActions options={zoomOptions(prompt, "walker")} onPick={() => {}} />);
    expect(abilities).toContain("+1: Draw a card");
    expect(abilities).toContain("−2: Make a token");
    const disabled = renderToStaticMarkup(<ZoomActions options={[]} hand onPick={() => {}} />);
    expect(disabled).toMatch(/<button[^>]+disabled/);
    expect(disabled).toContain("Play now");
  });
  it("uses card colors for a discharge, with a shared multicolor and colorless fallback", () => {
    expect(cardEnergy(["U"])).toBe("var(--mana-U)");
    expect(cardEnergy(["R"])).toBe("var(--mana-R)");
    expect(cardEnergy(["U", "B"])).toBe("var(--accent)");
    expect(cardEnergy([])).toBe("var(--mana-C)");
  });
});
