import { randomUUID } from "node:crypto";
import type { EngineDeck } from "@cgwf/shared";
import type { EngineClient } from "../../engine/client.js";

/**
 * Does Forge know every card of a deck? Asked exactly the way a real engine table asks: the deck
 * as `deckForEngine` builds it goes to the engine in a `createGame`, and the `gameCreated` reply
 * lists, per seat, the cards Forge's DeckLoader could not resolve. Up to four decks share one
 * check game; every seat is a "human" seat, so Forge's AI never plays, and the game is ended at
 * once with `endGame`. Frames for these game ids reach no room (the server routes by room id).
 * No engine change, nothing persisted on the engine.
 */
export interface CoverageResult {
  /** null = the check could not run (engine absent, busy or erroring); the reason is in `error`. */
  missing: string[] | null;
  error?: string;
}

export interface CoverageChecker {
  check(decks: Array<{ key: string; deck: EngineDeck }>): Promise<Map<string, CoverageResult>>;
}

const SEATS_PER_GAME = 4;

export class EngineCoverageChecker implements CoverageChecker {
  constructor(
    private readonly client: Pick<EngineClient, "createGame" | "trySend" | "enabled" | "connected">,
    private readonly opts: { busyRetries?: number; busyWaitMs?: number } = {},
  ) {}

  async check(decks: Array<{ key: string; deck: EngineDeck }>): Promise<Map<string, CoverageResult>> {
    const out = new Map<string, CoverageResult>();
    if (!this.client.enabled || !this.client.connected) {
      for (const d of decks) out.set(d.key, { missing: null, error: "the rules engine is not connected" });
      return out;
    }
    for (let i = 0; i < decks.length; i += SEATS_PER_GAME) {
      const group = decks.slice(i, i + SEATS_PER_GAME);
      // createGame needs two seats: a lone deck sits opposite itself.
      const seats = (group.length === 1 ? [group[0]!, group[0]!] : group).map((d, seat) => ({ seat, kind: "human" as const, name: `Coverage check ${seat + 1}`, deck: d.deck }));
      const gameId = `deckcheck-${randomUUID()}`;
      let lastError = "";
      for (let attempt = 0; attempt <= (this.opts.busyRetries ?? 5); attempt++) {
        try {
          const created = await this.client.createGame(gameId, 1, seats);
          this.client.trySend({ type: "endGame", gameId });
          group.forEach((d, seat) => {
            const p = created.players.find((x) => x.seat === seat);
            out.set(d.key, p ? { missing: [...new Set(p.missing)] } : { missing: null, error: "no answer for this seat" });
          });
          lastError = "";
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.client.trySend({ type: "endGame", gameId });
          if (!/busy/i.test(lastError)) break;
          await new Promise((r) => setTimeout(r, this.opts.busyWaitMs ?? 10_000));
        }
      }
      if (lastError) for (const d of group) out.set(d.key, { missing: null, error: lastError });
    }
    return out;
  }
}
