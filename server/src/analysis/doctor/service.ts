import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { isBracket, normalizeName, type Bracket, type DoctorResponse } from "@cgwf/shared";
import type { DbHandle } from "../../db/index.js";
import { cards, deckCards, deckDoctorPrefs, decks, libraryDeckCards, libraryDecks, type CardRow } from "../../db/schema.js";
import type { EdhrecClient } from "../../library/edhrec/client.js";
import type { NameIndex } from "../../search/index.js";
import type { SinglesClient } from "../../singles/client.js";
import { fromRow, loadGameChangers } from "../index.js";
import type { SpellbookResults, SpellbookVariant } from "../combos.js";
import type { DeckAnalyzer } from "../service.js";
import { loadCommanderEdhrec } from "./edhrec.js";
import { planSwaps, type DoctorCandidate, type DoctorDeckCard } from "./plan.js";

/**
 * The Deck Doctor for one deck (own or library): gathers the deck, its analysis (Spellbook through the
 * usual cache), EDHREC's data for its commander (edhrec.ts) and the player's keep / dismiss choices,
 * resolves every candidate to a real card, applies the hard filters, and lets `planSwaps` decide.
 */

export type DoctorTarget = { kind: "own"; deckId: string; userId: string } | { kind: "library"; libraryId: string; userId: string };

export class DoctorError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const faceCount = (row: CardRow) => (row.imageBack ? 2 : 1);

export class DeckDoctor {
  constructor(
    private readonly d: {
      handle: DbHandle;
      index: NameIndex;
      analyzer: DeckAnalyzer;
      edhrec: Pick<EdhrecClient, "get">;
      singles: SinglesClient | null;
      log?: FastifyBaseLogger | null;
    },
  ) {}

  /** The deck's main + commander lines with their printing rows; null when the caller may not read it. */
  loadDeck(t: DoctorTarget): { deckRef: string; name: string; lines: Array<{ entryId: number; row: CardRow; quantity: number; board: "main" | "commander" }> } | null {
    const db = this.d.handle.db;
    if (t.kind === "own") {
      const deck = db.select().from(decks).where(and(eq(decks.id, t.deckId), eq(decks.userId, t.userId))).get();
      if (!deck) return null;
      const rows = db.select({ dc: deckCards, card: cards }).from(deckCards).innerJoin(cards, eq(cards.id, deckCards.cardId)).where(eq(deckCards.deckId, deck.id)).orderBy(deckCards.position).all();
      return {
        deckRef: deck.id,
        name: deck.name,
        lines: rows.filter((r) => r.dc.board === "main" || r.dc.board === "commander").map((r) => ({ entryId: r.dc.id, row: r.card, quantity: r.dc.quantity, board: r.dc.board as "main" | "commander" })),
      };
    }
    const lib = db.select().from(libraryDecks).where(eq(libraryDecks.id, t.libraryId)).get();
    if (!lib) return null;
    const rows = db.select({ lc: libraryDeckCards, card: cards }).from(libraryDeckCards).innerJoin(cards, eq(cards.id, libraryDeckCards.cardId)).where(eq(libraryDeckCards.libraryDeckId, lib.id)).orderBy(libraryDeckCards.position).all();
    return {
      deckRef: `library:${lib.id}`,
      name: lib.name,
      lines: rows.filter((r) => r.lc.board === "main" || r.lc.board === "commander").map((r) => ({ entryId: r.lc.id, row: r.card, quantity: r.lc.quantity, board: r.lc.board as "main" | "commander" })),
    };
  }

  prefs(userId: string, deckRef: string): { keep: Array<{ oracleId: string; name: string }>; dismissed: Array<{ oracleId: string; name: string }> } {
    const rows = this.d.handle.db.select().from(deckDoctorPrefs).where(and(eq(deckDoctorPrefs.userId, userId), eq(deckDoctorPrefs.deckRef, deckRef))).all();
    return {
      keep: rows.filter((r) => r.kind === "keep").map((r) => ({ oracleId: r.oracleId, name: r.name })),
      dismissed: rows.filter((r) => r.kind === "dismiss").map((r) => ({ oracleId: r.oracleId, name: r.name })),
    };
  }

  async run(t: DoctorTarget, opts: { target?: number | undefined; allowHigher?: boolean | undefined } = {}): Promise<DoctorResponse> {
    const deck = this.loadDeck(t);
    if (!deck) throw new DoctorError("deck not found", 404);
    const deckCardsList: DoctorDeckCard[] = deck.lines.map((l) => ({
      ...fromRow(l.row, l.quantity, l.board),
      entryId: l.entryId,
      cardId: l.row.id,
      oracleId: l.row.oracleId,
      faceCount: faceCount(l.row),
    }));
    if (deckCardsList.length === 0) throw new DoctorError("the deck is empty", 400);
    const analyzed = await this.d.analyzer.analyze(deckCardsList, { combos: "cached" });
    const suggested = analyzed.analysis.suggested;
    const target: Bracket = isBracket(opts.target) ? opts.target : suggested;
    const allowHigher = Boolean(opts.allowHigher);
    const combos = analyzed.analysis.combosStatus === "skipped" ? null : this.d.analyzer.cachedCombos(deckCardsList);

    const commanders = deckCardsList.filter((c) => c.board === "commander").map((c) => c.name);
    const identity = new Set(deckCardsList.filter((c) => c.board === "commander").flatMap((c) => c.colorIdentity));
    const inDeck = new Set(deckCardsList.flatMap((c) => [c.oracleId ?? "", normalizeName(c.name)]).filter(Boolean));
    const prefs = this.prefs(t.userId, deck.deckRef);
    const dismissed = new Set(prefs.dismissed.map((p) => p.oracleId));

    const edhrec = await loadCommanderEdhrec(this.d.edhrec, commanders, target).catch((err: unknown) => ({
      status: "unavailable" as const,
      slug: null,
      message: err instanceof Error ? err.message : String(err),
    }));

    // Candidate names: EDHREC's list, then one-card-away combos when the target bracket may hold them
    // (the planner still replays each through the bracket rules).
    const names = new Map<string, { sources: Set<"edhrec" | "combo">; completes: SpellbookVariant[] }>();
    const want = (name: string) => names.get(name) ?? names.set(name, { sources: new Set(), completes: [] }).get(name)!;
    if (edhrec.status === "ok") for (const s of edhrec.data.cards.values()) want(s.name).sources.add("edhrec");
    if (combos && (target >= 3 || allowHigher)) {
      const deckNames = new Set(deckCardsList.map((c) => c.name));
      for (const v of combos.almostIncluded ?? []) {
        if (v.status && v.status !== "OK") continue;
        const missing = v.uses.map((u) => u.card.name).filter((n) => !deckNames.has(n));
        if (missing.length !== 1) continue;
        const entry = want(missing[0]!);
        entry.sources.add("combo");
        entry.completes.push(v);
      }
    }

    const candidates = this.resolveCandidates(names, { identity, inDeck, dismissed });
    const label = commanders.map((c) => (c.split(" // ")[0] ?? c).split(",")[0]!.trim()).join(" + ") || "this deck";
    const plan = planSwaps({
      deck: deckCardsList,
      candidates,
      edhrec: edhrec.status === "ok" ? edhrec.data.cards : null,
      commanderLabel: label,
      target,
      allowHigher,
      gameChangers: loadGameChangers(),
      combos: combos as SpellbookResults | null,
      keep: new Set(prefs.keep.map((p) => p.oracleId)),
      dismissed,
    });

    // "In stock locally" for the suggested adds: one cached request to the Singles site, when configured.
    const stock = new Map<string, { stores: number; cheapest: number | null }>();
    if (this.d.singles && plan.swaps.length) {
      try {
        const r = await this.d.singles.availability(plan.swaps.map((s) => s.add.oracleId).filter((x): x is string => Boolean(x)));
        if (r.status === "ok") {
          for (const [oid, card] of Object.entries(r.data.cards)) {
            const prices = card.listings.map((l) => l.price).filter((p): p is number => typeof p === "number");
            stock.set(oid, { stores: new Set(card.listings.map((l) => l.storeId)).size, cheapest: prices.length ? Math.min(...prices) : null });
          }
        }
      } catch {
        // Local stock is a nicety; the swaps stand without it.
      }
    }

    return {
      deckRef: deck.deckRef,
      commanders,
      targetBracket: target,
      suggestedBracket: suggested,
      allowHigher,
      roles: plan.roles,
      swaps: plan.swaps.map((s) => ({ ...s, add: { ...s.add, localStores: stock.get(s.add.oracleId ?? "")?.stores ?? null, cheapestLocal: stock.get(s.add.oracleId ?? "")?.cheapest ?? null } })),
      edhrec:
        edhrec.status === "ok"
          ? { status: "ok", slug: edhrec.data.slug, url: edhrec.data.url, page: edhrec.data.page, message: null }
          : { status: edhrec.status, slug: edhrec.slug, url: edhrec.slug ? `https://edhrec.com/commanders/${edhrec.slug}` : null, page: null, message: edhrec.message },
      combosStatus: analyzed.analysis.combosStatus,
      keep: prefs.keep,
      dismissed: prefs.dismissed,
      canApply: t.kind === "own",
    };
  }

  /** Names -> real cards: default printing, paper, Commander-legal, inside the colour identity, not in the deck. */
  private resolveCandidates(
    names: Map<string, { sources: Set<"edhrec" | "combo">; completes: SpellbookVariant[] }>,
    f: { identity: Set<string>; inDeck: Set<string>; dismissed: Set<string> },
  ): DoctorCandidate[] {
    const ids = new Map<string, string>();
    for (const name of names.keys()) {
      const hit = this.d.index.exact(normalizeName(name));
      if (hit && !hit.isToken) ids.set(name, hit.id);
    }
    const idList = [...new Set(ids.values())];
    const rows = new Map<string, CardRow>();
    for (let i = 0; i < idList.length; i += 400) {
      for (const r of this.d.handle.db.select().from(cards).where(inArray(cards.id, idList.slice(i, i + 400))).all()) rows.set(r.id, r);
    }
    const out: DoctorCandidate[] = [];
    const seen = new Set<string>();
    for (const [name, meta] of names) {
      const row = rows.get(ids.get(name) ?? "");
      if (!row || !row.oracleId || seen.has(row.oracleId)) continue;
      if (row.isDigital || row.isToken) continue;
      if (/\bBasic\b/.test(row.typeLine)) continue;
      if ((row.legalities as Record<string, string>).commander !== "legal") continue;
      if (!(row.colorIdentity as string[]).every((c) => f.identity.has(c))) continue;
      if (f.inDeck.has(row.oracleId) || f.inDeck.has(normalizeName(row.name)) || f.dismissed.has(row.oracleId)) continue;
      seen.add(row.oracleId);
      out.push({
        ...fromRow(row, 1, "main"),
        cardId: row.id,
        oracleId: row.oracleId,
        faceCount: faceCount(row),
        sources: [...meta.sources],
        completes: meta.completes,
      });
    }
    return out;
  }

  /** Pin a card as "keep" or dismiss a suggestion, for this player and deck. */
  setPref(userId: string, deckRef: string, oracleId: string, name: string, kind: "keep" | "dismiss"): void {
    this.d.handle.db
      .insert(deckDoctorPrefs)
      .values({ userId, deckRef, oracleId, name: name.slice(0, 200), kind, createdAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  clearPref(userId: string, deckRef: string, oracleId: string, kind: "keep" | "dismiss"): void {
    this.d.handle.db
      .delete(deckDoctorPrefs)
      .where(and(eq(deckDoctorPrefs.userId, userId), eq(deckDoctorPrefs.deckRef, deckRef), eq(deckDoctorPrefs.oracleId, oracleId), eq(deckDoctorPrefs.kind, kind)))
      .run();
  }

  /**
   * Apply a swap to the player's own deck: the cut line gives up one copy (or is replaced) and the add's
   * default printing goes in, with the same filters the suggestions use. Bumps the deck version.
   */
  applySwap(userId: string, deckId: string, cutEntryId: number, addOracleId: string): void {
    const db = this.d.handle.db;
    const deck = db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
    if (!deck) throw new DoctorError("deck not found", 404);
    const line = db.select().from(deckCards).where(and(eq(deckCards.id, cutEntryId), eq(deckCards.deckId, deckId))).get();
    if (!line || (line.board !== "main" && line.board !== "commander")) throw new DoctorError("that card is not in the deck", 404);
    if (line.board === "commander") throw new DoctorError("the commander cannot be cut", 400);
    const def = this.d.index.defaultFor(addOracleId);
    const add = def ? db.select().from(cards).where(eq(cards.id, def.id)).get() : undefined;
    if (!add || add.isToken || add.isDigital) throw new DoctorError("unknown card to add", 400);
    if ((add.legalities as Record<string, string>).commander !== "legal") throw new DoctorError(`${add.name} is not legal in Commander`, 400);
    const all = db.select({ dc: deckCards, card: cards }).from(deckCards).innerJoin(cards, eq(cards.id, deckCards.cardId)).where(eq(deckCards.deckId, deckId)).all();
    const identity = new Set(all.filter((r) => r.dc.board === "commander").flatMap((r) => r.card.colorIdentity as string[]));
    if (identity.size && !(add.colorIdentity as string[]).every((c) => identity.has(c))) throw new DoctorError(`${add.name} is outside the commander's colour identity`, 400);
    if (all.some((r) => r.card.oracleId === add.oracleId && (r.dc.board === "main" || r.dc.board === "commander"))) throw new DoctorError(`${add.name} is already in the deck`, 409);
    this.d.handle.sqlite.transaction(() => {
      if (line.quantity > 1) {
        db.update(deckCards).set({ quantity: line.quantity - 1 }).where(eq(deckCards.id, line.id)).run();
        db.insert(deckCards).values({ deckId, cardId: add.id, quantity: 1, board: "main", category: null, position: line.position }).run();
      } else {
        db.update(deckCards).set({ cardId: add.id, category: null }).where(eq(deckCards.id, line.id)).run();
      }
      db.update(decks).set({ updatedAt: new Date().toISOString() }).where(eq(decks.id, deckId)).run();
    })();
  }
}
