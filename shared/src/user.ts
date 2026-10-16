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

/** The signed-in player's own view of themself (never sent for other players). */
export interface User {
  id: string;
  displayName: string;
  avatar: AvatarKey;
  color: AvatarColorKey;
  createdAt: string;
  /** Lower-cased account email, or null for a device-only profile. */
  email: string | null;
  /** Granted only through the one-time owner claim code. */
  isOwner: boolean;
}

/** Add an email + password to the current (device) profile. */
export interface SignUpRequest {
  email: string;
  password: string;
}

export interface SignInRequest {
  email: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** One signed-in device of the current account. */
export interface SessionInfo {
  id: string;
  device: string;
  createdAt: string;
  lastSeenAt: string;
  /** True for the session making the request. */
  current: boolean;
}

export const EMAIL_MAX = 254;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const OWNER_CODE_MAX = 128;

/** Lower-cased, trimmed email or null when it does not look like one. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const email = v.trim().toLowerCase();
  if (email.length < 3 || email.length > EMAIL_MAX) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(v: unknown): string | null {
  if (typeof v !== "string") return "enter a password";
  if (v.length < PASSWORD_MIN) return `use at least ${PASSWORD_MIN} characters`;
  if (v.length > PASSWORD_MAX) return `use at most ${PASSWORD_MAX} characters`;
  return null;
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
