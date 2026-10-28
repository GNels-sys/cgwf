import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { playerDetail, playerSummaries, sanitizeSettings, type PlayerDetailResponse, type PlayerInput, type PlayersResponse } from "@cgwf/shared";
import { requireUser } from "../auth.js";
import type { DbHandle } from "../db/index.js";
import { decks, userSettings, users } from "../db/schema.js";
import { describeDeck } from "../rooms/deck.js";
import type { SocialService } from "../social/service.js";
import { SocialError } from "../social/service.js";
import type { Presence } from "../social/presence.js";
import type { DeckBrackets } from "../stats/brackets.js";
import { countedRows } from "./deckStats.js";

interface Deps {
  handle: DbHandle;
  brackets: DeckBrackets;
  social: SocialService;
  presence: Presence;
}

/**
 * The Players page (owner request 2026-10-28): everyone signed up, their decks' brackets and how they do, so a
 * player can tell who plays at their level before inviting them.
 *
 *   GET  /api/players                        every listed player's card (me first)
 *   GET  /api/players/:id                    one player's card + detail
 *   POST /api/players/:id/friend-request     send a friend request (same rules as by friend code)
 *
 * Listed: every non-bot user with an account, plus device-only profiles that have a deck or a counted game, minus
 * anyone who switched on `hideFromPlayers` (they still see themselves, marked hidden). Decks appear only as
 * commanders + bracket; deck names and lists stay private, as on the Deck stats page.
 */
export function registerPlayerRoutes(app: FastifyInstance, deps: Deps): void {
  const { handle, brackets, social, presence } = deps;
  const auth = requireUser(handle);

  const load = (me: string, only?: string) => {
    const userRows = (only ? handle.db.select().from(users).where(eq(users.id, only)) : handle.db.select().from(users)).all().filter((u) => !u.isAgent);
    const ids = userRows.map((u) => u.id);
    const hidden = new Set<string>();
    if (ids.length) {
      for (const s of handle.db.select().from(userSettings).where(inArray(userSettings.userId, ids)).all()) {
        if (sanitizeSettings(s.settings).hideFromPlayers) hidden.add(s.userId);
      }
    }
    const deckRows = ids.length ? handle.db.select({ id: decks.id, userId: decks.userId, updatedAt: decks.updatedAt }).from(decks).where(inArray(decks.userId, ids)).all() : [];
    const decksBy = new Map<string, PlayerInput["decks"]>();
    for (const d of deckRows) {
      const commanders = describeDeck(handle, d.userId, d.id)?.commanders ?? [];
      decksBy.set(d.userId, [...(decksBy.get(d.userId) ?? []), { commanders, bracket: brackets.ownDeck(d.id, d.updatedAt) }]);
    }
    const rows = countedRows(handle);
    const played = new Set(rows.filter((r) => !r.isBot && r.userId).map((r) => r.userId as string));
    const friends = new Set(social.friendIds(me));
    const inputs: PlayerInput[] = userRows
      .filter((u) => u.id === me || (!hidden.has(u.id) && (u.email !== null || decksBy.has(u.id) || played.has(u.id))))
      .map((u) => ({
        userId: u.id,
        name: u.displayName,
        avatar: u.avatar as PlayerInput["avatar"],
        color: u.color as PlayerInput["color"],
        hasAccount: u.email !== null,
        online: presence.isOnline(u.id),
        isFriend: friends.has(u.id),
        decks: decksBy.get(u.id) ?? [],
      }));
    return { inputs, rows, hidden };
  };

  app.get("/api/players", { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<PlayersResponse> => {
    const me = req.user!.id;
    const { inputs, rows } = load(me);
    const players = playerSummaries(inputs, rows, me).sort(
      (a, b) => Number(b.isMe) - Number(a.isMe) || Number(b.online) - Number(a.online) || b.performance.games - a.performance.games || b.decks - a.decks || a.name.localeCompare(b.name),
    );
    return { players };
  });

  app.get<{ Params: { id: string } }>(
    "/api/players/:id",
    { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply): Promise<PlayerDetailResponse | void> => {
      const me = req.user!.id;
      const { inputs, rows, hidden } = load(me, req.params.id);
      const input = inputs[0];
      if (!input) return reply.code(404).send({ error: "no such player" });
      return { ...playerDetail(input, rows, me), friendRequest: input.userId === me ? null : social.pendingBetween(me, input.userId), hidden: hidden.has(input.userId) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/players/:id/friend-request",
    { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 hour" } } },
    async (req, reply) => {
      const me = req.user!.id;
      // the same visibility as the page: a hidden player cannot be found here
      if (!load(me, req.params.id).inputs.some((p) => p.userId === req.params.id)) return reply.code(404).send({ error: "no such player" });
      try {
        return reply.code(201).send(social.requestUser(me, req.params.id));
      } catch (err) {
        if (err instanceof SocialError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    },
  );
}
