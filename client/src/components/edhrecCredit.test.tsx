// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryImportInfo } from "@cgwf/shared";
import { EdhrecCredit } from "./EdhrecCredit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner, 2026-11-17: Bracket 2 EDHREC decks that the bracket rules rate higher are not dealt to bots. The
 * library says so on the row and on the deck page, unless the owner switched the deck on by hand.
 */
const hold = "the bracket rules put it at Bracket 4 or higher, above the Bracket 2 it is filed under";
const info: LibraryImportInfo = {
  provider: "edhrec",
  slug: "krenko-mob-boss",
  edhrecBracket: "core",
  decks: 3953,
  rank: 4,
  winCondition: "Combat",
  fetchedAt: "2026-11-17T23:20:00.000Z",
  pickReason: "#4 by core decks (3953)",
  mismatch: null,
  coverage: { checkedAt: "2026-11-17T23:50:00.000Z", missing: [] },
  coverageError: null,
  botHold: hold,
};
const deck = (agentEligible: boolean, importInfo: LibraryImportInfo = info) => ({ source: "edhrec" as const, sourceUrl: "https://edhrec.com/average-decks/krenko-mob-boss/core", importInfo, agentEligible });

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

describe("EDHREC credit: decks held back from bots", () => {
  it("says on the deck page why bots are not dealt the deck, and how to deal it anyway", () => {
    act(() => root.render(<EdhrecCredit deck={deck(false)} />));
    expect(host.textContent).toContain(`Computer opponents are not dealt this deck: ${hold}. People can still play it.`);
    expect(host.textContent).toContain('Switch "bot-eligible" on above to deal it anyway.');
  });

  it("marks the library row", () => {
    act(() => root.render(<EdhrecCredit deck={deck(false)} compact />));
    const chip = host.querySelector(".chip");
    expect(chip?.textContent).toBe("not for bots");
    expect(chip?.getAttribute("title")).toBe(`Not dealt to bots: ${hold}`);
  });

  it("says nothing once the owner switched the deck on, or when there is no hold", () => {
    act(() => root.render(<EdhrecCredit deck={deck(true)} />));
    expect(host.textContent).not.toContain("not dealt");
    act(() => root.render(<EdhrecCredit deck={deck(false, { ...info, botHold: null })} compact />));
    expect(host.querySelector(".chip")).toBeNull();
  });
});
