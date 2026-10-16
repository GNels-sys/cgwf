import { describe, expect, it } from "vitest";
import { landingFor, shouldShowTour, TOUR_STEPS } from "./onboarding.js";

describe("welcome routing", () => {
  it("sends a brand-new visitor to the welcome screen", () => {
    expect(landingFor({ hasToken: false, loading: false, signedIn: false })).toBe("welcome");
  });
  it("waits while a stored token is being checked, then shows the app", () => {
    expect(landingFor({ hasToken: true, loading: true, signedIn: false })).toBe("loading");
    expect(landingFor({ hasToken: true, loading: false, signedIn: true })).toBe("app");
  });
  it("shows the welcome screen when the stored token turned out to be dead", () => {
    expect(landingFor({ hasToken: true, loading: false, signedIn: false })).toBe("welcome");
  });
  it("shows the tour once after the first profile and never after dismissal", () => {
    expect(shouldShowTour("pending", true)).toBe(true);
    expect(shouldShowTour("pending", false)).toBe(false);
    expect(shouldShowTour("done", true)).toBe(false);
    expect(shouldShowTour("none", true)).toBe(false);
    expect(TOUR_STEPS).toHaveLength(3);
  });
});
