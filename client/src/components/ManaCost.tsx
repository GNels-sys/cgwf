import { parseManaCost, parseOracleText, type ManaDot } from "@cgwf/shared";

/**
 * Mana symbols drawn as plain coloured dots. No Wizards artwork is used.
 * White, blue, black, red, green; grey for generic and colourless.
 */
const DOT_COLORS: Record<string, string> = {
  W: "#f3ecd2",
  U: "#2f7fd6",
  B: "#3a3240",
  R: "#d64a3a",
  G: "#3f9a56",
  C: "#9a9a9a",
};

function dotStyle(dot: ManaDot): React.CSSProperties {
  if (dot.colors.length >= 2) {
    const [a, b] = dot.colors;
    return { background: `linear-gradient(135deg, ${DOT_COLORS[a!]} 50%, ${DOT_COLORS[b!]} 50%)` };
  }
  if (dot.colors.length === 1) return { background: DOT_COLORS[dot.colors[0]!] };
  return { background: DOT_COLORS.C };
}

export function ManaDotView({ dot, size = 18 }: { dot: ManaDot; size?: number }) {
  const dark = dot.colors[0] === "W" || dot.colors.length === 0 || dot.colors[0] === "C";
  return (
    <span
      className={`mana-dot${dot.phyrexian ? " mana-dot-phyrexian" : ""}`}
      style={{ ...dotStyle(dot), width: size, height: size, fontSize: size * 0.6, color: dark ? "#1a1a1a" : "#fff" }}
      title={`{${dot.symbol}}`}
      aria-label={`{${dot.symbol}}`}
    >
      {dot.label}
    </span>
  );
}

export function ManaCost({ cost, size }: { cost: string; size?: number }) {
  const dots = parseManaCost(cost);
  if (dots.length === 0) return null;
  // Split cards: show both halves with a divider.
  const halves = cost.split(" // ");
  if (halves.length > 1) {
    return (
      <span className="mana-cost">
        {halves.map((h, i) => (
          <span key={i} className="mana-cost-half">
            {i > 0 && <span className="mana-divider">//</span>}
            {parseManaCost(h).map((d, j) => (
              <ManaDotView key={j} dot={d} {...(size !== undefined ? { size } : {})} />
            ))}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="mana-cost">
      {dots.map((d, i) => (
        <ManaDotView key={i} dot={d} {...(size !== undefined ? { size } : {})} />
      ))}
    </span>
  );
}

/** Oracle text with inline dots and preserved line breaks. */
export function OracleText({ text }: { text: string }) {
  const paragraphs = text.split("\n");
  return (
    <div className="oracle-text">
      {paragraphs.map((p, i) => (
        <p key={i}>
          {parseOracleText(p).map((seg, j) =>
            seg.type === "text" ? <span key={j}>{seg.text}</span> : <ManaDotView key={j} dot={seg.dot} size={15} />,
          )}
        </p>
      ))}
    </div>
  );
}
