import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDE_GRACE_MS, HoverController, SHOW_DELAY_MS, placePreview, pointerPreviewAllowed, previewWidth, type PreviewState } from "./hoverPreview";

const bolt = { id: "bolt", name: "Lightning Bolt", faceCount: 1 };
const ring = { id: "ring", name: "Sol Ring", faceCount: 1 };

describe("hover preview visibility rules", () => {
  let seen: Array<PreviewState | null>;
  let ctl: HoverController;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    ctl = new HoverController((s) => seen.push(s));
  });
  afterEach(() => vi.useRealTimers());

  it("only a hovering mouse or pen on a hover-capable device previews; touch never does", () => {
    expect(pointerPreviewAllowed(true, "mouse")).toBe(true);
    expect(pointerPreviewAllowed(true, "pen")).toBe(true);
    expect(pointerPreviewAllowed(true, "touch")).toBe(false);
    expect(pointerPreviewAllowed(false, "mouse")).toBe(false);
    ctl.enter(bolt, { x: 10, y: 10 }, "touch", true);
    ctl.enter(bolt, { x: 10, y: 10 }, "mouse", false);
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
  });

  it("waits before the first preview and shows nothing if the pointer leaves first", () => {
    ctl.enter(bolt, { x: 10, y: 10 }, "mouse", true);
    vi.advanceTimersByTime(SHOW_DELAY_MS - 1);
    expect(ctl.state).toBeNull();
    ctl.leave();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual([]);
    ctl.enter(bolt, { x: 10, y: 10 }, "mouse", true);
    ctl.move({ x: 30, y: 40 });
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(ctl.state).toMatchObject({ card: bolt, anchor: { x: 30, y: 40 }, via: "pointer" });
  });

  it("moving between lines swaps the card at once without hiding in between (no flicker)", () => {
    ctl.enter(bolt, { x: 10, y: 10 }, "mouse", true);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    ctl.leave();
    ctl.enter(ring, { x: 10, y: 40 }, "mouse", true);
    expect(ctl.state?.card).toEqual(ring);
    vi.advanceTimersByTime(HIDE_GRACE_MS * 3);
    expect(ctl.state?.card).toEqual(ring);
    expect(seen.every((s) => s !== null)).toBe(true);
    ctl.leave();
    vi.advanceTimersByTime(HIDE_GRACE_MS);
    expect(ctl.state).toBeNull();
  });

  it("a click hides it at once; keyboard focus previews only with a visible focus ring", () => {
    ctl.enter(bolt, { x: 10, y: 10 }, "mouse", true);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    ctl.hideNow();
    expect(ctl.state).toBeNull();
    ctl.focus(ring, { x: 200, y: 50 }, false);
    expect(ctl.state).toBeNull();
    ctl.focus(ring, { x: 200, y: 50 }, true);
    expect(ctl.state).toMatchObject({ card: ring, via: "focus" });
    ctl.move({ x: 1, y: 1 });
    expect(ctl.state?.anchor).toEqual({ x: 200, y: 50 });
    ctl.blur();
    expect(ctl.state).toBeNull();
  });
});

describe("hover preview placement", () => {
  const vp = { w: 1280, h: 800 };
  it("sits right of the cursor, flips left near the right edge, and stays inside the viewport", () => {
    const box = { w: 250, h: 349 };
    expect(placePreview({ x: 100, y: 400 }, box, vp)).toMatchObject({ side: "right", left: 118 });
    const flipped = placePreview({ x: 1200, y: 400 }, box, vp);
    expect(flipped.side).toBe("left");
    expect(flipped.left).toBe(1200 - 18 - 250);
    expect(placePreview({ x: 100, y: 5 }, box, vp).top).toBe(12);
    expect(placePreview({ x: 100, y: 795 }, box, vp).top).toBe(800 - 12 - 349);
  });

  it("keeps the whole card on screen in short windows (63:88)", () => {
    const w = previewWidth({ w: 1280, h: 400 });
    expect((w * 88) / 63).toBeLessThanOrEqual(400 - 24);
    expect(previewWidth(vp)).toBe(250);
  });
});
