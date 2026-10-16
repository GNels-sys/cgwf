import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { SUBMISSION_NOTE_MAX, isArchetypeTag, isBracket, type DeckAnalysis, type SubmissionInfo } from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, deckCards, decks, librarySubmissions, users, type LibrarySubmissionRow } from "../db/schema.js";
import type { LibraryEntry, LibraryService } from "../library/service.js";
import type { DeckAnalyzer } from "../analysis/service.js";
import { SocialError, toProfile, type SocialService } from "./service.js";

/** How many submissions one player may make per day (any status). */
export const SUBMISSIONS_PER_DAY = 3;

function now(): string {
  return new Date().toISOString();
}

/**
 * The agent deck queue. Any signed-in player offers a deck; the list is frozen
 * at that moment; the owner approves (into library_decks, agent-eligible,
 * credited to the submitter) or rejects with a reason. No model is involved.
 */
export class SubmissionService {
  constructor(
    private readonly handle: DbHandle,
    private readonly library: LibraryService,
    private readonly analyzer: DeckAnalyzer,
    private readonly social: SocialService,
  ) {}

  private info(row: LibrarySubmissionRow, withAnalysis = false): SubmissionInfo | null {
    const u = this.handle.db.select().from(users).where(eq(users.id, row.userId)).get();
    if (!u) return null;
    const out: SubmissionInfo = {
      id: row.id,
      deckId: row.deckId,
      deckName: row.deckName,
      commanders: row.commanders,
      cardCount: row.cards.filter((c) => c.board !== "sideboard").reduce((n, c) => n + c.quantity, 0),
      note: row.note,
      status: row.status as SubmissionInfo["status"],
      reason: row.reason,
      libraryDeckId: row.libraryDeckId,
      submitter: toProfile(u),
      createdAt: row.createdAt,
      reviewedAt: row.reviewedAt,
    };
    if (withAnalysis) {
      try {
        const analysisCards = this.analyzer.loadCardsByIds(row.cards.filter((c) => c.board === "main" || c.board === "commander").map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board as LibraryEntry["board"] })));
        const a: DeckAnalysis = this.analyzer.analyzeSync(analysisCards);
        out.bracketSuggested = isBracket(a.suggested) ? a.suggested : null;
        out.tags = a.archetypes.map((t) => t.tag).filter(isArchetypeTag);
      } catch {
        out.bracketSuggested = null;
        out.tags = [];
      }
    }
    return out;
  }

  /** The latest submission of this deck by its owner (any status), for the deck page. */
  latestForDeck(userId: string, deckId: string): SubmissionInfo | null {
    const row = this.handle.db
      .select()
      .from(librarySubmissions)
      .where(and(eq(librarySubmissions.deckId, deckId), eq(librarySubmissions.userId, userId)))
      .orderBy(desc(librarySubmissions.createdAt))
      .get();
    return row ? this.info(row) : null;
  }

  mine(userId: string): SubmissionInfo[] {
    return this.handle.db
      .select()
      .from(librarySubmissions)
      .where(eq(librarySubmissions.userId, userId))
      .orderBy(desc(librarySubmissions.createdAt))
      .limit(50)
      .all()
      .map((r) => this.info(r))
      .filter((s): s is SubmissionInfo => s !== null);
  }

  submit(userId: string, deckId: string, rawNote: unknown): SubmissionInfo {
    const deck = this.handle.db.select().from(decks).where(and(eq(decks.id, deckId), eq(decks.userId, userId))).get();
    if (!deck) throw new SocialError("deck not found", 404);
    const pending = this.handle.db
      .select({ id: librarySubmissions.id })
      .from(librarySubmissions)
      .where(and(eq(librarySubmissions.deckId, deckId), eq(librarySubmissions.status, "pending")))
      .get();
    if (pending) throw new SocialError("this deck is already in the queue", 409);
    const approved = this.handle.db
      .select({ id: librarySubmissions.id })
      .from(librarySubmissions)
      .where(and(eq(librarySubmissions.deckId, deckId), eq(librarySubmissions.status, "approved")))
      .get();
    if (approved) throw new SocialError("this deck is already in the library", 409);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const today = this.handle.db.select({ createdAt: librarySubmissions.createdAt }).from(librarySubmissions).where(eq(librarySubmissions.userId, userId)).all().filter((r) => r.createdAt > since).length;
    if (today >= SUBMISSIONS_PER_DAY) throw new SocialError(`you can submit ${SUBMISSIONS_PER_DAY} decks a day; try again tomorrow`, 429);
    const rows = this.handle.db.select().from(deckCards).where(eq(deckCards.deckId, deck.id)).orderBy(deckCards.position).all();
    const frozen = rows.filter((r) => r.board === "main" || r.board === "commander" || r.board === "sideboard").map((r) => ({ cardId: r.cardId, quantity: r.quantity, board: r.board }));
    if (frozen.filter((c) => c.board !== "sideboard").length === 0) throw new SocialError("deck has no cards");
    const commanderIds = frozen.filter((c) => c.board === "commander").map((c) => c.cardId);
    const commanders = commanderIds.length ? this.handle.db.select({ name: cards.name }).from(cards).where(inArray(cards.id, commanderIds)).all().map((c) => c.name) : [];
    const note = typeof rawNote === "string" ? rawNote.replace(/\s+/g, " ").trim().slice(0, SUBMISSION_NOTE_MAX) : "";
    const id = randomUUID();
    this.handle.db
      .insert(librarySubmissions)
      .values({ id, deckId: deck.id, userId, deckName: deck.name, note, cards: frozen, commanders, status: "pending", reason: null, libraryDeckId: null, createdAt: now(), reviewedAt: null })
      .run();
    return this.info(this.handle.db.select().from(librarySubmissions).where(eq(librarySubmissions.id, id)).get()!)!;
  }

  /** Owner: the queue (pending first, then the most recent decisions). */
  list(): SubmissionInfo[] {
    const rows = this.handle.db.select().from(librarySubmissions).orderBy(desc(librarySubmissions.createdAt)).limit(100).all();
    const pendingFirst = [...rows.filter((r) => r.status === "pending"), ...rows.filter((r) => r.status !== "pending").slice(0, 30)];
    return pendingFirst.map((r) => this.info(r, r.status === "pending")).filter((s): s is SubmissionInfo => s !== null);
  }

  async approve(submissionId: string, ownerId: string): Promise<SubmissionInfo> {
    const row = this.handle.db.select().from(librarySubmissions).where(eq(librarySubmissions.id, submissionId)).get();
    if (!row) throw new SocialError("no such submission", 404);
    if (row.status !== "pending") throw new SocialError("already reviewed", 409);
    const entries: LibraryEntry[] = row.cards.map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board as LibraryEntry["board"] }));
    const existing = this.library.bySourceKey(`deck:${row.deckId}`);
    const submitter = this.handle.db.select().from(users).where(eq(users.id, row.userId)).get();
    const name = submitter ? `${row.deckName} (${submitter.displayName})` : row.deckName;
    // The source key ties the library row to the player's deck; a second approval of the same deck is refused above.
    const created = existing
      ? this.library.detail(existing.id)!
      : await this.library.create({ name, source: "user", sourceKey: `deck:${row.deckId}`, createdBy: row.userId, entries }, { combos: "cached" });
    this.library.patch(created.id, { agentEligible: true });
    const ts = now();
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(librarySubmissions).set({ status: "approved", libraryDeckId: created.id, reviewedAt: ts, reason: null }).where(eq(librarySubmissions.id, row.id)).run();
      this.social.notify(row.userId, "submission_reviewed", { submissionId: row.id, deckName: row.deckName, status: "approved", reason: null, libraryDeckId: created.id, by: ownerId });
    })();
    return this.info(this.handle.db.select().from(librarySubmissions).where(eq(librarySubmissions.id, row.id)).get()!)!;
  }

  reject(submissionId: string, ownerId: string, rawReason: unknown): SubmissionInfo {
    const row = this.handle.db.select().from(librarySubmissions).where(eq(librarySubmissions.id, submissionId)).get();
    if (!row) throw new SocialError("no such submission", 404);
    if (row.status !== "pending") throw new SocialError("already reviewed", 409);
    const reason = typeof rawReason === "string" ? rawReason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (!reason) throw new SocialError("give the player a short reason");
    const ts = now();
    this.handle.sqlite.transaction(() => {
      this.handle.db.update(librarySubmissions).set({ status: "rejected", reason, reviewedAt: ts }).where(eq(librarySubmissions.id, row.id)).run();
      this.social.notify(row.userId, "submission_reviewed", { submissionId: row.id, deckName: row.deckName, status: "rejected", reason, by: ownerId });
    })();
    return this.info(this.handle.db.select().from(librarySubmissions).where(eq(librarySubmissions.id, row.id)).get()!)!;
  }

  /** A player may withdraw a pending submission. */
  withdraw(userId: string, submissionId: string): void {
    const row = this.handle.db.select().from(librarySubmissions).where(and(eq(librarySubmissions.id, submissionId), eq(librarySubmissions.userId, userId))).get();
    if (!row) throw new SocialError("no such submission", 404);
    if (row.status !== "pending") throw new SocialError("already reviewed", 409);
    this.handle.db.delete(librarySubmissions).where(eq(librarySubmissions.id, row.id)).run();
  }
}
