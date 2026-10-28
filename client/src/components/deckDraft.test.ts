import { describe, expect, it } from "vitest";
import { deckSizeProblem, type CardSummary, type DeckCardEntry } from "@cgwf/shared";
import { addCard, copiesInDeck, draftTotal, isDirty, lastChange, removeOne, setLinePrinting, startDraft, toSaveInput, undo, HISTORY_MAX } from "./deckDraft";

const card = (id: string, name: string, oracleId = `o-${name}`): CardSummary => ({ id, oracleId, name, set: "cmm", collectorNumber: id, manaCost: "{1}", typeLine: "Artifact", layout: "normal", isToken: false, faceCount: 1 });
const entry = (entryId: number, c: CardSummary, quantity: number, board: DeckCardEntry["board"] = "main"): DeckCardEntry => ({ entryId, cardId: c.id, quantity, board, category: null, card: c });

// a 100-card deck: commander + Sol Ring + 98 Mountains, plus a maybeboard card that never counts
const krenko = card("k1", "Krenko, Mob Boss");
const sol = card("s1", "Sol Ring");
const mountain = card("m1", "Mountain");
const maybe = card("x1", "Maybe Card");
const saved = [entry(1, krenko, 1, "commander"), entry(2, sol, 1), entry(3, mountain, 98), entry(4, maybe, 1, "maybeboard")];

describe("the deck editor's draft", () => {
  it("starts from the saved list and counts only main + commander", () => {
    const d = startDraft(saved);
    expect(draftTotal(d)).toBe(100);
    expect(isDirty(d, saved)).toBe(false);
    expect(lastChange(d)).toBeNull();
  });

  it("adding a card makes 101, and saving would be refused with the owner's message", () => {
    const d = addCard(startDraft(saved), card("b1", "Brainstone"));
    expect(draftTotal(d)).toBe(101);
    expect(deckSizeProblem(draftTotal(d))).toBe("Your deck currently has 101 cards. Please remove 1 card prior to saving.");
    expect(lastChange(d)).toBe("Added Brainstone");
    expect(isDirty(d, saved)).toBe(true);
  });

  it("adding the same printing again adds a copy to its line", () => {
    const d = addCard(addCard(startDraft(saved), mountain), mountain);
    expect(d.lines.find((l) => l.cardId === "m1")!.quantity).toBe(100);
    expect(copiesInDeck(d, mountain)).toBe(100);
  });

  it("minus takes one copy off, and the line goes with its last copy", () => {
    let d = removeOne(startDraft(saved), "e3");
    expect(d.lines.find((l) => l.key === "e3")!.quantity).toBe(97);
    d = removeOne(d, "e2");
    expect(d.lines.some((l) => l.key === "e2")).toBe(false);
    expect(draftTotal(d)).toBe(98);
    expect(deckSizeProblem(98)).toBe("Your deck currently has 98 cards. Please add 2 cards prior to saving.");
    expect(lastChange(d)).toBe("Removed Sol Ring");
  });

  it("undo brings back an accidental removal, one step at a time", () => {
    const start = startDraft(saved);
    const removed = removeOne(removeOne(start, "e2"), "e3");
    const once = undo(removed);
    expect(once.lines.find((l) => l.key === "e3")!.quantity).toBe(98);
    expect(once.lines.some((l) => l.key === "e2")).toBe(false);
    const twice = undo(once);
    expect(twice.lines).toEqual(start.lines);
    expect(undo(twice)).toBe(twice); // nothing left to undo
    expect(isDirty(twice, saved)).toBe(false);
  });

  it("a swap (add one, remove one) is back to 100 and saves as a full list", () => {
    const d = removeOne(addCard(startDraft(saved), card("b1", "Brainstone")), "e2");
    expect(draftTotal(d)).toBe(100);
    expect(deckSizeProblem(draftTotal(d))).toBeNull();
    expect(toSaveInput(d)).toEqual([
      { cardId: "k1", quantity: 1, board: "commander", category: null },
      { cardId: "m1", quantity: 98, board: "main", category: null },
      { cardId: "x1", quantity: 1, board: "maybeboard", category: null },
      { cardId: "b1", quantity: 1, board: "main", category: null },
    ]);
  });

  it("a printing change while editing stays on the same line and can be undone", () => {
    const other = card("s2", "Sol Ring", sol.oracleId!);
    const d = setLinePrinting(startDraft(saved), "e2", other);
    expect(d.lines.find((l) => l.key === "e2")!.cardId).toBe("s2");
    expect(draftTotal(d)).toBe(100);
    expect(undo(d).lines.find((l) => l.key === "e2")!.cardId).toBe("s1");
  });

  it("keeps a bounded history", () => {
    let d = startDraft(saved);
    for (let i = 0; i < HISTORY_MAX + 10; i++) d = addCard(d, mountain);
    expect(d.history).toHaveLength(HISTORY_MAX);
  });
});
