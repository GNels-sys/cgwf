import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_STOPS, convokeModeOf, respondModeOf } from "./engine.js";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.js";

/** The three-way "an opponent put something on the stack" setting (owner, 2026-10-29) and its older boolean. */
describe("engine stops: respond mode", () => {
  it("defaults to stopping only for threats", () => {
    expect(DEFAULT_ENGINE_STOPS.respondTo).toBe("threats");
    expect(respondModeOf({})).toBe("threats");
    expect(sanitizeSettings(DEFAULT_SETTINGS).engineStops.respondTo).toBe("threats");
  });

  it("reads settings saved before the mode existed: respond false = never, true = the new default", () => {
    const old = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: ["MAIN1"], theirTurn: [], respond: false, autoPassEmpty: true } });
    expect(old.engineStops.respondTo).toBe("never");
    expect(old.engineStops.respond).toBe(false);
    const on = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: ["MAIN1"], theirTurn: [], respond: true, autoPassEmpty: true } });
    expect(on.engineStops.respondTo).toBe("threats");
    expect(on.engineStops.respond).toBe(true);
  });

  it("convoke asks only when needed unless the player says otherwise (2026-11-04)", () => {
    expect(DEFAULT_ENGINE_STOPS.convoke).toBe("needed");
    expect(convokeModeOf({})).toBe("needed");
    expect(convokeModeOf({ convoke: "ask" })).toBe("ask");
    expect(convokeModeOf({ convoke: "bogus" })).toBe("needed");
    const old = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: [], theirTurn: [], respond: true, autoPassEmpty: true } });
    expect(old.engineStops.convoke).toBe("needed");
    const never = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: [], theirTurn: [], respond: true, convoke: "never", autoPassEmpty: true } });
    expect(never.engineStops.convoke).toBe("never");
  });

  it("keeps an explicit mode and keeps the boolean in step for older engines", () => {
    const always = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: [], theirTurn: [], respond: false, respondTo: "always", autoPassEmpty: true } });
    expect(always.engineStops.respondTo).toBe("always");
    expect(always.engineStops.respond).toBe(true);
    const never = sanitizeSettings({ ...DEFAULT_SETTINGS, engineStops: { myTurn: [], theirTurn: [], respond: true, respondTo: "never", autoPassEmpty: true } });
    expect(never.engineStops.respondTo).toBe("never");
    expect(never.engineStops.respond).toBe(false);
    expect(respondModeOf({ respondTo: "bogus", respond: true })).toBe("threats");
  });
});
