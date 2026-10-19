/** Original vector effects around a frame, never over a card face. */
export function cardEnergy(colors: readonly string[] | undefined): string {
  return colors?.length === 1 ? `var(--mana-${colors[0]})` : colors?.length ? "var(--accent)" : "var(--mana-C)";
}

export function ElectricArc({ color = "var(--danger)", className = "" }: { color?: string; className?: string }) {
  return <svg className={`electric-arc ${className}`} style={{ "--shock-color": color } as React.CSSProperties} viewBox="0 0 400 220" preserveAspectRatio="none" fill="none" aria-hidden="true">
    <path d="M6 76 16 61 8 49 21 34 15 16 78 16 94 7 112 16 147 12M394 143 381 157 390 172 377 184 385 204 319 204 304 213 285 204 252 208"/>
    <path d="M6 148 17 136 8 120 18 105M394 72 382 85 391 100 380 116M157 15 172 7 188 17 213 11M232 205 214 213 194 203 177 211"/>
  </svg>;
}
