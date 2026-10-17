import { describe, expect, it } from "vitest";
import { conditionLabel, finishLabel, linkLabel, money, relativeTime, sourceSentence, statusMessage } from "./storeText";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");

describe("local store wording", () => {
  it("writes relative times a player understands", () => {
    expect(relativeTime("2026-10-17T11:59:40.000Z", NOW)).toBe("just now");
    expect(relativeTime("2026-10-17T11:48:00.000Z", NOW)).toBe("12 minutes ago");
    expect(relativeTime("2026-10-17T11:59:00.000Z", NOW)).toBe("1 minute ago");
    expect(relativeTime("2026-10-17T09:00:00.000Z", NOW)).toBe("3 hours ago");
    expect(relativeTime("2026-10-16T12:00:00.000Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-10-13T12:00:00.000Z", NOW)).toBe("4 days ago");
    expect(relativeTime(null, NOW)).toBe("at an unknown time");
    expect(relativeTime("garbage", NOW)).toBe("at an unknown time");
  });

  it("names the source and the age on every panel", () => {
    expect(sourceSentence({ status: "ok", dataAsOf: "2026-10-17T09:00:00.000Z", cached: false }, NOW)).toBe("Updated 3 hours ago, from local store data.");
    expect(sourceSentence({ status: "ok", dataAsOf: "2026-10-17T09:00:00.000Z", cached: true }, NOW)).toContain("Shown from a recent check");
    expect(sourceSentence({ status: "unavailable", dataAsOf: null, cached: false }, NOW)).toBe("From local store data.");
  });

  it("explains an outage and an unconfigured server in plain words", () => {
    expect(statusMessage({ status: "ok" })).toBeNull();
    expect(statusMessage({ status: "unavailable", reason: "circuit open" })).toContain("unavailable right now");
    expect(statusMessage({ status: "unconfigured" })).toContain("not switched on");
  });

  it("formats money, finishes, conditions and link labels", () => {
    expect(money(1.86)).toBe("$1.86");
    expect(money(null)).toBe("price not listed");
    expect(finishLabel("etched")).toBe("Etched foil");
    expect(conditionLabel("LP")).toBe("Lightly played");
    expect(conditionLabel(null)).toBe("condition not listed");
    expect(linkLabel("page")).toBe("Open catalog page");
    expect(linkLabel("search")).toBe("Search the store");
  });
});
