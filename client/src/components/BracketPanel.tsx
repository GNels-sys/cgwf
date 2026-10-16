import { useCallback, useEffect, useState } from "react";
import { ARCHETYPE_LABELS, BRACKET_NAMES, type DeckAnalysis } from "@cgwf/shared";
import { api } from "../api";

/**
 * The "Bracket" panel on a deck page: floor + suggested bracket, the hard-rule
 * reasons card by card, soft power signals, archetype tags, combos (credited to
 * Commander Spellbook) and the plain-language summary. No model spend.
 */
export function BracketBadge({ bracket, label }: { bracket: 1 | 2 | 3 | 4 | 5; label: string }) {
  return (
    <div className={`bracket-badge b${bracket}`}>
      <span className="bracket-badge-label">{label}</span>
      <span className="bracket-badge-num">{bracket}</span>
      <span className="bracket-badge-name">{BRACKET_NAMES[bracket]}</span>
    </div>
  );
}

export function AnalysisBody({ a }: { a: DeckAnalysis }) {
  const [showSignals, setShowSignals] = useState(false);
  const two = a.combos.filter((c) => c.twoCard);
  const other = a.combos.filter((c) => !c.twoCard);
  return (
    <>
      <div className="bracket-badges">
        <BracketBadge bracket={a.floor} label="Floor" />
        <BracketBadge bracket={a.suggested} label="Suggested" />
      </div>
      <p className="bracket-summary">{a.summary}</p>
      <p className="muted small">{a.judgmentNote}</p>

      {a.reasons.length > 0 ? (
        <section>
          <h4>Why the floor is {a.floor}</h4>
          <ul className="bracket-reasons">
            {a.reasons.map((r) => (
              <li key={r.kind}>
                <span className={`bracket-pill b${r.bracket}`}>B{r.bracket}+</span> {r.text}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="small">No Game Changers, mass land denial, extra turns or two-card infinite combos found.</p>
      )}

      {a.archetypes.length > 0 && (
        <section>
          <h4>Strategy</h4>
          <div className="tag-row">
            {a.archetypes.map((t) => (
              <span key={t.tag} className="chip tag-chip" title={`${Math.round(t.confidence * 100)}%: ${t.evidence.join(", ")}`}>
                {ARCHETYPE_LABELS[t.tag]} <span className="muted">{Math.round(t.confidence * 100)}%</span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>
          Combos{" "}
          <span className="muted small">
            by{" "}
            <a href="https://commanderspellbook.com" target="_blank" rel="noreferrer">
              Commander Spellbook
            </a>
          </span>
        </h4>
        {a.combosStatus === "unavailable" && <p className="small warn">Combo lookup unavailable right now; the floor ignores combos until it works.</p>}
        {a.combosStatus === "skipped" && <p className="small muted">Combo lookup skipped.</p>}
        {a.combosStatus === "ok" && a.combos.length === 0 && <p className="small muted">None found in this list.</p>}
        {a.combos.length > 0 && (
          <ul className="combo-list">
            {[...two, ...other].slice(0, 12).map((c) => (
              <li key={c.id}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.cards.join(" + ")}
                </a>{" "}
                <span className="muted small">
                  {c.produces.slice(0, 2).join(", ")}
                  {c.twoCard ? (c.early ? " · two-card, early-game" : " · two-card") : ""}
                  {Number.isFinite(c.manaValueNeeded) && c.manaValueNeeded < 99 ? ` · ${c.manaValueNeeded} mana` : ""}
                </span>
              </li>
            ))}
            {a.combos.length > 12 && <li className="muted small">and {a.combos.length - 12} more</li>}
          </ul>
        )}
      </section>

      <section>
        <button className="btn btn-small" onClick={() => setShowSignals((s) => !s)}>
          {showSignals ? "Hide details" : "Details"}
        </button>
        {showSignals && (
          <div className="bracket-details">
            <p className="small">
              <strong>Game Changers</strong> ({a.gameChangersListDate} list): {a.gameChangers.join(", ") || "none"}
            </p>
            <p className="small">
              <strong>Tutors</strong> ({a.tutors.count}): {a.tutors.cards.map((t) => `${t.name} (${t.kind.replace("_", "/")})`).join(", ") || "none"}
            </p>
            <p className="small">
              <strong>Fast mana</strong>: {a.fastMana.join(", ") || "none"}
            </p>
            <p className="small">
              <strong>Extra turns</strong>: {a.extraTurns.cards.join(", ") || "none"}
              {a.extraTurns.chaining && a.extraTurns.chainingWhy ? ` (chaining: ${a.extraTurns.chainingWhy})` : ""}
            </p>
            <p className="small">
              <strong>Mass land denial</strong>: {a.massLandDenial.join(", ") || "none"}
            </p>
            {a.signals.length > 0 && (
              <p className="small">
                <strong>Power signals</strong>: {a.signals.map((s) => `${s.text} (+${s.weight})`).join(", ")}
              </p>
            )}
            <p className="small muted">
              {a.stats.cards} cards · {a.stats.landCount} lands · avg MV {a.stats.averageManaValue} · ramp {a.stats.rampCount} · draw {a.stats.cardDrawCount} · interaction{" "}
              {a.stats.interactionCount} · computed {new Date(a.computedAt).toLocaleString()}
            </p>
          </div>
        )}
      </section>
    </>
  );
}

/** `version` changes whenever the deck's list changes, which re-runs the analysis. */
export function BracketPanel({ deckId, version }: { deckId: string; version: string }) {
  const [analysis, setAnalysis] = useState<DeckAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const r = await api.decks.analysis(deckId, refresh);
        setAnalysis(r.analysis);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [deckId],
  );

  useEffect(() => {
    void load(false);
  }, [load, version]);

  return (
    <section className="bracket-panel">
      <div className="row-between">
        <h3>Bracket</h3>
        <button className="btn btn-small" disabled={busy} onClick={() => void load(true)}>
          {busy ? "Working..." : "Recompute"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!analysis && !error && <p className="muted small">Analysing...</p>}
      {analysis && <AnalysisBody a={analysis} />}
    </section>
  );
}
