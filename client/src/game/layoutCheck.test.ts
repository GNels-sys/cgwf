import { describe, expect, it } from "vitest";
import { layoutProblems, type LayoutSample } from "./layoutCheck";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const base = (over: Partial<LayoutSample> = {}): LayoutSample => ({
  landscape: true,
  viewport: { width: 812, height: 375 },
  controls: [
    { name: "Hold", box: box(735, 55, 792, 95), reachable: true },
    { name: "Game Log minimise", box: box(754, 143, 792, 181), reachable: true },
  ],
  board: null,
  log: box(526, 140, 796, 276),
  ...over,
});

describe("layout check", () => {
  it("passes a clean table", () => {
    expect(layoutProblems(base())).toEqual([]);
  });

  it("flags both side panels open at landscape (the rotation glitch)", () => {
    expect(layoutProblems(base({ board: box(1, 140, 461, 276) }))).toEqual(["landscape: Active Board and Game Log are both open"]);
    expect(layoutProblems(base({ landscape: false, viewport: { width: 375, height: 812 }, board: box(0, 270, 375, 400), controls: [] }))).toEqual([]);
  });

  it("flags a control covered by an overlay (the Stack panel over the log's minimise button)", () => {
    const s = base();
    s.controls[1]!.reachable = false;
    expect(layoutProblems(s)).toEqual(["Game Log minimise: covered by another element"]);
  });

  it("flags a control pushed off screen and ignores ones not rendered", () => {
    const s = base({ controls: [{ name: "engine bar action", box: box(780, 95, 860, 135), reachable: true }, { name: "Board tab", box: box(0, 0, 0, 0), reachable: false }] });
    expect(layoutProblems(s)).toEqual(["engine bar action: off screen (780,95 to 860,135 in 812x375)"]);
  });
});
