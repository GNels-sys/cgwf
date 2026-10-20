import type { EnginePrompt } from "@cgwf/shared";

type MulliganPrompt = Extract<EnginePrompt, { kind: "mulligan" }>;

/** The line under "Keep this hand?" on engine tables: hand size, mulligans so far, free ones, the next bottom count. */
export function mulliganNote(p: MulliganPrompt): string {
  const m = p.mulligans;
  const free = p.freeMulligans;
  if (m === undefined) {
    // an engine from before 2026-10-20 (no counts in the prompt)
    return p.cardsToReturn > 0
      ? `${p.hand.length} cards after ${p.cardsToReturn} on the bottom.`
      : "Seven cards. The rules engine shuffles and deals.";
  }
  if (m === 0) {
    if (free === undefined)
      return "Seven cards. The rules engine shuffles and deals.";
    if (free === 0)
      return "Seven cards. No free mulligans: each mulligan puts one more card on the bottom.";
    return `Seven cards. Your first ${free === 1 ? "mulligan is" : `${free} mulligans are`} free.`;
  }
  const freeUsed = free === undefined ? null : Math.min(m, free);
  const head = `${p.hand.length} cards after ${m} mulligan${m === 1 ? "" : "s"}${freeUsed ? ` (${freeUsed} free)` : ""}.`;
  if (p.nextBottom === undefined) return head;
  return `${head} Another mulligan deals seven and puts ${p.nextBottom === 0 ? "none" : p.nextBottom} on the bottom.`;
}
