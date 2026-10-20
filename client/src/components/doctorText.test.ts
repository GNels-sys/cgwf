import { describe, expect, it } from "vitest";
import { stockText } from "./doctorText";

describe("Deck Doctor wording", () => {
  it("says where a suggested card is in stock, and nothing when it is not or nobody knows", () => {
    expect(stockText(2, 1.25)).toBe("In stock at 2 local stores (from $1.25)");
    expect(stockText(1, null)).toBe("In stock at 1 local store");
    expect(stockText(0, 3)).toBeNull();
    expect(stockText(null, null)).toBeNull();
  });
});
