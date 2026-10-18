import { describe, expect, it } from "vitest";
import { INITIAL_PANELS, panelsReducer, type PanelEvent, type PanelState } from "./sidePanels";

const run = (events: PanelEvent[], from: PanelState = INITIAL_PANELS) => events.reduce(panelsReducer, from);
const L = (opponentsTurn = false): PanelEvent => ({ type: "layout", landscape: true, opponentsTurn });
const P = (opponentsTurn = false): PanelEvent => ({ type: "layout", landscape: false, opponentsTurn });

describe("side overlays (Active Board + Game Log)", () => {
  it("landscape: opening one closes the other, and the board hands the log back", () => {
    let s = run([{ type: "openBoard", landscape: true }]);
    expect(s).toMatchObject({ board: true, log: false, logYielded: true });
    s = panelsReducer(s, { type: "closeBoard" });
    expect(s).toMatchObject({ board: false, log: true });
    s = run([{ type: "openBoard", landscape: true }, { type: "openLog", landscape: true }]);
    expect(s).toMatchObject({ board: false, log: true, logYielded: false });
  });

  it("portrait stacks them", () => {
    const s = run([P(), { type: "openBoard", landscape: false }]);
    expect(s).toMatchObject({ board: true, log: true });
  });

  it("the reported glitch: both open in portrait, rotate to landscape, never both open", () => {
    const both = run([P(), { type: "openBoard", landscape: false }]);
    // my turn: the log stays, the board steps back to its tab
    expect(panelsReducer(both, L(false))).toMatchObject({ board: false, log: true });
    // an opponent's turn: the board stays, the log steps aside and comes back with the board's close
    const opp = panelsReducer(both, L(true));
    expect(opp).toMatchObject({ board: true, log: false, logYielded: true });
    expect(panelsReducer(opp, { type: "closeBoard" })).toMatchObject({ board: false, log: true });
  });

  it("rotating back to portrait gives back a log that only stepped aside", () => {
    const s = run([{ type: "openBoard", landscape: true }, P()]);
    expect(s).toMatchObject({ board: true, log: true, logYielded: false });
    // and a log the player closed stays closed
    const closed = run([{ type: "closeLog" }, { type: "openBoard", landscape: true }, P()]);
    expect(closed).toMatchObject({ board: true, log: false });
  });

  it("a stale orientation cannot happen: each open carries the live one", () => {
    // the prod case: rotated to portrait, tapped Board before any media-query event; the tap reads portrait
    const s = run([{ type: "openBoard", landscape: false }]);
    expect(s).toMatchObject({ board: true, log: true });
  });

  it("many rotations with random opens and closes keep the rules (seeded fuzz)", () => {
    let seed = 0x5eed;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let s = INITIAL_PANELS;
    let landscape = true;
    for (let i = 0; i < 2000; i++) {
      const r = rand();
      let e: PanelEvent;
      if (r < 0.3) {
        landscape = !landscape;
        e = { type: "layout", landscape, opponentsTurn: rand() < 0.5 };
      } else if (r < 0.5) e = { type: "openBoard", landscape };
      else if (r < 0.65) e = { type: "closeBoard" };
      else if (r < 0.85) e = { type: "openLog", landscape };
      else e = { type: "closeLog" };
      const next = panelsReducer(s, e);
      if (landscape) expect(next.board && next.log, `step ${i}: ${JSON.stringify(e)}`).toBe(false);
      if (next.logYielded) expect(next.log, `step ${i}: a yielded log is closed`).toBe(false);
      // layout is idempotent: a second resize event changes nothing
      if (e.type === "layout") expect(panelsReducer(next, e)).toEqual(next);
      s = next;
    }
  });
});
