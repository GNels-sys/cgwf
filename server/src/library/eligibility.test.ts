import { describe, expect, it } from "vitest";
import { decideEligibility, type EligibilityInput } from "./eligibility.js";

const base: EligibilityInput = { current: false, eligibleBy: null, source: "precon", clean: true, enable: true };

describe("agent eligibility from a rules-engine check", () => {
  it("switches a clean, undecided deck on and records that the check did it", () => {
    expect(decideEligibility(base)).toEqual({ eligible: true, eligibleBy: "coverage", outcome: "enabled" });
    expect(decideEligibility({ ...base, enable: false })).toMatchObject({ eligible: false, outcome: "unchanged" });
  });

  it("never switches off a deck the owner switched on, and never switches on one the owner switched off", () => {
    expect(decideEligibility({ ...base, current: true, eligibleBy: "owner", clean: false })).toEqual({ eligible: true, eligibleBy: "owner", outcome: "kept-by-owner" });
    expect(decideEligibility({ ...base, current: false, eligibleBy: "owner", clean: true })).toEqual({ eligible: false, eligibleBy: "owner", outcome: "unchanged" });
  });

  it("treats a precon that was already on with no record as the owner's choice (switched on by hand before records existed)", () => {
    expect(decideEligibility({ ...base, current: true, eligibleBy: null, clean: false })).toEqual({ eligible: true, eligibleBy: "owner", outcome: "kept-by-owner" });
  });

  it("switches off a deck it switched on itself once Forge can no longer play it; EDHREC imports count as the check's", () => {
    expect(decideEligibility({ ...base, current: true, eligibleBy: "coverage", clean: false })).toEqual({ eligible: false, eligibleBy: null, outcome: "disabled" });
    expect(decideEligibility({ ...base, source: "edhrec", current: true, eligibleBy: null, clean: false })).toMatchObject({ eligible: false, outcome: "disabled" });
  });

  it("changes nothing when the check could not run", () => {
    expect(decideEligibility({ ...base, clean: null })).toMatchObject({ eligible: false, outcome: "unchanged" });
    expect(decideEligibility({ ...base, current: true, eligibleBy: "coverage", clean: null })).toMatchObject({ eligible: true, outcome: "unchanged" });
  });
});
