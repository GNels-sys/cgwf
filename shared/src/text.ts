/**
 * Normalise a card name for matching: lowercase, strip accents and punctuation,
 * collapse whitespace. "Lim-Dul's Vault" -> "lim duls vault".
 */
export function normalizeName(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/'/g, "")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s*\/\s*\/\s*|\s*\/\s*/g, " // ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bounded Damerau-Levenshtein distance (adjacent transpositions count as 1). */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? 0) + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb] ?? max + 1;
}
