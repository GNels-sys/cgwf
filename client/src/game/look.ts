import { useEffect, useState, type CSSProperties } from "react";
import type { Look, Texture } from "@cgwf/shared";
import { api } from "../api";

/**
 * Turning a Texture (preset or upload) into CSS. Presets are pure CSS
 * gradients (no image files, nothing to license); uploads are fetched with the
 * device token and shown from a blob: URL so the server can keep them private.
 */

export const PLAYMAT_LABELS: Record<string, string> = {
  "felt-green": "Green felt",
  "felt-blue": "Blue felt",
  "felt-red": "Red felt",
  oak: "Oak",
  slate: "Slate",
  parchment: "Parchment",
  nebula: "Nebula",
};

export const SLEEVE_LABELS: Record<string, string> = {
  classic: "Classic",
  midnight: "Midnight",
  crimson: "Crimson",
  forest: "Forest",
  royal: "Royal",
  gold: "Gold",
  carbon: "Carbon",
  stripes: "Stripes",
};

export const THEME_LABELS: Record<string, string> = { wood: "Wood", stone: "Stone", space: "Space", velvet: "Velvet", plain: "Plain" };

/** Resolve an upload id to a blob: URL (null while loading or when forbidden). */
export function useUploadUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (!id) return;
    api.uploads
      .blobUrl(id)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);
  return url;
}

export function useTextureUrl(t: Texture | null | undefined): string | null {
  return useUploadUrl(t && t.kind === "upload" ? t.id : null);
}

/** Inline style for an uploaded texture; presets are handled by the `mat-*` / `sleeve-*` classes. */
export function textureStyle(url: string | null): CSSProperties {
  return url ? { backgroundImage: `url("${url}")`, backgroundSize: "cover", backgroundPosition: "center" } : {};
}

export function textureClass(prefix: "mat" | "sleeve", t: Texture | null | undefined): string {
  if (!t) return `${prefix}-${prefix === "mat" ? "felt-green" : "classic"}`;
  return t.kind === "preset" ? `${prefix}-${t.id}` : `${prefix}-upload`;
}

/** Every look at the table keyed by user id (from room info). */
export type Looks = Record<string, Look>;

/** Resolve many upload ids at once (one fetch each, cached), for everyone's sleeves and mats. */
export function useUploadUrls(ids: string[]): Record<string, string> {
  const key = ids.slice().sort().join(",");
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const wanted = key ? key.split(",") : [];
    Promise.all(wanted.map((id) => api.uploads.blobUrl(id).then((u) => [id, u] as const))).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [id, u] of pairs) if (u) next[id] = u;
      setUrls(next);
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return urls;
}

export interface SleeveStyle {
  className: string;
  style: CSSProperties;
}

/** Sleeve (card back) per player, from the looks in room info. */
export function useSleeves(looks: Looks): (ownerId: string) => SleeveStyle {
  const ids = Object.values(looks)
    .map((l) => l.sleeve)
    .filter((t) => t.kind === "upload")
    .map((t) => t.id);
  const urls = useUploadUrls(ids);
  return (ownerId: string) => {
    const t = looks[ownerId]?.sleeve;
    if (!t) return { className: "sleeve-classic", style: {} };
    if (t.kind === "preset") return { className: `sleeve-${t.id}`, style: {} };
    return { className: "sleeve-upload", style: textureStyle(urls[t.id] ?? null) };
  };
}

/** Playmat class + style for one player. */
export function useMat(look: Look | undefined): SleeveStyle {
  const t = look?.playmat;
  const url = useTextureUrl(t);
  if (!t) return { className: "mat-felt-green", style: {} };
  if (t.kind === "preset") return { className: `mat-${t.id}`, style: {} };
  return { className: "mat-upload", style: textureStyle(url) };
}
