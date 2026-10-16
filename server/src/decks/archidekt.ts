import type { ImportUrlResponse } from "@cgwf/shared";
import { SCRYFALL_USER_AGENT } from "../config.js";

/**
 * Archidekt exposes a public, unauthenticated JSON API for public decks
 * (https://archidekt.com/api/decks/{id}/). Moxfield's API sits behind
 * Cloudflare bot protection and returns 403 to non-browser clients, so for
 * Moxfield we tell the user to export as text and paste.
 * Checked 2026-10-15.
 */

interface ArchidektDeck {
  name: string;
  categories?: Array<{ name: string; includedInDeck?: boolean }>;
  cards: Array<{
    quantity: number;
    categories?: string[];
    companion?: boolean;
    modifier?: string;
    card: {
      uid?: string;
      collectorNumber?: string;
      edition?: { editioncode?: string };
      oracleCard?: { name?: string };
      displayName?: string | null;
    };
  }>;
}

export type ImportUrlKind = { kind: "archidekt"; id: string } | { kind: "moxfield" } | { kind: "unknown" };

export function classifyImportUrl(raw: string): ImportUrlKind {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { kind: "unknown" };
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "archidekt.com") {
    const m = url.pathname.match(/^\/(?:api\/)?decks\/(\d+)/);
    if (m && m[1]) return { kind: "archidekt", id: m[1] };
  }
  if (host === "moxfield.com") return { kind: "moxfield" };
  return { kind: "unknown" };
}

export async function fetchArchidektDeck(id: string): Promise<ImportUrlResponse> {
  const url = `https://archidekt.com/api/decks/${id}/`;
  const res = await fetch(url, { headers: { "User-Agent": SCRYFALL_USER_AGENT, Accept: "application/json" } });
  if (res.status === 404) throw new Error("Archidekt deck not found (is it public?)");
  if (!res.ok) throw new Error(`Archidekt answered ${res.status}`);
  const deck = (await res.json()) as ArchidektDeck;

  const excluded = new Set((deck.categories ?? []).filter((c) => c.includedInDeck === false).map((c) => c.name));
  const sections: Record<"Commander" | "Companion" | "Deck" | "Maybeboard", string[]> = {
    Commander: [],
    Companion: [],
    Deck: [],
    Maybeboard: [],
  };

  for (const entry of deck.cards) {
    const name = entry.card.oracleCard?.name ?? entry.card.displayName;
    if (!name) continue;
    const cats = entry.categories ?? [];
    const isCommander = cats.some((c) => /^commander$/i.test(c));
    const isMaybe = cats.some((c) => excluded.has(c));
    const set = entry.card.edition?.editioncode;
    const num = entry.card.collectorNumber;
    const foil = entry.modifier && entry.modifier !== "Normal" ? " *F*" : "";
    const tags = cats.filter((c) => !/^commander$/i.test(c) && !excluded.has(c));
    const tagText = tags.length ? ` [${tags.join(",")}]` : "";
    const printing = set && num ? ` (${set}) ${num}` : set ? ` (${set})` : "";
    const line = `${entry.quantity} ${name}${printing}${foil}${tagText}`;
    if (isCommander) sections.Commander.push(line);
    else if (entry.companion) sections.Companion.push(line);
    else if (isMaybe) sections.Maybeboard.push(line);
    else sections.Deck.push(line);
  }

  const text = (Object.keys(sections) as Array<keyof typeof sections>)
    .filter((k) => sections[k].length > 0)
    .map((k) => `${k}\n${sections[k].join("\n")}`)
    .join("\n\n");

  return { source: "archidekt", name: deck.name, text, url: `https://archidekt.com/decks/${id}` };
}
