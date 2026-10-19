import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import type { CreateRoomResponse, DeckDetail, FriendsResponse, LibraryListResponse, NotificationsResponse, RegisterResponse, RoomInviteInfo, SubmissionInfo } from "@cgwf/shared";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cgwf-social-"));
process.env.DATA_DIR = tmp;
process.env.SKIP_AUTO_INGEST = "1";

const { buildApp } = await import("../app.js");
const { users } = await import("../db/schema.js");
const { presence } = await import("../social/presence.js");
const { SUBMISSIONS_PER_DAY } = await import("../social/submissions.js");
const fixture = fileURLToPath(new URL("../scryfall/fixtures/cards.sample.json", import.meta.url));

/** Poll until `pred` holds (sockets attach and detach a tick after the handshake). */
async function until(pred: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Person {
  token: string;
  id: string;
  name: string;
}

describe("Phase 8: friends, invites, notifications and the agent deck queue", () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let port = 0;
  let alex: Person;
  let blair: Person;
  let casey: Person;
  let owner: Person;

  const register = async (name: string, ip: string): Promise<Person> => {
    const r = await ctx.app.inject({ method: "POST", url: "/api/me/register", payload: { displayName: name, avatar: "owl", color: "jade" }, remoteAddress: ip });
    expect(r.statusCode).toBe(200);
    const body = r.json() as RegisterResponse;
    return { token: body.token, id: body.user.id, name };
  };
  const as = (p: Person) => ({ authorization: `Bearer ${p.token}` });
  const friendsOf = async (p: Person) => (await ctx.app.inject({ method: "GET", url: "/api/friends", headers: as(p) })).json() as FriendsResponse;
  const bell = async (p: Person) => (await ctx.app.inject({ method: "GET", url: "/api/notifications", headers: as(p) })).json() as NotificationsResponse;

  const makeDeck = async (p: Person, name: string): Promise<DeckDetail> => {
    const parsed = await ctx.app.inject({
      method: "POST",
      url: "/api/decks/parse",
      headers: as(p),
      payload: { text: "Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n1 Arcane Signet\n1 Lightning Bolt\n3 Forest\n" },
    });
    const lines = (parsed.json() as { lines: Array<{ card: { id: string } | null; line: { quantity: number; board: string } }> }).lines;
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/decks",
      headers: as(p),
      payload: { name, cards: lines.filter((l) => l.card).map((l) => ({ cardId: l.card!.id, quantity: l.line.quantity, board: l.line.board })) },
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { deck: DeckDetail }).deck;
  };

  beforeAll(async () => {
    ctx = await buildApp({ logger: false, casualRooms: true, spellbookFetch: async () => new Response("down", { status: 503 }) });
    await ctx.ingestor.run({ file: fixture });
    alex = await register("Alex", "10.0.0.1");
    blair = await register("Blair", "10.0.0.2");
    casey = await register("Casey", "10.0.0.3");
    owner = await register("Owner", "10.0.0.4");
    ctx.handle.db.update(users).set({ isOwner: true }).where(eq(users.id, owner.id)).run();
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = ctx.app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ------------------------------------------------------------ friends

  it("gives every player a six-character friend code, assigned lazily and stable", async () => {
    const a1 = await friendsOf(alex);
    expect(a1.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const a2 = await friendsOf(alex);
    expect(a2.code).toBe(a1.code);
    const b = await friendsOf(blair);
    expect(b.code).not.toBe(a1.code);
    expect(a1.friends).toEqual([]);
    const viaMe = (await ctx.app.inject({ method: "GET", url: "/api/me/friend-code", headers: as(alex) })).json() as { code: string };
    expect(viaMe.code).toBe(a1.code);
  });

  it("refuses bad codes, your own code and unknown codes", async () => {
    const mine = (await friendsOf(alex)).code;
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: "x" } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: mine } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: "ZZZZZZ" } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", payload: { code: mine } })).statusCode).toBe(401);
  });

  it("sends a request, notifies the other player, and accepting makes both friends", async () => {
    const blairCode = (await friendsOf(blair)).code;
    const sent = await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: ` ${blairCode.toLowerCase()} ` } });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ outcome: "sent", user: { userId: blair.id, name: "Blair" } });
    // Sending twice is refused politely.
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: blairCode } })).statusCode).toBe(409);

    const a = await friendsOf(alex);
    expect(a.outgoing).toHaveLength(1);
    expect(a.outgoing[0]!.to.userId).toBe(blair.id);
    const b = await friendsOf(blair);
    expect(b.incoming).toHaveLength(1);
    const requestId = b.incoming[0]!.id;
    expect(b.incoming[0]!.from).toMatchObject({ userId: alex.id, name: "Alex" });
    // Nothing about Alex's email ever appears.
    expect(JSON.stringify(b)).not.toContain("email");

    const bellB = await bell(blair);
    expect(bellB.unread).toBe(1);
    expect(bellB.notifications[0]).toMatchObject({ kind: "friend_request", read: false, payload: { requestId, fromName: "Alex", live: true } });

    // Only the addressee may accept.
    expect((await ctx.app.inject({ method: "POST", url: `/api/friends/requests/${requestId}/accept`, headers: as(casey) })).statusCode).toBe(404);
    const acc = await ctx.app.inject({ method: "POST", url: `/api/friends/requests/${requestId}/accept`, headers: as(blair) });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ friend: { userId: alex.id } });
    expect((await ctx.app.inject({ method: "POST", url: `/api/friends/requests/${requestId}/accept`, headers: as(blair) })).statusCode).toBe(409);

    const a2 = await friendsOf(alex);
    expect(a2.friends.map((f) => f.userId)).toEqual([blair.id]);
    expect(a2.outgoing).toEqual([]);
    const b2 = await friendsOf(blair);
    expect(b2.friends.map((f) => f.userId)).toEqual([alex.id]);
    expect(b2.incoming).toEqual([]);
    // Alex hears back; Blair's request notification is now read.
    expect((await bell(alex)).notifications[0]).toMatchObject({ kind: "friend_accepted", payload: { userId: blair.id, name: "Blair" } });
    expect((await bell(blair)).unread).toBe(0);
    // Already friends: a new request is refused.
    expect((await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: blairCode } })).statusCode).toBe(409);
  });

  it("declines, cancels and crossed requests", async () => {
    const caseyCode = (await friendsOf(casey)).code;
    const alexCode = (await friendsOf(alex)).code;
    // Blair -> Casey, Casey declines.
    await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(blair), payload: { code: caseyCode } });
    const req = (await friendsOf(casey)).incoming[0]!;
    expect((await ctx.app.inject({ method: "POST", url: `/api/friends/requests/${req.id}/decline`, headers: as(casey) })).statusCode).toBe(200);
    expect((await friendsOf(blair)).friends.some((f) => f.userId === casey.id)).toBe(false);
    expect((await friendsOf(blair)).outgoing).toEqual([]);
    // Casey -> Alex, then Casey cancels.
    await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(casey), payload: { code: alexCode } });
    const out = (await friendsOf(casey)).outgoing[0]!;
    expect((await ctx.app.inject({ method: "POST", url: `/api/friends/requests/${out.id}/cancel`, headers: as(casey) })).statusCode).toBe(200);
    expect((await friendsOf(alex)).incoming).toEqual([]);
    // Crossed: Casey asks Alex, Alex asks Casey -> friends at once.
    await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(casey), payload: { code: alexCode } });
    const crossed = await ctx.app.inject({ method: "POST", url: "/api/friends/requests", headers: as(alex), payload: { code: caseyCode } });
    expect(crossed.statusCode).toBe(201);
    expect(crossed.json()).toMatchObject({ outcome: "accepted" });
    expect((await friendsOf(alex)).friends.map((f) => f.userId).sort()).toEqual([blair.id, casey.id].sort());
    expect((await friendsOf(casey)).incoming).toEqual([]);
  });

  it("shows presence and which table a friend is at, and removes friends both ways", async () => {
    // Blair has just made requests, so Blair is online for Alex; Casey goes quiet.
    presence.touch(casey.id, Date.now() - 10 * 60 * 1000);
    const a = await friendsOf(alex);
    expect(a.friends.find((f) => f.userId === blair.id)?.online).toBe(true);
    expect(a.friends.find((f) => f.userId === casey.id)?.online).toBe(false);
    expect(a.friends[0]!.userId).toBe(blair.id); // online first

    // Blair opens a table and connects: Alex sees the table code.
    const created = (await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: as(blair), payload: {} })).json() as CreateRoomResponse;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${created.room.code}/ws?token=${encodeURIComponent(blair.token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const tableOfBlair = async () => (await friendsOf(alex)).friends.find((f) => f.userId === blair.id)?.table ?? null;
    await until(async () => (await tableOfBlair()) !== null);
    expect(await tableOfBlair()).toEqual({ code: created.room.code, status: "lobby" });
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
    await until(async () => (await tableOfBlair()) === null);
    expect(await tableOfBlair()).toBeNull();

    // Remove Casey: gone from both lists.
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/friends/${casey.id}`, headers: as(alex) })).statusCode).toBe(200);
    expect((await friendsOf(alex)).friends.map((f) => f.userId)).toEqual([blair.id]);
    expect((await friendsOf(casey)).friends).toEqual([]);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/friends/${casey.id}`, headers: as(alex) })).statusCode).toBe(404);
  });

  // ------------------------------------------------------------ invites

  it("invites friends to a table; the invitee gets a notification and Join seats them", async () => {
    const created = (await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: as(alex), payload: {} })).json() as CreateRoomResponse;
    const code = created.room.code;
    // Casey is no longer a friend: silently skipped. Blair is invited.
    const inv = await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/invites`, headers: as(alex), payload: { userIds: [blair.id, casey.id, alex.id] } });
    expect(inv.statusCode).toBe(201);
    const invites = (inv.json() as { invites: RoomInviteInfo[] }).invites;
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ code, status: "pending", from: { userId: alex.id }, to: { userId: blair.id } });
    // Re-inviting is idempotent.
    const again = (await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/invites`, headers: as(alex), payload: { userIds: [blair.id] } })).json() as { invites: RoomInviteInfo[] };
    expect(again.invites).toHaveLength(1);
    expect(again.invites[0]!.id).toBe(invites[0]!.id);
    // Only members may invite.
    expect((await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/invites`, headers: as(casey), payload: { userIds: [blair.id] } })).statusCode).toBe(400);

    const bellB = await bell(blair);
    expect(bellB.unread).toBe(1);
    expect(bellB.notifications[0]).toMatchObject({ kind: "room_invite", payload: { inviteId: invites[0]!.id, code, fromName: "Alex", live: true } });
    const pending = (await ctx.app.inject({ method: "GET", url: "/api/invites", headers: as(blair) })).json() as { invites: RoomInviteInfo[] };
    expect(pending.invites.map((i) => i.id)).toEqual([invites[0]!.id]);

    // Casey cannot accept someone else's invite.
    expect((await ctx.app.inject({ method: "POST", url: `/api/invites/${invites[0]!.id}/accept`, headers: as(casey) })).statusCode).toBe(404);
    const acc = await ctx.app.inject({ method: "POST", url: `/api/invites/${invites[0]!.id}/accept`, headers: as(blair) });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toEqual({ code, seated: true });
    const room = (await ctx.app.inject({ method: "GET", url: `/api/rooms/${code}`, headers: as(blair) })).json() as CreateRoomResponse;
    const me = room.room.members.find((m) => m.userId === blair.id);
    expect(me).toMatchObject({ role: "player", seat: 1, deckId: null });
    expect((await bell(blair)).unread).toBe(0);
    const list = (await ctx.app.inject({ method: "GET", url: `/api/rooms/${code}/invites`, headers: as(alex) })).json() as { invites: RoomInviteInfo[] };
    expect(list.invites[0]!.status).toBe("accepted");
  });

  it("expires invites when the room ends, and declining works", async () => {
    await ctx.app.inject({ method: "POST", url: "/api/notifications/read", headers: as(alex), payload: {} });
    expect((await bell(alex)).unread).toBe(0);
    const created = (await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: as(blair), payload: {} })).json() as CreateRoomResponse;
    const code = created.room.code;
    const inv = (await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/invites`, headers: as(blair), payload: { userIds: [alex.id] } })).json() as { invites: RoomInviteInfo[] };
    const id = inv.invites[0]!.id;
    expect((await bell(alex)).unread).toBe(1);
    // The room ends (we mark it directly; a finished game does the same through the reducer).
    const { rooms } = await import("../db/schema.js");
    ctx.handle.db.update(rooms).set({ status: "ended" }).where(eq(rooms.code, code)).run();
    const b = await bell(alex);
    expect(b.unread).toBe(0);
    expect(b.notifications[0]).toMatchObject({ kind: "room_invite", read: true, payload: { live: false } });
    expect((await ctx.app.inject({ method: "GET", url: "/api/invites", headers: as(alex) })).json()).toEqual({ invites: [] });
    expect((await ctx.app.inject({ method: "POST", url: `/api/invites/${id}/accept`, headers: as(alex) })).statusCode).toBe(410);
    expect((await ctx.app.inject({ method: "POST", url: `/api/rooms/${code}/invites`, headers: as(blair), payload: { userIds: [alex.id] } })).statusCode).toBe(400);

    // Decline on a live room.
    const created2 = (await ctx.app.inject({ method: "POST", url: "/api/rooms", headers: as(blair), payload: {} })).json() as CreateRoomResponse;
    const inv2 = (await ctx.app.inject({ method: "POST", url: `/api/rooms/${created2.room.code}/invites`, headers: as(blair), payload: { userIds: [alex.id] } })).json() as { invites: RoomInviteInfo[] };
    expect((await ctx.app.inject({ method: "POST", url: `/api/invites/${inv2.invites[0]!.id}/decline`, headers: as(alex) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: `/api/invites/${inv2.invites[0]!.id}/accept`, headers: as(alex) })).statusCode).toBe(409);
    expect((await bell(alex)).unread).toBe(0);
    // Mark-all-read clears whatever is left.
    expect((await ctx.app.inject({ method: "POST", url: "/api/notifications/read", headers: as(blair), payload: {} })).statusCode).toBe(200);
    expect((await bell(blair)).unread).toBe(0);
  });

  // ------------------------------------------------------------ agent deck queue

  it("lets a player submit a deck once, freezes the list, and the owner approves it into the library", async () => {
    const deck = await makeDeck(casey, "Casey's Atraxa");
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/submission`, headers: as(casey) })).json()).toEqual({ submission: null });
    const sub = await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/submit`, headers: as(casey), payload: { note: "  Fun   budget list " } });
    expect(sub.statusCode).toBe(201);
    const s = (sub.json() as { submission: SubmissionInfo }).submission;
    expect(s).toMatchObject({ deckId: deck.id, deckName: "Casey's Atraxa", note: "Fun budget list", status: "pending", submitter: { userId: casey.id, name: "Casey" }, cardCount: 7, commanders: ["Atraxa, Praetors' Voice"] });
    // Once per deck while pending; not someone else's deck.
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/submit`, headers: as(casey), payload: {} })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/submit`, headers: as(alex), payload: {} })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/submission`, headers: as(casey) })).json()).toMatchObject({ submission: { id: s.id, status: "pending" } });

    // The queue is owner-only.
    expect((await ctx.app.inject({ method: "GET", url: "/api/library/submissions", headers: as(casey) })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: "POST", url: `/api/library/submissions/${s.id}/approve`, headers: as(casey) })).statusCode).toBe(403);
    const queue = (await ctx.app.inject({ method: "GET", url: "/api/library/submissions", headers: as(owner) })).json() as { submissions: SubmissionInfo[] };
    expect(queue.submissions.map((q) => q.id)).toEqual([s.id]);
    expect(queue.submissions[0]!.bracketSuggested).toBeTypeOf("number");
    expect(Array.isArray(queue.submissions[0]!.tags)).toBe(true);

    // Casey edits the deck after submitting: the frozen copy is what gets approved.
    const renamed = await ctx.app.inject({ method: "PUT", url: `/api/decks/${deck.id}/cards`, headers: as(casey), payload: { cards: deck.cards.slice(0, 2).map((c) => ({ cardId: c.cardId, quantity: c.quantity, board: c.board })) } });
    expect(renamed.statusCode).toBe(200);

    const approved = await ctx.app.inject({ method: "POST", url: `/api/library/submissions/${s.id}/approve`, headers: as(owner) });
    expect(approved.statusCode).toBe(200);
    const done = (approved.json() as { submission: SubmissionInfo }).submission;
    expect(done.status).toBe("approved");
    expect(done.libraryDeckId).toBeTruthy();
    const lib = (await ctx.app.inject({ method: "GET", url: "/api/library?source=user", headers: as(owner) })).json() as LibraryListResponse;
    const entry = lib.decks.find((d) => d.id === done.libraryDeckId)!;
    expect(entry).toMatchObject({ source: "user", agentEligible: true, cardCount: 7, createdBy: casey.id, createdByName: "Casey", commanders: ["Atraxa, Praetors' Voice"] });
    expect(entry.name).toContain("Casey");
    expect(entry.tags).toEqual(expect.any(Array));
    expect(entry.suggested).toBeTypeOf("number");
    // Approving twice is refused; Casey sees the status and gets a notification.
    expect((await ctx.app.inject({ method: "POST", url: `/api/library/submissions/${s.id}/approve`, headers: as(owner) })).statusCode).toBe(409);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${deck.id}/submission`, headers: as(casey) })).json()).toMatchObject({ submission: { status: "approved", libraryDeckId: done.libraryDeckId } });
    const b = await bell(casey);
    expect(b.notifications[0]).toMatchObject({ kind: "submission_reviewed", read: false, payload: { status: "approved", deckName: "Casey's Atraxa" } });
    // An approved deck cannot be re-queued.
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${deck.id}/submit`, headers: as(casey), payload: {} })).statusCode).toBe(409);
  });

  it("rejects with a reason, lets the player withdraw, and rate-limits submissions per day", async () => {
    const d1 = await makeDeck(alex, "Alex one");
    const s1 = (await ctx.app.inject({ method: "POST", url: `/api/decks/${d1.id}/submit`, headers: as(alex), payload: {} })).json() as { submission: SubmissionInfo };
    expect((await ctx.app.inject({ method: "POST", url: `/api/library/submissions/${s1.submission.id}/reject`, headers: as(owner), payload: { reason: "" } })).statusCode).toBe(400);
    const rej = await ctx.app.inject({ method: "POST", url: `/api/library/submissions/${s1.submission.id}/reject`, headers: as(owner), payload: { reason: "Too close to a precon we already have" } });
    expect(rej.statusCode).toBe(200);
    expect((rej.json() as { submission: SubmissionInfo }).submission).toMatchObject({ status: "rejected", reason: "Too close to a precon we already have" });
    expect((await bell(alex)).notifications[0]).toMatchObject({ kind: "submission_reviewed", payload: { status: "rejected", reason: "Too close to a precon we already have" } });
    // A rejected deck may be submitted again (counts toward the daily cap).
    const s1b = await ctx.app.inject({ method: "POST", url: `/api/decks/${d1.id}/submit`, headers: as(alex), payload: {} });
    expect(s1b.statusCode).toBe(201);
    const id1b = (s1b.json() as { submission: SubmissionInfo }).submission.id;
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/submissions/${id1b}`, headers: as(blair) })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "DELETE", url: `/api/submissions/${id1b}`, headers: as(alex) })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/api/decks/${d1.id}/submission`, headers: as(alex) })).json()).toMatchObject({ submission: { status: "rejected" } });

    // Daily cap.
    const mine = (await ctx.app.inject({ method: "GET", url: "/api/submissions/mine", headers: as(alex) })).json() as { submissions: SubmissionInfo[] };
    const used = mine.submissions.length;
    for (let i = used; i < SUBMISSIONS_PER_DAY; i++) {
      const d = await makeDeck(alex, `Alex filler ${i}`);
      expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${d.id}/submit`, headers: as(alex), payload: {} })).statusCode).toBe(201);
    }
    const extra = await makeDeck(alex, "Alex too many");
    expect((await ctx.app.inject({ method: "POST", url: `/api/decks/${extra.id}/submit`, headers: as(alex), payload: {} })).statusCode).toBe(429);
  });
});
