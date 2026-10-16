import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { normalizeName, type CardResponse, type SearchResponse, type StatusResponse, type TokenSearchResponse, type TokenSummary } from "@cgwf/shared";
import type { CardRow } from "../db/schema.js";
import { config } from "../config.js";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";
import { rowToPrinting, rowToSummary } from "../scryfall/map.js";
import type { Ingestor } from "../scryfall/ingest.js";
import { META_BULK_UPDATED, META_LAST_INGEST } from "../scryfall/ingest.js";
import type { NameIndex } from "../search/index.js";

export interface CardRouteDeps {
  handle: DbHandle;
  index: NameIndex;
  ingestor: Ingestor;
}

export function registerCardRoutes(app: FastifyInstance, deps: CardRouteDeps): void {
  const { handle, index, ingestor } = deps;

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/status", async (): Promise<StatusResponse> => ({
    ok: true,
    cardCount: ingestor.cardCount(),
    lastIngestAt: handle.getMeta(META_LAST_INGEST),
    bulkUpdatedAt: handle.getMeta(META_BULK_UPDATED),
    ingestRunning: ingestor.state.running,
    ingestProgress: ingestor.state.progress,
    ingestError: ingestor.state.error,
    version: config.appVersion,
  }));

  app.get<{ Querystring: { q?: string; tokens?: string; limit?: string } }>(
    "/api/cards/search",
    async (req): Promise<SearchResponse> => {
      const q = (req.query.q ?? "").slice(0, 80);
      const tokens = req.query.tokens === "1" || req.query.tokens === "true";
      const limit = Number(req.query.limit ?? 30);
      const hits = index.search(q, { tokens, limit: Number.isFinite(limit) ? limit : 30 });
      if (hits.length === 0) return { query: q, results: [] };
      const rows = handle.db
        .select()
        .from(cards)
        .where(inArray(cards.id, hits.map((h) => h.id)))
        .all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      const results = hits.flatMap((h) => {
        const row = byId.get(h.id);
        return row ? [rowToSummary(row)] : [];
      });
      return { query: q, results };
    },
  );

  app.get<{ Params: { id: string } }>("/api/cards/:id", async (req, reply): Promise<CardResponse | void> => {
    const row = handle.db.select().from(cards).where(eq(cards.id, req.params.id)).get();
    if (!row) return reply.code(404).send({ error: "card not found" });
    return { card: rowToPrinting(row) };
  });

  /**
   * Token finder. Searches the token printings in `cards` (is_token) and collapses
   * the many printings of e.g. the 2/2 black Zombie into one entry per distinct
   * name + P/T + colours + rules text. "2/2 zombie" and "zombie 2/2" both work.
   * With no query it returns the usual suspects (Treasure, Clue, Soldier, ...).
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/tokens", async (req): Promise<TokenSearchResponse> => {
    const raw = (req.query.q ?? "").slice(0, 60);
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 40) || 40, 80));
    const { name, pt } = parseTokenQuery(raw);
    let rows: CardRow[];
    if (!name && !pt) {
      rows = handle.db.select().from(cards).where(and(eq(cards.isToken, true), inArray(cards.normalizedName, POPULAR_TOKENS))).all();
    } else {
      const where = name ? and(eq(cards.isToken, true), like(cards.normalizedName, `%${name.replace(/[%_]/g, "")}%`)) : eq(cards.isToken, true);
      rows = handle.db.select().from(cards).where(where).all();
    }
    if (pt) rows = rows.filter((r) => (pt.power === "*" || (r.power ?? "") === pt.power) && (pt.toughness === "*" || (r.toughness ?? "") === pt.toughness));
    return { query: raw, tokens: distinctTokens(rows, name).slice(0, limit) };
  });

  /** Every printing of a card, newest first (used by deck import and the printing picker). */
  app.get<{ Params: { oracleId: string } }>("/api/cards/oracle/:oracleId/printings", async (req) => {
    const rows = handle.db
      .select()
      .from(cards)
      .where(and(eq(cards.oracleId, req.params.oracleId), eq(cards.isDigital, false)))
      .orderBy(desc(cards.releasedAt), asc(cards.collectorNumber))
      .all();
    return { printings: rows.map(rowToSummary) };
  });

  /**
   * Manual ingest trigger. Allowed from the machine itself (the CLI calls it over
   * loopback) or with the ADMIN_TOKEN secret. Returns immediately; poll /api/status.
   */
  app.post<{ Body: { force?: boolean } | null }>("/api/admin/ingest", async (req, reply) => {
    const isLoopback = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    const token = req.headers["x-admin-token"];
    const authorised = isLoopback || (config.adminToken !== "" && token === config.adminToken);
    if (!authorised) return reply.code(403).send({ error: "forbidden" });
    if (ingestor.state.running) return reply.code(409).send({ error: "ingest already running", state: ingestor.state });
    void ingestor.run({ force: Boolean(req.body?.force) });
    return reply.code(202).send({ started: true });
  });
}

/** Tokens players reach for most, in the order the empty finder shows them. */
const POPULAR_TOKENS = [
  "treasure",
  "clue",
  "food",
  "blood",
  "map",
  "powerstone",
  "soldier",
  "zombie",
  "spirit",
  "goblin",
  "elf warrior",
  "beast",
  "saproling",
  "thopter",
  "servo",
  "wolf",
  "human",
  "insect",
  "angel",
  "dragon",
  "eldrazi spawn",
  "eldrazi scion",
  "copy",
  "plant",
  "cat",
  "bird",
  "elemental",
  "knight",
  "faerie",
  "rat",
  "squirrel",
  "construct",
  "golem",
  "myr",
  "pest",
  "shard",
  "incubator",
  "the monarch",
  "the ring",
];

/** "2/2 zombie" / "zombie 2/2" / "treasure" -> name part and optional P/T filter. */
export function parseTokenQuery(raw: string): { name: string; pt: { power: string; toughness: string } | null } {
  const m = raw.match(/(\d+|\*|x)\s*\/\s*(\d+|\*|x)/i);
  const pt = m ? { power: m[1]!.toUpperCase(), toughness: m[2]!.toUpperCase() } : null;
  const name = normalizeName(m ? raw.replace(m[0], " ") : raw).trim();
  return { name, pt };
}

/** Collapse printings into one row per distinct token, best image first. */
export function distinctTokens(rows: CardRow[], query: string): TokenSummary[] {
  const score = (r: CardRow) => (r.isDigital ? 4 : 0) + (r.imageStatus === "highres_scan" ? 0 : 2) + (r.imageFront ? 0 : 8);
  const sorted = rows.slice().sort((a, b) => score(a) - score(b) || b.releasedAt.localeCompare(a.releasedAt));
  const seen = new Map<string, TokenSummary>();
  for (const r of sorted) {
    const key = [r.normalizedName, r.power ?? "", r.toughness ?? "", r.colors.join(""), r.oracleText.replace(/\s+/g, " ").trim().toLowerCase()].join("|");
    if (seen.has(key)) continue;
    seen.set(key, {
      id: r.id,
      name: r.name,
      typeLine: r.typeLine,
      power: r.power,
      toughness: r.toughness,
      colors: r.colors as TokenSummary["colors"],
      oracleText: r.oracleText,
      faceCount: r.imageBack ? 2 : 1,
    });
  }
  const popularity = (t: TokenSummary) => {
    const i = POPULAR_TOKENS.indexOf(normalizeName(t.name));
    return i === -1 ? POPULAR_TOKENS.length : i;
  };
  const relevance = (t: TokenSummary) => {
    const n = normalizeName(t.name);
    if (!query) return 0;
    if (n === query) return 0;
    if (n.startsWith(query)) return 1;
    return 2;
  };
  return [...seen.values()].sort(
    (a, b) =>
      relevance(a) - relevance(b) ||
      popularity(a) - popularity(b) ||
      a.name.localeCompare(b.name) ||
      Number(a.power ?? 0) - Number(b.power ?? 0) ||
      (a.oracleText.length - b.oracleText.length),
  );
}
