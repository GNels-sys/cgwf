import { useCallback, useEffect, useState } from "react";
import { BRACKET_NAMES, DOCTOR_ROLE_LABELS, type Bracket, type DoctorCardRef, type DoctorResponse, type DoctorSwap } from "@cgwf/shared";
import { isOwner, useUser } from "../user";
import { DoctorAiSection } from "./DoctorAiSection";
import { api } from "../api";
import { CardDetail } from "./CardDetail";
import { useCardHover } from "./CardHoverPreview";
import { ManaCost } from "./ManaCost";
import { PowerBadge } from "./PowerBadge";
import { stockText } from "./doctorText";

/**
 * Deck Doctor: suggested "Add X / Cut Y" swaps from EDHREC synergy, Spellbook combos and role gaps
 * (server/src/analysis/doctor). Own decks can apply a swap; library decks are read-only. Keep / Not
 * interested are remembered per player and deck.
 */
export function DoctorPanel({ kind, id, version, onApplied }: { kind: "own" | "library"; id: string; version: string; onApplied?: () => void }) {
  const [data, setData] = useState<DoctorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bracket, setBracket] = useState<Bracket | null>(null);
  const [allowHigher, setAllowHigher] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hover = useCardHover();
  const { user } = useUser();

  useEffect(() => {
    let live = true;
    setError(null);
    api.doctor
      .get(kind, id, { bracket, allowHigher })
      .then((r) => {
        if (live) setData(r);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [kind, id, version, bracket, allowHigher, attempt]);

  const deckRef = data?.deckRef ?? (kind === "own" ? id : `library:${id}`);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  const act = async (key: string, fn: () => Promise<unknown>, after: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      after();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const applyLine = (cutEntryId: number, addOracleId: string) =>
    void act(`apply:${addOracleId}`, () => api.doctor.apply(id, cutEntryId, addOracleId), () => {
      onApplied?.();
      refresh();
    });
  const apply = (s: DoctorSwap) => applyLine(s.cut.entryId!, s.add.oracleId!);
  const pref = (kindOf: "keep" | "dismiss", oracleId: string | null, name: string, clear = false) => {
    if (!oracleId) return;
    void act(`${kindOf}:${oracleId}`, () => (clear ? api.doctor.clearPref({ deckRef, oracleId, name, kind: kindOf }) : api.doctor.setPref({ deckRef, oracleId, name, kind: kindOf })), refresh);
  };

  const card = (c: DoctorCardRef, sign: "+" | "−") => (
    <button type="button" className={`doctor-card ${sign === "+" ? "is-add" : "is-cut"}`} onClick={() => setOpen(c.cardId)} {...hover.bind({ id: c.cardId, name: c.name, faceCount: c.faceCount })}>
      <span className="doctor-sign" aria-hidden="true">{sign}</span>
      <span className="doctor-card-name">{c.name}</span>
      <ManaCost cost={c.manaCost} size={12} />
    </button>
  );

  return (
    <section className="surface doctor-panel" aria-label="Deck Doctor">
      <div className="analysis-panel-heading doctor-head">
        <div className="analysis-panel-title">
          <span className="analysis-panel-glyph" aria-hidden="true">✚</span>
          <div>
            <p className="eyebrow">Tune-up</p>
            <h2>Deck Doctor</h2>
          </div>
        </div>
        <div className="doctor-controls">
          <label>
            <span className="small muted">Target</span>{" "}
            <select value={bracket ?? data?.targetBracket ?? ""} onChange={(e) => setBracket(Number(e.target.value) as Bracket)} aria-label="Target bracket">
              {([1, 2, 3, 4, 5] as const).map((b) => (
                <option key={b} value={b}>
                  B{b} · {BRACKET_NAMES[b]}
                  {data && b === data.suggestedBracket ? " (suggested)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="small">
            <input type="checkbox" checked={allowHigher} onChange={(e) => setAllowHigher(e.target.checked)} /> Allow a higher bracket
          </label>
        </div>
      </div>

      {error && (
        <div className="notice error">
          <p>{error}</p>
          <button className="btn btn-small" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {!data && !error && (
        <p className="muted" role="status">
          Reading EDHREC and the combo database…
        </p>
      )}
      {data && (
        <>
          <ul className="doctor-roles" aria-label="Deck roles">
            {data.roles.map((r) => (
              <li key={r.role} className={r.have < r.want ? "is-short" : ""} title={r.have < r.want ? `Below the usual ${r.want}` : undefined}>
                <span>{DOCTOR_ROLE_LABELS[r.role]}</span>
                <strong>
                  {r.have}
                  <span className="muted">/{r.want}</span>
                </strong>
              </li>
            ))}
          </ul>
          {data.edhrec.status !== "ok" && <p className="small warn">{data.edhrec.message}</p>}
          {data.swaps.length === 0 ? (
            <p className="muted small">
              {data.edhrec.status === "ok" ? "Nothing to suggest at this bracket: every strong candidate is in the deck, dismissed, or would raise the bracket." : "No suggestions without EDHREC data for this commander."}
            </p>
          ) : (
            <ol className="doctor-swaps">
              {data.swaps.map((s) => (
                <li key={`${s.add.oracleId}-${s.cut.entryId}`} className="doctor-swap">
                  <div className="doctor-pair">
                    {card(s.add, "+")}
                    {card(s.cut, "−")}
                  </div>
                  <p className="small doctor-reason">{s.reason}</p>
                  <div className="doctor-meta small">
                    {s.role && <span className="chip tag-chip small">{DOCTOR_ROLE_LABELS[s.role]}</span>}
                    {s.combos.length > 0 && <span className="chip tag-chip small is-combo" title={s.combos.join("\n")}>Combo</span>}
                    {s.bracket.raises ? (
                      <span className="doctor-bracket warn">
                        <PowerBadge level={s.bracket.floorAfter} label="Floor" /> {s.bracket.note}
                      </span>
                    ) : null}
                    {stockText(s.add.localStores, s.add.cheapestLocal) && <span className="muted">{stockText(s.add.localStores, s.add.cheapestLocal)}</span>}
                  </div>
                  <div className="actions doctor-actions">
                    {data.canApply && s.cut.entryId !== null && (
                      <button className="btn btn-small btn-primary" disabled={busy !== null} onClick={() => apply(s)}>
                        {busy === `apply:${s.add.oracleId}` ? "Applying…" : "Apply swap"}
                      </button>
                    )}
                    <button className="btn btn-small" disabled={busy !== null} onClick={() => pref("keep", s.cut.oracleId, s.cut.name)}>
                      Keep {s.cut.name.split(",")[0]}
                    </button>
                    <button className="btn btn-small" disabled={busy !== null} onClick={() => pref("dismiss", s.add.oracleId, s.add.name)}>
                      Not interested
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {isOwner(user) && (
            <DoctorAiSection
              kind={kind}
              id={id}
              version={version}
              bracket={bracket ?? data.targetBracket}
              allowHigher={allowHigher}
              canApply={data.canApply}
              busy={busy !== null}
              renderPair={(s) => (
                <div className="doctor-pair">
                  {card(s.add, "+")}
                  {card(s.cut, "−")}
                </div>
              )}
              onApply={applyLine}
              onPref={pref}
            />
          )}
          {(data.keep.length > 0 || data.dismissed.length > 0) && (
            <details className="doctor-prefs">
              <summary className="small">
                {data.keep.length} kept · {data.dismissed.length} dismissed
              </summary>
              <ul className="small">
                {data.keep.map((k) => (
                  <li key={`k-${k.oracleId}`}>
                    Keep {k.name}{" "}
                    <button className="btn btn-small" onClick={() => pref("keep", k.oracleId, k.name, true)}>
                      Undo
                    </button>
                  </li>
                ))}
                {data.dismissed.map((d) => (
                  <li key={`d-${d.oracleId}`}>
                    Not interested in {d.name}{" "}
                    <button className="btn btn-small" onClick={() => pref("dismiss", d.oracleId, d.name, true)}>
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="small muted doctor-credit">
            {data.edhrec.url ? (
              <a href={data.edhrec.url} target="_blank" rel="noopener noreferrer">
                Synergy data from EDHREC
              </a>
            ) : (
              "Synergy data from EDHREC"
            )}
            {data.edhrec.page ? ` (${data.edhrec.page} decks)` : ""} ·{" "}
            <a href="https://commanderspellbook.com" target="_blank" rel="noopener noreferrer">
              Combos by Commander Spellbook
            </a>
            . Suggestions are a starting point, not a rule: synergy measures how often decks with this commander play a card, not how good it is in yours.
          </p>
        </>
      )}
      {hover.preview}
      {open && <CardDetail id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
