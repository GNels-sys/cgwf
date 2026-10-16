import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  normalizeName,
  normalizeSetCode,
  parseDecklist,
  type ParsedLine,
  type ResolveResponse,
  type ResolvedLine,
} from "@cgwf/shared";
import type { DbHandle } from "../db/index.js";
import { cards, type CardRow } from "../db/schema.js";
import { rowToSummary } from "../scryfall/map.js";
import type { NameIndex } from "../search/index.js";

/**
 * Turn pasted text into concrete printings.
 *   1. exact set + collector number when the line has them
 *   2. exact (normalised) name -> best printing, preferring the named set
 *   3. fuzzy name -> "ambiguous" with candidates for the user to confirm
 * Commanders come from explicit markers, or from the "first small block of
 * legendary creatures" heuristic that Moxfield / MTGGoldfish exports rely on.
 */
export interface ResolveDeps {
  handle: DbHandle;
  index: NameIndex;
}

function canBeCommander(row: CardRow): boolean {
  const type = row.typeLine;
  if (!/\bLegendary\b/.test(type)) return false;
  if (/\bCreature\b/.test(type)) return true;
  return /can be your commander/i.test(row.oracleText);
}

export function resolveDecklist(deps: ResolveDeps, text: string): ResolveResponse {
  const { handle, index } = deps;
  const parsed = parseDecklist(text);

  interface Work {
    line: ParsedLine;
    status: ResolvedLine["status"];
    rowId: string | null;
    candidateIds: string[];
    note: string | null;
  }
  const work: Work[] = [];

  const bySetNumber = handle.sqlite.prepare(
    `SELECT id, normalized_name FROM cards WHERE "set" = ? AND lower(collector_number) = ? AND is_digital = 0 ORDER BY is_promo ASC LIMIT 5`,
  );

  for (const line of parsed.lines) {
    const norm = normalizeName(line.name);
    const w: Work = { line, status: "unresolved", rowId: null, candidateIds: [], note: null };

    // Archidekt exports flag maybeboard cards with a category instead of a section.
    if (line.tags.some((t) => /^maybe/i.test(t)) && line.board === "main") {
      w.line = { ...line, board: "maybeboard", tags: line.tags.filter((t) => !/^maybe/i.test(t)) };
    }

    // 1. exact printing
    if (line.set && line.collectorNumber) {
      const set = normalizeSetCode(line.set);
      const rows = bySetNumber.all(set, line.collectorNumber.toLowerCase()) as Array<{ id: string; normalized_name: string }>;
      const hit = rows.find((r) => r.normalized_name === norm || r.normalized_name.startsWith(`${norm} //`) || r.normalized_name.includes(`// ${norm}`)) ?? null;
      if (hit) {
        w.status = "resolved";
        w.rowId = hit.id;
        work.push(w);
        continue;
      }
      w.note = `printing (${line.set.toUpperCase()}) ${line.collectorNumber} not found; using another printing`;
    }

    // 2. exact name
    const exact = index.exact(norm);
    if (exact) {
      w.status = "resolved";
      w.rowId = exact.id;
      if (line.set) {
        const set = normalizeSetCode(line.set);
        const inSet = handle.db
          .select({ id: cards.id, oracleId: cards.oracleId })
          .from(cards)
          .where(and(eq(cards.set, set), eq(cards.normalizedName, exact.norm), eq(cards.isDigital, false)))
          .orderBy(desc(cards.inBooster), desc(cards.releasedAt))
          .get();
        if (inSet) {
          w.rowId = inSet.id;
          w.note = w.note && line.collectorNumber ? w.note.replace("using another printing", `using (${line.set.toUpperCase()}) printing`) : null;
        } else if (!w.note) {
          w.note = `no printing in (${line.set.toUpperCase()}); using the newest`;
        }
      }
      work.push(w);
      continue;
    }

    // 3. fuzzy
    const hits = index.search(line.name, { limit: 6, tokens: false });
    if (hits.length > 0) {
      w.status = "ambiguous";
      w.rowId = hits[0]!.id;
      w.candidateIds = hits.map((h) => h.id);
      w.note = "closest matches shown; confirm the right card";
    } else {
      w.status = "unresolved";
      w.note = "no card with a similar name";
    }
    work.push(w);
  }

  // Fetch every referenced row once.
  const ids = new Set<string>();
  for (const w of work) {
    if (w.rowId) ids.add(w.rowId);
    for (const c of w.candidateIds) ids.add(c);
  }
  const rows = ids.size ? handle.db.select().from(cards).where(inArray(cards.id, [...ids])).all() : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Commander detection.
  const explicit = parsed.hasExplicitCommander;
  const commanderIdx = new Set<number>();
  work.forEach((w, i) => {
    if (w.line.board === "commander" || w.line.commanderTag) commanderIdx.add(i);
  });
  if (!explicit && commanderIdx.size === 0 && work.length > 10) {
    const firstGroup = work.filter((w) => w.line.group === 0 && w.line.board === "main");
    const groups = new Set(work.map((w) => w.line.group));
    if (groups.size > 1 && firstGroup.length >= 1 && firstGroup.length <= 2) {
      const allLegendary = firstGroup.every((w) => {
        const row = w.rowId ? byId.get(w.rowId) : undefined;
        return w.line.quantity === 1 && row !== undefined && canBeCommander(row);
      });
      if (allLegendary) for (const w of firstGroup) commanderIdx.add(work.indexOf(w));
    }
  }

  const lines: ResolvedLine[] = work.map((w, i) => {
    const row = w.rowId ? byId.get(w.rowId) : undefined;
    const commander = commanderIdx.has(i);
    return {
      line: commander ? { ...w.line, board: "commander" } : w.line,
      status: w.status,
      card: row ? rowToSummary(row) : null,
      candidates: w.candidateIds.flatMap((id) => {
        const r = byId.get(id);
        return r ? [rowToSummary(r)] : [];
      }),
      note: w.note,
      commander,
    };
  });

  const counts = { resolved: 0, ambiguous: 0, unresolved: 0 };
  for (const l of lines) counts[l.status] += 1;
  const firstCommander = lines.find((l) => l.commander && l.card)?.card?.name ?? null;

  return { lines, suggestedName: parsed.name ?? firstCommander, counts };
}

/** Does a printing id exist? Used when saving a deck. */
export function existingCardIds(handle: DbHandle, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = handle.db
    .select({ id: cards.id })
    .from(cards)
    .where(inArray(cards.id, ids))
    .all();
  return new Set(rows.map((r) => r.id));
}

export function countCards(handle: DbHandle): number {
  return handle.db.select({ n: sql<number>`count(*)` }).from(cards).get()?.n ?? 0;
}
