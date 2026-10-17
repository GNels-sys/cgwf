import { DEFAULT_ENGINE_STOPS, ENGINE_PHASES, type EnginePhase, type EngineStops } from "./engine.js";
/**
 * Per-user personalization. Saved on the server (user_settings) and applied
 * client-side: the server never renders anything, it only stores and validates.
 * The `look` subset (playmat + sleeve) is shared with everyone at the same
 * table so opponents see your mat and your card backs.
 */

export const PLAYMAT_PRESETS = ["felt-green", "felt-blue", "felt-red", "oak", "slate", "parchment", "nebula"] as const;
export type PlaymatPreset = (typeof PLAYMAT_PRESETS)[number];

export const SLEEVE_PRESETS = ["classic", "midnight", "crimson", "forest", "royal", "gold", "carbon", "stripes"] as const;
export type SleevePreset = (typeof SLEEVE_PRESETS)[number];

export const TABLE_THEMES = ["wood", "stone", "space", "velvet", "plain"] as const;
export type TableTheme = (typeof TABLE_THEMES)[number];

export const ACCENTS = {
  brass: "#d9a441",
  ember: "#e0714a",
  jade: "#4fb06a",
  sky: "#4f9fe0",
  violet: "#9b6fe0",
  rose: "#e06c9d",
  ivory: "#e9e2c8",
} as const;
export type AccentKey = keyof typeof ACCENTS;

export const AMBIENT_LOOPS = ["none", "rain", "fire"] as const;
export type AmbientLoop = (typeof AMBIENT_LOOPS)[number];

export const OPPONENT_SIZES = ["small", "medium", "large"] as const;
export type OpponentSize = (typeof OPPONENT_SIZES)[number];

/** A texture choice: one of our CSS presets, or an image the player uploaded. */
export type Texture = { kind: "preset"; id: string } | { kind: "upload"; id: string };

export interface Look {
  playmat: Texture;
  sleeve: Texture;
}

export interface UserSettings {
  /** Rules-engine tables: where the engine pauses to offer this player priority (shared/engine.ts). */
  engineStops: EngineStops;
  playmat: Texture;
  sleeve: Texture;
  theme: TableTheme;
  accent: AccentKey;
  ui: "dark" | "light";
  ambient: AmbientLoop;
  layout: {
    /** Multiplier on card height: 0.7 - 1.5. */
    cardScale: number;
    hand: "bottom" | "top";
    opponentSize: OpponentSize;
    /** "strip": opponents across the top. "around": around the table (left / top / right). */
    opponents: "strip" | "around";
    compact: boolean;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  engineStops: DEFAULT_ENGINE_STOPS,
  playmat: { kind: "preset", id: "felt-green" },
  sleeve: { kind: "preset", id: "classic" },
  theme: "wood",
  accent: "brass",
  ui: "dark",
  ambient: "none",
  layout: { cardScale: 1, hand: "bottom", opponentSize: "medium", opponents: "strip", compact: false },
};

export const CARD_SCALE_MIN = 0.7;
export const CARD_SCALE_MAX = 1.5;
/** Upload ids are 32 hex characters (16 random bytes). */
const UPLOAD_ID = /^[0-9a-f]{32}$/;

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function texture(v: unknown, presets: readonly string[], fallback: Texture): Texture {
  if (!v || typeof v !== "object") return fallback;
  const t = v as { kind?: unknown; id?: unknown };
  if (t.kind === "preset" && typeof t.id === "string" && presets.includes(t.id)) return { kind: "preset", id: t.id };
  if (t.kind === "upload" && typeof t.id === "string" && UPLOAD_ID.test(t.id)) return { kind: "upload", id: t.id };
  return fallback;
}

/**
 * Coerce anything (a stored JSON blob, a client PATCH) into valid settings.
 * Unknown or malformed fields fall back to the defaults, so a stale client or
 * a hand-edited row can never break the table.
 */
export function sanitizeSettings(raw: unknown, base: UserSettings = DEFAULT_SETTINGS): UserSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const layout = (r.layout && typeof r.layout === "object" ? r.layout : {}) as Record<string, unknown>;
  const scale = typeof layout.cardScale === "number" && Number.isFinite(layout.cardScale) ? layout.cardScale : base.layout.cardScale;
  return {
    engineStops: sanitizeStops(r.engineStops, base.engineStops),
    playmat: texture(r.playmat, PLAYMAT_PRESETS, base.playmat),
    sleeve: texture(r.sleeve, SLEEVE_PRESETS, base.sleeve),
    theme: oneOf(r.theme, TABLE_THEMES, base.theme),
    accent: oneOf(r.accent, Object.keys(ACCENTS) as AccentKey[], base.accent),
    ui: oneOf(r.ui, ["dark", "light"] as const, base.ui),
    ambient: oneOf(r.ambient, AMBIENT_LOOPS, base.ambient),
    layout: {
      cardScale: Math.round(Math.max(CARD_SCALE_MIN, Math.min(CARD_SCALE_MAX, scale)) * 20) / 20,
      hand: oneOf(layout.hand, ["bottom", "top"] as const, base.layout.hand),
      opponentSize: oneOf(layout.opponentSize, OPPONENT_SIZES, base.layout.opponentSize),
      opponents: oneOf(layout.opponents, ["strip", "around"] as const, base.layout.opponents),
      compact: typeof layout.compact === "boolean" ? layout.compact : base.layout.compact,
    },
  };
}

function sanitizeStops(v: unknown, base: EngineStops): EngineStops {
  if (!v || typeof v !== "object") return base;
  const s = v as { myTurn?: unknown; theirTurn?: unknown; respond?: unknown };
  const phases = (arr: unknown, fallback: EnginePhase[]): EnginePhase[] =>
    Array.isArray(arr) ? [...new Set(arr.filter((p): p is EnginePhase => typeof p === "string" && (ENGINE_PHASES as readonly string[]).includes(p)))] : fallback;
  return { myTurn: phases(s.myTurn, base.myTurn), theirTurn: phases(s.theirTurn, base.theirTurn), respond: typeof s.respond === "boolean" ? s.respond : base.respond };
}

/** The part of a player's settings everyone at the table may see. */
export function lookOf(s: UserSettings): Look {
  return { playmat: s.playmat, sleeve: s.sleeve };
}

export function isUploadId(v: unknown): v is string {
  return typeof v === "string" && UPLOAD_ID.test(v);
}

/** Upload limits, shared so the client can refuse early and the server enforces. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_KINDS = ["playmat", "sleeve"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
export const UPLOAD_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export interface UploadInfo {
  id: string;
  kind: UploadKind;
  mime: string;
  bytes: number;
  createdAt: string;
}

export function uploadPath(id: string): string {
  return `/api/uploads/${id}`;
}
