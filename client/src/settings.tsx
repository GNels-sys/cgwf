import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACCENTS, DEFAULT_SETTINGS, sanitizeSettings, type UserSettings } from "@cgwf/shared";
import { api } from "./api";
import { useUser } from "./user";

/**
 * Personalization. Settings live on the server per user and are applied here,
 * client-side only: UI theme and accent on the document, everything else by
 * the table. A copy is kept in localStorage so the look is right on first paint.
 */

const CACHE_KEY = "cgwf.settings";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends Array<unknown> ? T[K] : DeepPartial<T[K]>) : T[K] };

interface SettingsState {
  settings: UserSettings;
  /** Merge a partial update, apply it at once and save it in the background. */
  update: (patch: DeepPartial<UserSettings>) => void;
  saving: boolean;
  error: string | null;
}

const Ctx = createContext<SettingsState | null>(null);

function readCache(): UserSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeCache(s: UserSettings): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/** Accent text colour: dark ink on light accents, light on dark ones. */
export function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 140 ? "#1a1408" : "#ffffff";
}

function applyToDocument(s: UserSettings): void {
  const root = document.documentElement;
  root.dataset.ui = s.ui;
  root.style.setProperty("--accent", ACCENTS[s.accent]);
  root.style.setProperty("--accent-ink", inkFor(ACCENTS[s.accent]));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", s.ui === "light" ? "#f3efe4" : "#121a16");
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const [settings, setSettings] = useState<UserSettings>(readCache);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<unknown> | null>(null);

  useEffect(() => applyToDocument(settings), [settings]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api.settings
      .get()
      .then((r) => {
        if (cancelled) return;
        setSettings(r.settings);
        writeCache(r.settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const update = useCallback(
    (patch: DeepPartial<UserSettings>) => {
      setSettings((prev) => {
        const merged = sanitizeSettings({ ...prev, ...patch, layout: { ...prev.layout, ...(patch.layout ?? {}) } }, prev);
        writeCache(merged);
        if (user) {
          setSaving(true);
          setError(null);
          const job = api.settings
            .save(merged)
            .then((r) => {
              // The server is the judge (e.g. a deleted upload falls back to a preset).
              if (pending.current === job) {
                setSettings(r.settings);
                writeCache(r.settings);
              }
            })
            .catch((e: Error) => setError(e.message))
            .finally(() => {
              if (pending.current === job) {
                pending.current = null;
                setSaving(false);
              }
            });
          pending.current = job;
        }
        return merged;
      });
    },
    [user],
  );

  const value = useMemo(() => ({ settings, update, saving, error }), [settings, update, saving, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings outside SettingsProvider");
  return v;
}

/** Does this device ask for less motion? Read live so a toggle mid-game is honoured. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
