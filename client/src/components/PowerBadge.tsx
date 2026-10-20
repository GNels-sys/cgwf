import type { PowerLevel } from "./performanceFit";

/** One bracket palette across analysis, collection, library, and game results. */
export function PowerBadge({ level, label }: { level: PowerLevel | number | null; label?: string }) {
  return <span className="power-badge" data-power={level ?? "unknown"}>
    {label && <span className="power-badge-label">{label}</span>}
    <strong>{level === null ? "Unrated" : `B${level}`}</strong>
  </span>;
}
