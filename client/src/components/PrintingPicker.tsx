import { useEffect, useMemo, useRef, useState } from "react";
import type { PrintingOption, PrintingsResponse } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "./CardImage";

/** A printing's short label, e.g. "FRC 20": shown on deck lines and in the picker. */
export function printingLabel(p: { set: string; collectorNumber: string }): string {
  return `${p.set.toUpperCase()} ${p.collectorNumber}`;
}

/** Text the filter box matches: set name and code, number, year, rarity and treatments. */
export function printingSearchText(p: PrintingOption): string {
  return [p.setName, p.set, p.collectorNumber, p.releasedAt.slice(0, 4), p.rarity, ...p.treatments, p.isRegular ? "regular" : ""].join(" ").toLowerCase();
}

const FILTER_FROM = 12;

/**
 * "Change printing": every paper printing of one card, newest first, as a thumbnail grid. The printing
 * in the deck is marked, so is the default (what the bare name resolves to). Picking one calls
 * `onPick` (the PATCH for that deck line) and closes.
 */
export function PrintingPicker({
  oracleId,
  cardName,
  currentId,
  onPick,
  onClose,
}: {
  oracleId: string;
  cardName: string;
  currentId: string;
  onPick: (cardId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [data, setData] = useState<PrintingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .printings(oracleId, ctl.signal)
      .then((r) => {
        if (!ctl.signal.aborted) setData(r);
      })
      .catch((e: Error) => {
        if (!ctl.signal.aborted && e.name !== "AbortError") setError(e.message);
      });
    return () => ctl.abort();
  }, [oracleId]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(() => {
    const list = data?.printings ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    const words = needle.split(/\s+/);
    return list.filter((p) => {
      const text = printingSearchText(p);
      return words.every((w) => text.includes(w));
    });
  }, [data, q]);

  const choose = async (id: string) => {
    if (id === currentId) {
      onClose();
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await onPick(id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const defaultId = data?.defaultId ?? null;
  const total = data?.printings.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Change the printing of ${cardName}`}>
      <div className="modal printing-picker" onClick={(e) => e.stopPropagation()}>
        <button ref={closeRef} className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
        <p className="eyebrow">Change printing</p>
        <h2>{cardName}</h2>
        {!data && !error && (
          <p className="muted" role="status">
            Loading printings…
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {data && (
          <>
            <p className="muted small">
              {total} {total === 1 ? "printing" : "printings"}, newest first. Only this line changes; the card itself stays the same. "Default" is what the plain card name gets when a list is imported.
            </p>
            <div className="printing-picker-tools">
              {total > FILTER_FROM && (
                <input type="search" className="printing-filter" placeholder="Filter: set, number, year, borderless…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter printings" />
              )}
              {defaultId && defaultId !== currentId && (
                <button className="btn btn-small" disabled={busy !== null} onClick={() => void choose(defaultId)}>
                  Reset to default printing
                </button>
              )}
            </div>
            {shown.length === 0 && <p className="muted small">No printing matches "{q}".</p>}
            <ul className="printing-grid">
              {shown.map((p) => {
                const current = p.id === currentId;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`printing-tile${current ? " is-current" : ""}`}
                      aria-pressed={current}
                      disabled={busy !== null}
                      onClick={() => void choose(p.id)}
                      title={current ? "In the deck now" : `Use ${p.setName} #${p.collectorNumber}`}
                    >
                      <CardImage id={p.id} name={p.name} size="small" />
                      <span className="printing-set">{p.setName}</span>
                      <span className="printing-meta">
                        {printingLabel(p)} · {p.releasedAt.slice(0, 4)} · {p.rarity}
                      </span>
                      <span className="printing-tags">
                        {current && <span className="chip tag-chip small is-current">In deck</span>}
                        {p.id === defaultId && <span className="chip tag-chip small is-default">Default</span>}
                        {p.treatments.length === 0 ? <span className="chip tag-chip small">Regular</span> : p.treatments.map((t) => <span key={t} className="chip tag-chip small is-treatment">{t}</span>)}
                      </span>
                      {busy === p.id && <span className="small muted">Saving…</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
