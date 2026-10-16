import fs from "node:fs";
import path from "node:path";
import { normalizeName } from "@cgwf/shared";
import { config } from "../config.js";
import { frontName, type AnalysisCard } from "./cards.js";

/**
 * The Game Changers list is a hand-maintained JSON file (server/data/brackets/
 * game_changers.json) so the owner can update it the day Wizards does, without
 * a code change. The bracket rules that use it are summarised in CLAUDE.md.
 */
export interface GameChangersList {
  source: string;
  listDate: string;
  checkedAt: string;
  cards: string[];
  /** normalised name -> canonical name */
  index: Map<string, string>;
}

export const GAME_CHANGERS_FILE = path.join(config.bracketDataDir, "game_changers.json");

let cached: { mtime: number; list: GameChangersList } | null = null;

export function loadGameChangers(file: string = GAME_CHANGERS_FILE): GameChangersList {
  const mtime = fs.statSync(file).mtimeMs;
  if (cached && cached.mtime === mtime && file === GAME_CHANGERS_FILE) return cached.list;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { source?: string; listDate?: string; checkedAt?: string; cards?: unknown };
  const cards = Array.isArray(raw.cards) ? raw.cards.filter((c): c is string => typeof c === "string") : [];
  const list = fromNames(cards, { source: raw.source ?? "", listDate: raw.listDate ?? "unknown", checkedAt: raw.checkedAt ?? "unknown" });
  if (file === GAME_CHANGERS_FILE) cached = { mtime, list };
  return list;
}

export function fromNames(cards: string[], meta: { source?: string; listDate?: string; checkedAt?: string } = {}): GameChangersList {
  const index = new Map<string, string>();
  for (const c of cards) index.set(normalizeName(c), c);
  return { source: meta.source ?? "", listDate: meta.listDate ?? "test", checkedAt: meta.checkedAt ?? "test", cards, index };
}

/** Canonical Game Changer names present in the deck (commander included), in deck order, no duplicates. */
export function detectGameChangers(cards: AnalysisCard[], list: GameChangersList): string[] {
  const out: string[] = [];
  for (const c of cards) {
    const hit = list.index.get(normalizeName(c.name)) ?? list.index.get(normalizeName(frontName(c)));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}
