import { editDistance, normalizeName } from "@cgwf/shared";
import { asc, desc, sql } from "drizzle-orm";
import type { DbHandle } from "../db/index.js";
import { cards } from "../db/schema.js";

/**
 * In-memory name index: one "best" printing per distinct card (by oracle id),
 * plus aliases for each face of multi-face cards ("Fire" and "Ice" both find
 * "Fire // Ice"). ~35k entries, a few MB, rebuilt after every ingest.
 *
 * Search is tiered: exact > prefix > word prefix > substring > fuzzy
 * (bounded edit distance), so typos like "sol rign" still land.
 */
export interface IndexEntry {
  id: string;
  name: string;
  norm: string;
  isToken: boolean;
}

interface Scored {
  entry: IndexEntry;
  score: number;
}

export class NameIndex {
  private entries: IndexEntry[] = [];
  private aliases: Array<{ norm: string; entry: IndexEntry }> = [];
  builtAt: string | null = null;

  constructor(private readonly handle: DbHandle) {}

  size(): number {
    return this.entries.length;
  }

  /** Pick the best printing per card: paper, non-promo, in boosters, good scan, newest. */
  build(): void {
    const rows = this.handle.db
      .select({
        id: cards.id,
        name: cards.name,
        normalizedName: cards.normalizedName,
        oracleId: cards.oracleId,
        isToken: cards.isToken,
        layout: cards.layout,
      })
      .from(cards)
      .orderBy(
        asc(cards.isDigital),
        asc(cards.isPromo),
        desc(cards.inBooster),
        desc(sql`${cards.imageStatus} = 'highres_scan'`),
        desc(cards.releasedAt),
      )
      .all();

    const seen = new Set<string>();
    const entries: IndexEntry[] = [];
    const aliases: Array<{ norm: string; entry: IndexEntry }> = [];
    for (const r of rows) {
      // Tokens share oracle ids loosely; key them by name + token flag instead.
      const key = r.isToken ? `tok:${r.normalizedName}` : (r.oracleId ?? `name:${r.normalizedName}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry: IndexEntry = { id: r.id, name: r.name, norm: r.normalizedName, isToken: r.isToken };
      entries.push(entry);
      if (entry.norm.includes(" // ")) {
        for (const part of entry.norm.split(" // ")) {
          const p = part.trim();
          if (p && p !== entry.norm) aliases.push({ norm: p, entry });
        }
      }
    }
    this.entries = entries;
    this.aliases = aliases;
    this.builtAt = new Date().toISOString();
  }

  search(query: string, opts: { tokens?: boolean; limit?: number } = {}): IndexEntry[] {
    const q = normalizeName(query);
    const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
    if (!q) return [];
    const wantTokens = opts.tokens ?? false;

    const candidates: Array<{ norm: string; entry: IndexEntry }> = [];
    for (const e of this.entries) if (e.isToken === wantTokens) candidates.push({ norm: e.norm, entry: e });
    for (const a of this.aliases) if (a.entry.isToken === wantTokens) candidates.push(a);

    const scored = new Map<string, Scored>();
    const consider = (entry: IndexEntry, score: number) => {
      const prev = scored.get(entry.id);
      if (!prev || score < prev.score) scored.set(entry.id, { entry, score });
    };

    for (const c of candidates) {
      if (c.norm === q) consider(c.entry, 0);
      else if (c.norm.startsWith(`${q} `)) consider(c.entry, 0.5); // whole leading word(s)
      else if (c.norm.startsWith(q)) consider(c.entry, 1);
      else if (c.norm.includes(` ${q}`)) consider(c.entry, 2);
      else if (c.norm.includes(q)) consider(c.entry, 3);
    }

    // Only pay for fuzzy matching when the cheap tiers came up short.
    if (scored.size < limit && q.length >= 3) {
      const maxD = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
      for (const c of candidates) {
        if (scored.has(c.entry.id)) continue;
        const d = editDistance(q, c.norm, maxD);
        if (d <= maxD) {
          consider(c.entry, 10 + d);
          continue;
        }
        // Fuzzy prefix: "lightnin bol" should still find "lightning bolt".
        if (c.norm.length > q.length) {
          const dp = editDistance(q, c.norm.slice(0, q.length + 1), 1);
          if (dp <= 1) consider(c.entry, 6);
        }
      }
    }

    return [...scored.values()]
      .sort((a, b) => a.score - b.score || a.entry.norm.length - b.entry.norm.length || a.entry.name.localeCompare(b.entry.name))
      .slice(0, limit)
      .map((s) => s.entry);
  }
}
