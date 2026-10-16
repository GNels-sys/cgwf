import { describe, expect, it } from "vitest";
import { classifyImportUrl } from "./archidekt.js";

describe("classifyImportUrl", () => {
  it("recognises Archidekt deck links in their common shapes", () => {
    expect(classifyImportUrl("https://archidekt.com/decks/7031486/buffs_by_hans")).toEqual({ kind: "archidekt", id: "7031486" });
    expect(classifyImportUrl("https://www.archidekt.com/decks/7031486")).toEqual({ kind: "archidekt", id: "7031486" });
    expect(classifyImportUrl("https://archidekt.com/api/decks/7031486/")).toEqual({ kind: "archidekt", id: "7031486" });
  });
  it("flags Moxfield and rejects anything else", () => {
    expect(classifyImportUrl("https://www.moxfield.com/decks/XyZ")).toEqual({ kind: "moxfield" });
    expect(classifyImportUrl("https://example.com/decks/1")).toEqual({ kind: "unknown" });
    expect(classifyImportUrl("garbage")).toEqual({ kind: "unknown" });
  });
});
