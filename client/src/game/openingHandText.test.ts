import { describe, expect, it } from "vitest";
import type { EnginePrompt } from "@cgwf/shared";
import { mulliganNote } from "./openingHandText";

type P = Extract<EnginePrompt, { kind: "mulligan" }>;
const hand = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        iid: String(i),
        name: "Mountain",
        printingId: null,
      }) as unknown as P["hand"][number],
  );
const p = (over: Partial<P>): P => ({
  kind: "mulligan",
  promptId: 1,
  title: "Keep this hand?",
  cardsToReturn: 0,
  hand: hand(7),
  ...over,
});

describe("the keep-this-hand line", () => {
  it("says how many mulligans are free before the first one", () => {
    expect(
      mulliganNote(p({ mulligans: 0, freeMulligans: 1, nextBottom: 0 })),
    ).toBe("Seven cards. Your first mulligan is free.");
    expect(
      mulliganNote(p({ mulligans: 0, freeMulligans: 2, nextBottom: 0 })),
    ).toBe("Seven cards. Your first 2 mulligans are free.");
    expect(
      mulliganNote(p({ mulligans: 0, freeMulligans: 0, nextBottom: 1 })),
    ).toBe(
      "Seven cards. No free mulligans: each mulligan puts one more card on the bottom.",
    );
  });
  it("counts free mulligans used and the next bottom count", () => {
    expect(
      mulliganNote(p({ mulligans: 1, freeMulligans: 1, nextBottom: 1 })),
    ).toBe(
      "7 cards after 1 mulligan (1 free). Another mulligan deals seven and puts 1 on the bottom.",
    );
    expect(
      mulliganNote(
        p({
          mulligans: 2,
          freeMulligans: 1,
          nextBottom: 2,
          hand: hand(6),
          cardsToReturn: 1,
        }),
      ),
    ).toBe(
      "6 cards after 2 mulligans (1 free). Another mulligan deals seven and puts 2 on the bottom.",
    );
    expect(
      mulliganNote(p({ mulligans: 1, freeMulligans: 2, nextBottom: 0 })),
    ).toBe(
      "7 cards after 1 mulligan (1 free). Another mulligan deals seven and puts none on the bottom.",
    );
  });
  it("still reads an older engine's prompt", () => {
    expect(mulliganNote(p({}))).toBe(
      "Seven cards. The rules engine shuffles and deals.",
    );
  });
});
