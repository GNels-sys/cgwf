import type { BridgeMeta } from "@cgwf/shared";

/**
 * Pure helpers for the local-stores panels (Phase 10). No React here so the
 * wording and the freshness arithmetic can be unit-tested on their own.
 */

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "at an unknown time";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at an unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return new Date(t).toLocaleDateString();
}

/** The note under every panel: where the data came from and how old it is. */
export function sourceSentence(meta: Pick<BridgeMeta, "status" | "dataAsOf" | "cached">, now = Date.now()): string {
  if (meta.status !== "ok") return "From local store data.";
  const when = relativeTime(meta.dataAsOf, now);
  return `Updated ${when}, from local store data.${meta.cached ? " Shown from a recent check." : ""}`;
}

/** Plain-language reason for a panel that has nothing to show. */
export function statusMessage(meta: Pick<BridgeMeta, "status" | "reason">): string | null {
  if (meta.status === "ok") return null;
  if (meta.status === "unconfigured") return "Local store lookups are not switched on for this server.";
  return "Local store data is unavailable right now. Try again in a minute.";
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function money(n: number | null, currency = "USD"): string {
  if (n == null) return "price not listed";
  if (currency === "USD") return usd.format(n);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export const FINISH_LABELS: Record<string, string> = { nonfoil: "Non-foil", foil: "Foil", etched: "Etched foil" };

export function finishLabel(finish: string): string {
  return FINISH_LABELS[finish] ?? finish;
}

export const CONDITION_LABELS: Record<string, string> = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
};

export function conditionLabel(condition: string | null): string {
  if (!condition) return "condition not listed";
  return CONDITION_LABELS[condition] ?? condition;
}

/** "Product page", "Catalog page" or "Search the store", for the link text. */
export function linkLabel(urlKind: "product" | "page" | "search"): string {
  if (urlKind === "product") return "Open listing";
  if (urlKind === "page") return "Open catalog page";
  return "Search the store";
}
