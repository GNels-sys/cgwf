/** Preset avatars: plain emoji, no trademarked artwork. */
export const AVATARS = [
  "dragon",
  "wizard",
  "knight",
  "fox",
  "owl",
  "wolf",
  "cat",
  "frog",
  "octopus",
  "skull",
  "flame",
  "leaf",
  "wave",
  "bolt",
  "crystal",
  "moon",
] as const;
export type AvatarKey = (typeof AVATARS)[number];

export const AVATAR_EMOJI: Record<AvatarKey, string> = {
  dragon: "\u{1F409}",
  wizard: "\u{1F9D9}",
  knight: "\u{1F6E1}️",
  fox: "\u{1F98A}",
  owl: "\u{1F989}",
  wolf: "\u{1F43A}",
  cat: "\u{1F408}",
  frog: "\u{1F438}",
  octopus: "\u{1F419}",
  skull: "\u{1F480}",
  flame: "\u{1F525}",
  leaf: "\u{1F343}",
  wave: "\u{1F30A}",
  bolt: "⚡",
  crystal: "\u{1F52E}",
  moon: "\u{1F319}",
};

export const AVATAR_COLORS = {
  gold: "#d9a441",
  ruby: "#d64a3a",
  jade: "#3f9a56",
  sapphire: "#2f7fd6",
  amethyst: "#8e5bd6",
  rose: "#d6628f",
  slate: "#6b7f8a",
  ivory: "#e9e2c8",
} as const;
export type AvatarColorKey = keyof typeof AVATAR_COLORS;

export interface User {
  id: string;
  displayName: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  createdAt: string;
}

export interface RegisterRequest {
  displayName: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
}

export interface RegisterResponse {
  /** Device secret. Shown once; the client stores it and sends it as a Bearer token. */
  token: string;
  user: User;
}

export const DISPLAY_NAME_MAX = 24;

export function isAvatarKey(v: unknown): v is AvatarKey {
  return typeof v === "string" && (AVATARS as readonly string[]).includes(v);
}
export function isAvatarColorKey(v: unknown): v is AvatarColorKey {
  return typeof v === "string" && v in AVATAR_COLORS;
}
