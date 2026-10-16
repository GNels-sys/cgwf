import { describe, expect, it } from "vitest";
import { viewFor } from "@cgwf/shared";
import { apply, secretDeck, startedGame } from "./fixtures.js";
import { renderDelta, renderState, systemPrompt } from "./prompt.js";
import { costOf } from "./pricing.js";

const PLAYERS = [
  { id: "agent", name: "Krenko bot" },
  { id: "blair", name: "Blair" },
  { id: "casey", name: "Casey" },
];

function game() {
  const decks = { agent: secretDeck("Agent", 24), blair: secretDeck("Blair", 24), casey: secretDeck("Casey", 24) };
  let s = startedGame(PLAYERS, decks);
  for (const p of PLAYERS) s = apply(s, p.id, { type: "HandKept", payload: { player: p.id } });
  // Blair reveals one card from hand and plays a land so public zones have names too.
  const blairHand = s.players.blair!.zones.hand;
  s = apply(s, "blair", { type: "CardRevealed", payload: { iid: blairHand[0]! } });
  const blairLand = blairHand.find((iid) => /land/i.test(s.cards[iid]!.printing!.typeLine))!;
  s = apply(s, "blair", { type: "CardMoved", payload: { iid: blairLand, to: { kind: "battlefield", owner: "blair" } } });
  return s;
}

describe("agent prompt builder never leaks hidden information", () => {
  it("renders the agent's own hand but no other hand and no library card at all", () => {
    const state = game();
    const { view, printings } = viewFor(state, "agent");
    const text = renderState(view, Object.fromEntries(printings), "agent") + "\n" + renderDelta(view, Object.fromEntries(printings), "agent");

    // Own hand: every card named.
    for (const iid of state.players.agent!.zones.hand) expect(text).toContain(state.cards[iid]!.printing!.name);

    // Other hands: no card named, except the one Blair revealed to everyone.
    const revealed = state.cards[state.players.blair!.zones.hand[0]!]!.printing!.name;
    for (const pid of ["blair", "casey"]) {
      for (const iid of state.players[pid]!.zones.hand) {
        const name = state.cards[iid]!.printing!.name;
        if (name === revealed) continue;
        expect(text, `hand card of ${pid} leaked: ${name}`).not.toContain(name);
      }
    }
    // Libraries: nothing, not even the agent's own.
    for (const pid of ["agent", "blair", "casey"]) {
      for (const iid of state.players[pid]!.zones.library) {
        const name = state.cards[iid]!.printing!.name;
        expect(text, `library card of ${pid} leaked: ${name}`).not.toContain(name);
      }
    }
    // Public information is there: counts, Blair's land on the battlefield.
    expect(text).toContain("Blair (seat 2, opponent)");
    expect(text).toMatch(/hand 6, library \d+/);
    const land = state.players.blair!.zones.battlefield.lands[0]!;
    expect(text).toContain(state.cards[land]!.printing!.name);
    expect(text).toContain("== Your hand ==");
  });

  it("the system prompt carries both primers and the deck primer, and no game state", () => {
    const s = systemPrompt({ agentName: "Krenko bot", rulesPrimer: "RULES-X", effectsPrimer: "EFFECTS-Y", deck: { name: "Goblins", commanders: ["Krenko, Mob Boss"], primer: "PRIMER-Z" } });
    expect(s).toContain("RULES-X");
    expect(s).toContain("EFFECTS-Y");
    expect(s).toContain("PRIMER-Z");
    expect(s).toContain("Krenko, Mob Boss");
    expect(s).toContain("pass_turn");
    expect(s).not.toContain("Secret");
  });

  it("prices a response from the usage object", () => {
    expect(costOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(2);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 100_000 })).toBe(1);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBe(0.2);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBe(2.5);
    expect(costOf("something-unknown", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(2);
  });
});
