import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  COMMANDER_DECK_SIZE,
  type Board,
  type CreateDeckRequest,
  type DeckCardEntry,
  type DeckDetail,
  type DeckSummary,
  type DeckWarning,
  type ImportUrlResponse,
  type ResolveRequest,
  type ResolveResponse,
} from "@cgwf/shared";
import { rateLimitKey, requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks, type CardRow, type DeckRow } from "../db/schema.js";
import { classifyImportUrl, fetchArchidektDeck } from "../decks/archidekt.js";
import { existingCardIds, resolveDecklist } from "../decks/resolve.js";
import { rowToSummary } from "../scryfall/map.js";
import type { NameIndex } from "../search/index.js";

const BOARDS: ReadonlySet<string> = new Set<Board>(["main", "commander", "sideboard", "maybeboard", "companion"]);
const MAX_TEXT = 100_000;
const MAX_ENTRIES = 400;

interface Deps {
  handle: DbHandle;
  index: NameIndex;
}

/** Commander-format sanity checks. Warnings only; nothing is ever blocked. */
export function deckWarnings(entries: Array<{ row: CardRow; quantity: number; board: Board }>): DeckWarning[] {
  const warnings: DeckWarning[] = [];
  const commanders = entries.filter((e) => e.board === "commander");
  const main = entries.filter((e) => e.board === "main");

  if (commanders.length === 0) warnings.push({ code: "no_commander", message: "No commander marked." });
  if (commanders.length > 2) warnings.push({ code: "too_many_commanders", message: `${commanders.length} commanders marked; Commander allows one, or two with a partner ability.` });
  if (commanders.length === 2) {
    const partnerish = (r: CardRow) => /\b(Partner|Friends forever|Choose a Background|Doctor's companion|Background)\b/i.test(r.oracleText + " " + r.typeLine + " " + r.keywords.join(" "));
    if (!commanders.every((c) => partnerish(c.row))) {
      warnings.push({ code: "format", message: "Two commanders, but not both have a partner-style ability." });
    }
  }

  const total = [...main, ...commanders].reduce((n, e) => n + e.quantity, 0);
  if (total !== COMMANDER_DECK_SIZE) {
    warnings.push({ code: "size", message: `${total} cards including commander(s); Commander decks have exactly ${COMMANDER_DECK_SIZE}.` });
  }

  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const e of main) {
    const r = e.row;
    const anyNumber = /\bBasic\b/.test(r.typeLine) || /a deck can have any number/i.test(r.oracleText);
    if (anyNumber) continue;
    const key = r.oracleId ?? r.normalizedName;
    const n = (seen.get(key) ?? 0) + e.quantity;
    seen.set(key, n);
    if (n > 1 && !dupes.includes(r.name)) dupes.push(r.name);
  }
  if (dupes.length) {
    warnings.push({ code: "singleton", message: `More than one copy of: ${dupes.slice(0, 6).join(", ")}${dupes.length > 6 ? "..." : ""}.` });
  }

  if (commanders.length > 0) {
    const identity = new Set(commanders.flatMap((c) => c.row.colorIdentity));
    const off = main.filter((e) => e.row.colorIdentity.some((c) => !identity.has(c))).map((e) => e.row.name);
    if (off.length) {
      warnings.push({ code: "color_identity", message: `Outside the commander's colour identity: ${off.slice(0, 6).join(", ")}${off.length > 6 ? "..." : ""}.` });
    }
  }
  return warnings;
}

export function registerDeckRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, index } = deps;
  const auth = requireUser(handle);
  const keyGenerator = rateLimitKey(handle);

  const loadEntries = (deckId: string) => {
    const rows = handle.db
      .select({ dc: deckCards, card: cards })
      .from(deckCards)
      .innerJoin(cards, eq(cards.id, deckCards.cardId))
      .where(eq(deckCards.deckId, deckId))
      .orderBy(deckCards.position)
      .all();
    return rows.map((r) => ({ row: r.card, quantity: r.dc.quantity, board: r.dc.board as Board, category: r.dc.category }));
  };

  const toSummary = (deck: DeckRow, entries: ReturnType<typeof loadEntries>): DeckSummary => ({
    id: deck.id,
    name: deck.name,
    format: deck.format,
    cardCount: entries.filter((e) => e.board === "main" || e.board === "commander").reduce((n, e) => n + e.quantity, 0),
    commanders: entries.filter((e) => e.board === "commander").map((e) => rowToSummary(e.row)),
    updatedAt: deck.updatedAt,
  });

  const toDetail = (deck: DeckRow): DeckDetail => {
    const entries = loadEntries(deck.id);
    const cardsOut: DeckCardEntry[] = entries.map((e) => ({
      cardId: e.row.id,
      quantity: e.quantity,
      board: e.board,
      category: e.category,
      card: rowToSummary(e.row),
    }));
    return { ...toSummary(deck, entries), cards: cardsOut, warnings: deckWarnings(entries), sourceUrl: deck.sourceUrl, createdAt: deck.createdAt };
  };

  const ownDeck = (userId: string, id: string): DeckRow | undefined =>
    handle.db.select().from(decks).where(and(eq(decks.id, id), eq(decks.userId, userId))).get();

  /** Validate and normalise the card list of a create/replace request. */
  const cleanCards = (input: unknown): { ok: true; cards: Array<{ cardId: string; quantity: number; board: Board; category: string | null }> } | { ok: false; error: string } => {
    if (!Array.isArray(input) || input.length === 0) return { ok: false, error: "a deck needs at least one card" };
    if (input.length > MAX_ENTRIES) return { ok: false, error: `too many entries (max ${MAX_ENTRIES})` };
    const out: Array<{ cardId: string; quantity: number; board: Board; category: string | null }> = [];
    for (const raw of input as Array<Record<string, unknown>>) {
      const cardId = typeof raw.cardId === "string" ? raw.cardId : "";
      const quantity = Math.floor(Number(raw.quantity ?? 1));
      const board = typeof raw.board === "string" && BOARDS.has(raw.board) ? (raw.board as Board) : "main";
      const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim().slice(0, 40) : null;
      if (!cardId || !Number.isFinite(quantity) || quantity < 1 || quantity > 99) return { ok: false, error: "bad card entry" };
      out.push({ cardId, quantity, board, category });
    }
    const known = existingCardIds(handle, [...new Set(out.map((c) => c.cardId))]);
    const missing = out.find((c) => !known.has(c.cardId));
    if (missing) return { ok: false, error: `unknown card id ${missing.cardId}` };
    return { ok: true, cards: out };
  };

  app.post<{ Body: Partial<ResolveRequest> }>(
    "/api/decks/parse",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator } } },
    async (req, reply): Promise<ResolveResponse | void> => {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (!text.trim()) return reply.code(400).send({ error: "paste a decklist first" });
      if (text.length > MAX_TEXT) return reply.code(413).send({ error: "decklist too long" });
      return resolveDecklist({ handle, index }, text);
    },
  );

  app.get<{ Querystring: { url?: string } }>(
    "/api/decks/import-url",
    { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator } } },
    async (req, reply): Promise<ImportUrlResponse | void> => {
      const kind = classifyImportUrl(req.query.url ?? "");
      if (kind.kind === "moxfield") {
        return reply.code(400).send({ error: "Moxfield blocks automated access. In Moxfield use Export > Text, then paste it here." });
      }
      if (kind.kind !== "archidekt") return reply.code(400).send({ error: "Paste a public Archidekt deck link (archidekt.com/decks/...)." });
      try {
        return await fetchArchidektDeck(kind.id);
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : "import failed" });
      }
    },
  );

  app.get("/api/decks", { preHandler: auth }, async (req): Promise<{ decks: DeckSummary[] }> => {
    const rows = handle.db.select().from(decks).where(eq(decks.userId, req.user!.id)).orderBy(decks.updatedAt).all().reverse();
    return { decks: rows.map((d) => toSummary(d, loadEntries(d.id))) };
  });

  app.post<{ Body: Partial<CreateDeckRequest> }>(
    "/api/decks",
    { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator } } },
    async (req, reply): Promise<{ deck: DeckDetail } | void> => {
      const name = typeof req.body?.name === "string" ? req.body.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
      if (!name) return reply.code(400).send({ error: "give the deck a name" });
      const cleaned = cleanCards(req.body?.cards);
      if (!cleaned.ok) return reply.code(400).send({ error: cleaned.error });
      const now = new Date().toISOString();
      const id = randomUUID();
      const sourceText = typeof req.body?.sourceText === "string" ? req.body.sourceText.slice(0, MAX_TEXT) : null;
      const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl.slice(0, 500) : null;
      handle.sqlite.transaction(() => {
        handle.db.insert(decks).values({ id, userId: req.user!.id, name, format: "commander", sourceText, sourceUrl, createdAt: now, updatedAt: now }).run();
        cleaned.cards.forEach((c, position) => {
          handle.db.insert(deckCards).values({ deckId: id, cardId: c.cardId, quantity: c.quantity, board: c.board, category: c.category, position }).run();
        });
      })();
      return reply.code(201).send({ deck: toDetail(ownDeck(req.user!.id, id)!) });
    },
  );

  app.get<{ Params: { id: string } }>("/api/decks/:id", { preHandler: auth }, async (req, reply): Promise<{ deck: DeckDetail } | void> => {
    const deck = ownDeck(req.user!.id, req.params.id);
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    return { deck: toDetail(deck) };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>("/api/decks/:id", { preHandler: auth }, async (req, reply): Promise<{ deck: DeckDetail } | void> => {
    const deck = ownDeck(req.user!.id, req.params.id);
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const name = typeof req.body?.name === "string" ? req.body.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    if (!name) return reply.code(400).send({ error: "give the deck a name" });
    handle.db.update(decks).set({ name, updatedAt: new Date().toISOString() }).where(eq(decks.id, deck.id)).run();
    return { deck: toDetail(ownDeck(req.user!.id, deck.id)!) };
  });

  /** Replace the whole card list (used after fixing lines or editing). */
  app.put<{ Params: { id: string }; Body: { cards?: unknown } }>("/api/decks/:id/cards", { preHandler: auth }, async (req, reply): Promise<{ deck: DeckDetail } | void> => {
    const deck = ownDeck(req.user!.id, req.params.id);
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    const cleaned = cleanCards(req.body?.cards);
    if (!cleaned.ok) return reply.code(400).send({ error: cleaned.error });
    handle.sqlite.transaction(() => {
      handle.db.delete(deckCards).where(eq(deckCards.deckId, deck.id)).run();
      cleaned.cards.forEach((c, position) => {
        handle.db.insert(deckCards).values({ deckId: deck.id, cardId: c.cardId, quantity: c.quantity, board: c.board, category: c.category, position }).run();
      });
      handle.db.update(decks).set({ updatedAt: new Date().toISOString() }).where(eq(decks.id, deck.id)).run();
    })();
    return { deck: toDetail(ownDeck(req.user!.id, deck.id)!) };
  });

  app.delete<{ Params: { id: string } }>("/api/decks/:id", { preHandler: auth }, async (req, reply) => {
    const deck = ownDeck(req.user!.id, req.params.id);
    if (!deck) return reply.code(404).send({ error: "deck not found" });
    handle.db.delete(deckCards).where(eq(deckCards.deckId, deck.id)).run();
    handle.db.delete(decks).where(eq(decks.id, deck.id)).run();
    return { ok: true };
  });

  // Keep the import tidy: unused import guard for inArray when tree-shaken builds complain.
  void inArray;
}
