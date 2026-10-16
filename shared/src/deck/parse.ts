/**
 * Decklist text parser. Accepts the common export formats from Archidekt,
 * Moxfield, MTGGoldfish, TappedOut and Arena, plus hand-typed lists.
 *
 * It only understands text: names, counts, set codes, boards and tags. Turning
 * a name into an actual printing happens on the server, which has card data.
 */

export type Board = "main" | "commander" | "sideboard" | "maybeboard" | "companion";

export interface ParsedLine {
  /** 1-based line number in the pasted text. */
  lineNo: number;
  raw: string;
  quantity: number;
  /** Card name as written (trimmed, markers removed). */
  name: string;
  /** Set code as written, lower-cased, if the line had one. */
  set: string | null;
  collectorNumber: string | null;
  foil: boolean;
  board: Board;
  /** Category tags such as Archidekt's "[Ramp]". "Commander" tags are removed and set commanderTag. */
  tags: string[];
  /** Explicitly marked as a commander on the line itself (tag or *CMDR*). */
  commanderTag: boolean;
  /** Index of the blank-line-separated block this line sits in (0-based). */
  group: number;
}

export interface IgnoredLine {
  lineNo: number;
  raw: string;
  reason: "comment" | "header" | "empty" | "unparsed";
}

export interface ParsedDecklist {
  lines: ParsedLine[];
  ignored: IgnoredLine[];
  /** True when at least one explicit commander marker or header was found. */
  hasExplicitCommander: boolean;
  /** Deck name if the text carried one (Arena "About / Name ..." block). */
  name: string | null;
}

const HEADERS: Array<[RegExp, Board]> = [
  [/^(commanders?|command\s*zone|cmdr)$/i, "commander"],
  [/^(companions?)$/i, "companion"],
  [/^(sideboard|side|sb)$/i, "sideboard"],
  [/^(maybeboard|maybe|considering|maybes)$/i, "maybeboard"],
  [/^(deck|main|mainboard|main\s*board|main\s*deck|maindeck|cards)$/i, "main"],
];

/** "Sideboard (15)", "Commander:", "## Deck" -> the bare header word(s). */
function headerWord(line: string): string {
  return line
    .replace(/^[#*\-=\s]+/, "")
    .replace(/[:\-=*#\s]+$/, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
}

function matchHeader(line: string): Board | null {
  const w = headerWord(line);
  if (!w || w.length > 24) return null;
  for (const [re, board] of HEADERS) if (re.test(w)) return board;
  return null;
}

const COMMANDER_TAG = /^commander(s)?(\{.*\})?$/i;

/** Parse one card line. Returns null when the line is not a card line. */
export function parseCardLine(raw: string): Omit<ParsedLine, "lineNo" | "group" | "board"> & { boardHint: Board | null } | null {
  let s = raw.trim();
  if (!s) return null;

  let boardHint: Board | null = null;
  const sb = s.match(/^SB:\s*/i);
  if (sb) {
    boardHint = "sideboard";
    s = s.slice(sb[0].length);
  }

  // Archidekt "^Have,#ffffff^" style annotations: drop.
  s = s.replace(/\^[^^]*\^/g, " ");

  // Trailing tags: "[Ramp]" or "[Ramp,Artifacts{top}]". May appear more than once.
  const tags: string[] = [];
  let commanderTag = false;
  s = s.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
    for (const t of inner.split(",")) {
      const tag = t.trim();
      if (!tag) continue;
      if (COMMANDER_TAG.test(tag)) commanderTag = true;
      else tags.push(tag.replace(/\{.*\}$/, ""));
    }
    return " ";
  });

  // Markers: *F* foil, *E* etched, *CMDR* commander, (foil).
  let foil = false;
  s = s.replace(/\*\s*(F|E|FOIL|ETCHED)\s*\*/gi, () => {
    foil = true;
    return " ";
  });
  s = s.replace(/\*\s*CMDR\s*\*/gi, () => {
    commanderTag = true;
    return " ";
  });
  s = s.replace(/\((foil|etched)\)/gi, () => {
    foil = true;
    return " ";
  });
  // TappedOut-style "#!Commander" or trailing "# comment".
  s = s.replace(/#!\s*commander\b/i, () => {
    commanderTag = true;
    return " ";
  });
  s = s.replace(/\s#.*$/, "");
  s = s.replace(/\s+/g, " ").trim();

  // Quantity: "1 Name", "1x Name", "x1 Name", "Name x1".
  let quantity = 1;
  let m = s.match(/^(\d+)\s*[xX]?\s+(.+)$/);
  if (m) {
    quantity = Number(m[1]);
    s = m[2] ?? "";
  } else if ((m = s.match(/^[xX](\d+)\s+(.+)$/))) {
    quantity = Number(m[1]);
    s = m[2] ?? "";
  } else if ((m = s.match(/^(.+?)\s+[xX](\d+)$/))) {
    quantity = Number(m[2]);
    s = m[1] ?? "";
  }
  if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;

  // Set + collector number: "Name (CMR) 472", "Name (cmr)", "Name (CMR) 472p".
  let set: string | null = null;
  let collectorNumber: string | null = null;
  const sm = s.match(/^(.*?)\s*\(([A-Za-z0-9]{2,6})\)\s*([A-Za-z0-9★\-]+)?\s*$/);
  if (sm && sm[1] && sm[1].trim()) {
    const code = (sm[2] ?? "").toLowerCase();
    // Avoid eating a real parenthetical that is part of a card name (rare, e.g. tokens).
    if (!/^(foil|etched)$/i.test(code)) {
      set = code;
      collectorNumber = sm[3] ?? null;
      s = sm[1].trim();
    }
  }

  const name = s.replace(/\s+/g, " ").trim();
  if (!name) return null;
  // Lines that are clearly not card names.
  if (/^(total|cards?|count)\b/i.test(name) && !set) return null;

  return { raw, quantity, name, set, collectorNumber, foil, tags, commanderTag, boardHint };
}

export function parseDecklist(text: string): ParsedDecklist {
  const lines: ParsedLine[] = [];
  const ignored: IgnoredLine[] = [];
  let board: Board = "main";
  let group = 0;
  let groupHasCards = false;
  let hasExplicitCommander = false;
  let name: string | null = null;
  let inAbout = false;

  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  rows.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();

    if (!trimmed) {
      if (groupHasCards) {
        group += 1;
        groupHasCards = false;
      }
      ignored.push({ lineNo, raw, reason: "empty" });
      inAbout = false;
      return;
    }
    if (/^(\/\/|#(?!!)|;)/.test(trimmed)) {
      ignored.push({ lineNo, raw, reason: "comment" });
      return;
    }
    if (/^about$/i.test(headerWord(trimmed))) {
      inAbout = true;
      ignored.push({ lineNo, raw, reason: "header" });
      return;
    }
    if (inAbout) {
      const nm = trimmed.match(/^name\s+(.+)$/i);
      if (nm) name = (nm[1] ?? "").trim();
      ignored.push({ lineNo, raw, reason: "header" });
      return;
    }
    const header = matchHeader(trimmed);
    if (header) {
      board = header;
      if (header === "commander") hasExplicitCommander = true;
      if (groupHasCards) {
        group += 1;
        groupHasCards = false;
      }
      ignored.push({ lineNo, raw, reason: "header" });
      return;
    }

    const parsed = parseCardLine(trimmed);
    if (!parsed) {
      ignored.push({ lineNo, raw, reason: "unparsed" });
      return;
    }
    const { boardHint, ...rest } = parsed;
    let lineBoard: Board = boardHint ?? board;
    if (rest.commanderTag) {
      lineBoard = "commander";
      hasExplicitCommander = true;
    }
    lines.push({ ...rest, lineNo, board: lineBoard, group });
    groupHasCards = true;
  });

  return { lines, ignored, hasExplicitCommander, name };
}

/**
 * Arena and some sites use set codes that differ from Scryfall's.
 * Applied when resolving a printing by set + number.
 */
export const SET_CODE_ALIASES: Record<string, string> = {
  dar: "dom", // Dominaria
  con: "con", // Conflux (Arena writes CON_ sometimes)
  mi: "mir",
  "6e": "6ed",
  "7e": "7ed",
  "8e": "8ed",
  "9e": "9ed",
  "10e": "10e",
};

export function normalizeSetCode(code: string): string {
  const c = code.toLowerCase().replace(/_$/, "");
  return SET_CODE_ALIASES[c] ?? c;
}
