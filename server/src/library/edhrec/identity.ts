/**
 * The 32 Commander colour identities, keyed by their WUBRG-ordered letters ("" = colourless),
 * with EDHREC's page slug for each and the size group the diversity rules count.
 */
export type IdentityGroup = "colorless" | "mono" | "two" | "three" | "four" | "five";

export interface IdentityInfo {
  /** WUBRG-ordered letters; "" for colourless. */
  key: string;
  /** EDHREC slug: commanders/<slug>.json lists the identity's top 100 commanders. */
  slug: string;
  label: string;
  group: IdentityGroup;
}

const ORDER = "WUBRG";

/** Normalise any colour list ("G", "U" / "UG" / ["U","G"]) to WUBRG order. */
export function identityKey(colors: readonly string[] | string): string {
  const set = new Set((typeof colors === "string" ? colors.split("") : colors).map((c) => c.toUpperCase()));
  return ORDER.split("")
    .filter((c) => set.has(c))
    .join("");
}

export const IDENTITIES: readonly IdentityInfo[] = [
  { key: "", slug: "colorless", label: "Colourless", group: "colorless" },
  { key: "W", slug: "mono-white", label: "Mono-white", group: "mono" },
  { key: "U", slug: "mono-blue", label: "Mono-blue", group: "mono" },
  { key: "B", slug: "mono-black", label: "Mono-black", group: "mono" },
  { key: "R", slug: "mono-red", label: "Mono-red", group: "mono" },
  { key: "G", slug: "mono-green", label: "Mono-green", group: "mono" },
  { key: "WU", slug: "azorius", label: "Azorius", group: "two" },
  { key: "UB", slug: "dimir", label: "Dimir", group: "two" },
  { key: "BR", slug: "rakdos", label: "Rakdos", group: "two" },
  { key: "RG", slug: "gruul", label: "Gruul", group: "two" },
  { key: "WG", slug: "selesnya", label: "Selesnya", group: "two" },
  { key: "WB", slug: "orzhov", label: "Orzhov", group: "two" },
  { key: "UR", slug: "izzet", label: "Izzet", group: "two" },
  { key: "BG", slug: "golgari", label: "Golgari", group: "two" },
  { key: "WR", slug: "boros", label: "Boros", group: "two" },
  { key: "UG", slug: "simic", label: "Simic", group: "two" },
  { key: "WUB", slug: "esper", label: "Esper", group: "three" },
  { key: "UBR", slug: "grixis", label: "Grixis", group: "three" },
  { key: "BRG", slug: "jund", label: "Jund", group: "three" },
  { key: "WRG", slug: "naya", label: "Naya", group: "three" },
  { key: "WUG", slug: "bant", label: "Bant", group: "three" },
  { key: "WBG", slug: "abzan", label: "Abzan", group: "three" },
  { key: "WUR", slug: "jeskai", label: "Jeskai", group: "three" },
  { key: "UBG", slug: "sultai", label: "Sultai", group: "three" },
  { key: "WBR", slug: "mardu", label: "Mardu", group: "three" },
  { key: "URG", slug: "temur", label: "Temur", group: "three" },
  { key: "WUBR", slug: "yore-tiller", label: "Yore-Tiller (non-green)", group: "four" },
  { key: "UBRG", slug: "glint-eye", label: "Glint-Eye (non-white)", group: "four" },
  { key: "WBRG", slug: "dune-brood", label: "Dune-Brood (non-blue)", group: "four" },
  { key: "WURG", slug: "ink-treader", label: "Ink-Treader (non-black)", group: "four" },
  { key: "WUBG", slug: "witch-maw", label: "Witch-Maw (non-red)", group: "four" },
  { key: "WUBRG", slug: "five-color", label: "Five-colour", group: "five" },
];

const BY_KEY = new Map(IDENTITIES.map((i) => [i.key, i]));

export function identityInfo(key: string): IdentityInfo {
  const info = BY_KEY.get(identityKey(key));
  if (!info) throw new Error(`unknown colour identity ${key}`);
  return info;
}

export const IDENTITY_GROUPS: readonly IdentityGroup[] = ["mono", "two", "three", "four", "five", "colorless"];
