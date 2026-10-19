import { describe, expect, it } from "vitest";
import { isRegularPrinting, printingTreatments, type PrintingTraits } from "./printing.js";

const plain: PrintingTraits = {
  set: "fdn",
  setType: "core",
  frame: "2015",
  frameEffects: ["legendary"],
  borderColor: "black",
  fullArt: false,
  textless: false,
  promo: false,
  promoTypes: ["universesbeyond", "startercollection"],
  finishes: ["nonfoil", "foil"],
  oversized: false,
  releasedAt: "2024-11-15",
};

describe("printing treatments", () => {
  it("a normal-frame, black-border, non-promo printing is regular (legendary frames and Universes Beyond included)", () => {
    expect(printingTreatments(plain)).toEqual([]);
    expect(isRegularPrinting(plain)).toBe(true);
    expect(isRegularPrinting({ ...plain, borderColor: "white", frame: "1993", releasedAt: "1994-01-01" })).toBe(true);
  });

  it("labels the special treatments players see on Scryfall", () => {
    expect(printingTreatments({ ...plain, borderColor: "borderless", frameEffects: ["inverted"], fullArt: true, promoTypes: ["boosterfun"] })).toEqual(["Borderless", "Inverted frame", "Full art", "Booster Fun"]);
    expect(printingTreatments({ ...plain, frameEffects: ["showcase"] })).toEqual(["Showcase"]);
    expect(printingTreatments({ ...plain, frameEffects: ["extendedart"] })).toEqual(["Extended art"]);
    expect(printingTreatments({ ...plain, set: "plst", setType: "masters" })).toEqual(["The List"]);
    expect(printingTreatments({ ...plain, set: "sld", setType: "box" })).toEqual(["Secret Lair"]);
    expect(printingTreatments({ ...plain, promoTypes: ["surgefoil"], finishes: ["foil"] })).toEqual(["Surge foil", "Foil only"]);
    // Final Fantasy / Fallout precon cards: tagged surge foil, but the non-foil copy is the plain card.
    expect(printingTreatments({ ...plain, promoTypes: ["surgefoil", "universesbeyond"], finishes: ["nonfoil", "foil"] })).toEqual([]);
    expect(printingTreatments({ ...plain, finishes: ["etched"], frameEffects: ["etched"] })).toEqual(["Etched", "Etched only"]);
    expect(printingTreatments({ ...plain, promo: true })).toEqual(["Promo"]);
    expect(printingTreatments({ ...plain, frame: "1997", releasedAt: "2023-03-01" })).toEqual(["Retro frame"]);
    expect(printingTreatments({ ...plain, promoTypes: ["chocobotrackfoil"], finishes: ["foil"] })).toEqual(["chocobotrack foil", "Foil only"]);
    expect(printingTreatments({ ...plain, oversized: true })).toEqual(["Oversized"]);
  });

  it("missing data (rows from before the 2026-10-19 ingest) reads as no treatment", () => {
    expect(printingTreatments({ ...plain, setType: "", frame: "", frameEffects: [], borderColor: "", finishes: [], promoTypes: [] })).toEqual([]);
  });
});
