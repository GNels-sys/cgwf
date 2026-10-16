import { useEffect, useState, type ReactNode } from "react";

/** Bottom action sheet, number/text prompts and a pick list: the primary way to act on the table. */

export interface Action {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Secondary text under the label. */
  hint?: string | undefined;
}

export function ActionSheet({ title, subtitle, actions, onClose, children }: { title: string; subtitle?: string | undefined; actions: Action[]; onClose: () => void; children?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>{title}</strong>
          {subtitle && <span className="muted small">{subtitle}</span>}
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {children}
        <div className="sheet-actions">
          {actions.map((a) => (
            <button
              key={a.label}
              className={`sheet-action${a.danger ? " is-danger" : ""}`}
              disabled={a.disabled}
              onClick={() => {
                a.run();
              }}
            >
              <span>{a.label}</span>
              {a.hint && <small className="muted">{a.hint}</small>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export type Dialog =
  | { kind: "number"; title: string; initial: number; min?: number; max?: number; submitLabel?: string; onSubmit: (n: number) => void; quick?: number[] }
  | { kind: "text"; title: string; placeholder?: string; initial?: string; onSubmit: (s: string) => void }
  | { kind: "pick"; title: string; options: Array<{ label: string; value: string; hint?: string }>; onPick: (value: string) => void }
  | { kind: "confirm"; title: string; body?: string | undefined; confirmLabel?: string; danger?: boolean; onConfirm: () => void };

export function DialogView({ dialog, onClose }: { dialog: Dialog; onClose: () => void }) {
  const [num, setNum] = useState(dialog.kind === "number" ? String(dialog.initial) : "");
  const [text, setText] = useState(dialog.kind === "text" ? (dialog.initial ?? "") : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submitNumber = (v: number) => {
    if (dialog.kind !== "number") return;
    const n = Math.trunc(v);
    if (!Number.isFinite(n)) return;
    if (dialog.min !== undefined && n < dialog.min) return;
    if (dialog.max !== undefined && n > dialog.max) return;
    dialog.onSubmit(n);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dialog" role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(e) => e.stopPropagation()}>
        <h3>{dialog.title}</h3>
        {dialog.kind === "number" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitNumber(Number(num));
            }}
          >
            {dialog.quick && (
              <div className="quick-row">
                {dialog.quick.map((q) => (
                  <button key={q} type="button" className="chip" onClick={() => submitNumber(q)}>
                    {q > 0 ? `+${q}` : q}
                  </button>
                ))}
              </div>
            )}
            <div className="inline-field">
              <input type="number" inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} min={dialog.min} max={dialog.max} autoFocus />
              <button className="btn btn-primary" type="submit">
                {dialog.submitLabel ?? "OK"}
              </button>
            </div>
          </form>
        )}
        {dialog.kind === "text" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) {
                dialog.onSubmit(text.trim());
                onClose();
              }
            }}
          >
            <div className="inline-field">
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder={dialog.placeholder} maxLength={40} autoFocus />
              <button className="btn btn-primary" type="submit">
                OK
              </button>
            </div>
          </form>
        )}
        {dialog.kind === "pick" && (
          <div className="sheet-actions">
            {dialog.options.length === 0 && <p className="muted">Nothing to pick.</p>}
            {dialog.options.map((o) => (
              <button
                key={o.value}
                className="sheet-action"
                onClick={() => {
                  dialog.onPick(o.value);
                  onClose();
                }}
              >
                <span>{o.label}</span>
                {o.hint && <small className="muted">{o.hint}</small>}
              </button>
            ))}
          </div>
        )}
        {dialog.kind === "confirm" && (
          <>
            {dialog.body && <p>{dialog.body}</p>}
            <div className="actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className={`btn ${dialog.danger ? "btn-danger" : "btn-primary"}`}
                onClick={() => {
                  dialog.onConfirm();
                  onClose();
                }}
              >
                {dialog.confirmLabel ?? "Yes"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
