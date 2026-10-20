import { describe, expect, it } from "vitest";
import type { FirstRollInfo } from "@cgwf/shared";
import {
  FIRST_ROLL_RESULT_MS,
  firstRollStatus,
  firstRollVisible,
} from "./FirstRoll";

const seat = (
  s: number,
  name: string,
  value: number | null,
  contending = true,
  history: number[] = [],
) => ({
  seat: s,
  userId: `u${s}`,
  name,
  value,
  contending,
  history,
  auto: false,
});
const rolling: FirstRollInfo = {
  method: "roll",
  status: "rolling",
  round: 1,
  seats: [seat(0, "Alex", 17, true, [17]), seat(1, "Blair", null)],
  winnerSeat: null,
  doneAt: null,
};

describe("the who-goes-first overlay", () => {
  it("is up while rolling and for a few seconds after, unless dismissed", () => {
    expect(firstRollVisible(rolling, 0, null)).toBe(true);
    const done: FirstRollInfo = {
      ...rolling,
      status: "done",
      winnerSeat: 0,
      doneAt: 1000,
    };
    expect(firstRollVisible(done, 1000 + FIRST_ROLL_RESULT_MS - 1, null)).toBe(
      true,
    );
    expect(firstRollVisible(done, 1000 + FIRST_ROLL_RESULT_MS + 1, null)).toBe(
      false,
    );
    expect(firstRollVisible(done, 1001, 1000)).toBe(false);
    expect(firstRollVisible(null, 0, null)).toBe(false);
    expect(firstRollVisible({ ...rolling, method: "random" }, 0, null)).toBe(
      false,
    );
  });
  it("says what is happening", () => {
    expect(firstRollStatus(rolling)).toBe("Highest roll goes first");
    const tie: FirstRollInfo = {
      ...rolling,
      round: 2,
      seats: [
        seat(0, "Alex", null, true, [12]),
        seat(1, "Blair", null, true, [12]),
        seat(2, "Casey", null, false, [3]),
      ],
    };
    expect(firstRollStatus(tie)).toBe("Tie at 12: Alex and Blair roll again");
    expect(
      firstRollStatus({ ...rolling, status: "done", winnerSeat: 1, doneAt: 5 }),
    ).toBe("Blair goes first");
  });
});
