import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineAnswer, EngineOption, EnginePrompt, PlayerView } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { CardTile } from "./CardTile";
import { findCard, nameOf, type Printings } from "./model";

/**
 * Rules-engine prompts that need a small sheet rather than a tap on the table: yes/no questions
 * with the card shown (optional costs, "you may" triggers), numbers (X), ordering (scry, surveil,
 * trigger order), splitting damage, modal spells and free-text card names. The engine decides
 * what is legal; these sheets only collect an answer in the shape the engine asked for.
 */

export const SHEET_PROMPT_KINDS: ReadonlySet<EnginePrompt["kind"]> = new Set<EnginePrompt["kind"]>(["confirm", "number", "order", "assign", "mode", "text"]);

/** Title and hint for any option (cards, players, spells on the stack, plain text). */
export function describeOption(o: EngineOption, view: PlayerView): { title: string; hint?: string } {
  if (o.kind === "player") return { title: view.players[o.player]?.name ?? o.name };
  if (o.kind === "text") return { title: o.label };
  if (o.kind === "spell") return { title: o.label, hint: "on the stack" };
  const bits = [o.zone, o.controller ? view.players[o.controller]?.name : null, o.power !== null ? `${o.power}/${o.toughness}` : null].filter(Boolean);
  return { title: o.name, hint: bits.join(" - ") };
}

/** A small picture of an option: the table tile when the card is on the table, else the printing's image, else nothing. */
function OptionArt({ o, view, printings, onZoom }: { o: EngineOption; view: PlayerView; printings: Printings; onZoom: (c: NonNullable<ReturnType<typeof findCard>>) => void }) {
  if (o.kind !== "card") return null;
  const onTable = findCard(view, o.iid);
  if (onTable) return <CardTile card={onTable} printings={printings} onHold={onZoom} />;
  if (o.printingId) return <CardImage id={o.printingId} name={o.name} size="small" className="engine-row-img" />;
  return null;
}

function Sheet({ title, subtitle, onClose, children, label }: { title: string; subtitle?: string | null | undefined; onClose: () => void; children: React.ReactNode; label?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet engine-sheet" role="dialog" aria-modal="true" aria-label={label ?? title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>{title}</strong>
          {subtitle && <span className="muted small">{subtitle}</span>}
          <button className="sheet-close" onClick={onClose} aria-label="Close (the question stays open)">
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface EnginePromptSheetProps {
  prompt: EnginePrompt;
  view: PlayerView;
  printings: Printings;
  answer: (a: EngineAnswer) => void;
  onClose: () => void;
  onZoom: (c: NonNullable<ReturnType<typeof findCard>>) => void;
}

export function EnginePromptSheet(props: EnginePromptSheetProps) {
  const { prompt } = props;
  switch (prompt.kind) {
    case "confirm":
      return <ConfirmSheet {...props} prompt={prompt} />;
    case "number":
      return <NumberSheet {...props} prompt={prompt} />;
    case "order":
      return <OrderSheet {...props} prompt={prompt} />;
    case "assign":
      return <AssignSheet {...props} prompt={prompt} />;
    case "mode":
      return <ModeSheet {...props} prompt={prompt} />;
    case "text":
      return <TextSheet {...props} prompt={prompt} />;
    default:
      return null;
  }
}

/** One answer per prompt: after sending, the buttons go quiet until the engine moves on. */
function useOnce(promptId: number, answer: (a: EngineAnswer) => void) {
  const [sent, setSent] = useState(false);
  useEffect(() => setSent(false), [promptId]);
  return {
    sent,
    send: (a: EngineAnswer) => {
      if (sent) return;
      setSent(true);
      answer(a);
    },
  };
}

// ---------------------------------------------------------------- confirm

function ConfirmSheet({ prompt, view, printings, answer, onClose }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "confirm" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const card = prompt.card;
  const onTable = card ? findCard(view, card.iid) : null;
  const name = onTable ? nameOf(onTable, printings) : card?.name;
  return (
    <Sheet title={prompt.source ?? "Question"} onClose={onClose} label={prompt.title}>
      <div className="engine-confirm">
        {card && (card.printingId ? <CardImage id={card.printingId} name={name ?? card.name} size="normal" className="engine-confirm-img" loading="eager" /> : <div className="engine-confirm-noimg">{name}</div>)}
        <div className="engine-confirm-text">
          <h2>{prompt.title}</h2>
          {prompt.detail && <p className="muted">{prompt.detail}</p>}
          <div className="actions">
            <button className="btn" disabled={sent} onClick={() => send({ promptId: prompt.promptId, confirm: false })}>
              {prompt.options[1] ?? "No"}
            </button>
            <button className="btn btn-primary" disabled={sent} onClick={() => send({ promptId: prompt.promptId, confirm: true })}>
              {prompt.options[0] ?? "Yes"}
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- number

function NumberSheet({ prompt, answer, onClose }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "number" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const values = prompt.values && prompt.values.length ? prompt.values : null;
  const min = values ? Math.min(...values) : prompt.min;
  const max = values ? Math.max(...values) : Math.min(prompt.max, 999);
  const [value, setValue] = useState<number>(values ? values[0]! : prompt.min);
  useEffect(() => setValue(values ? values[0]! : prompt.min), [prompt.promptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const legal = values ? values.includes(value) : value >= min && value <= max;
  const step = (d: number) => {
    if (values) {
      const i = values.indexOf(value);
      const next = values[Math.max(0, Math.min(values.length - 1, (i < 0 ? 0 : i) + d))];
      if (next !== undefined) setValue(next);
    } else setValue((v) => Math.max(min, Math.min(max, v + d)));
  };
  const quick = values ?? Array.from(new Set([min, Math.round((min + max) / 2), max].filter((n) => n >= min && n <= max)));
  return (
    <Sheet title={prompt.title} subtitle={prompt.source} onClose={onClose}>
      <div className="engine-stepper">
        <button className="btn" aria-label="Less" onClick={() => step(-1)} disabled={value <= min}>
          -
        </button>
        <input type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => setValue(Number(e.target.value))} aria-label={prompt.title} />
        <button className="btn" aria-label="More" onClick={() => step(1)} disabled={value >= max}>
          +
        </button>
      </div>
      <p className="muted small" style={{ textAlign: "center", margin: "6px 0 0" }}>
        {values ? `One of ${values.join(", ")}` : `Between ${min} and ${max}`}
      </p>
      <div className="engine-quick">
        {quick.map((n) => (
          <button key={n} className={`chip${n === value ? " is-selected" : ""}`} onClick={() => setValue(n)}>
            {n}
          </button>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" disabled={!legal || sent} onClick={() => send({ promptId: prompt.promptId, value })}>
          Choose {Number.isFinite(value) ? value : ""}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- mode

function ModeSheet({ prompt, answer, onClose }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "mode" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const [picks, setPicks] = useState<number[]>([]);
  useEffect(() => setPicks([]), [prompt.promptId]);
  const toggle = (i: number) => {
    setPicks((p) => {
      if (prompt.allowRepeat) return p.length < prompt.max ? [...p, i] : p;
      if (p.includes(i)) return p.filter((x) => x !== i);
      if (prompt.max === 1) return [i];
      return p.length < prompt.max ? [...p, i] : p;
    });
  };
  const count = (i: number) => picks.filter((x) => x === i).length;
  const ok = picks.length >= prompt.min && picks.length <= prompt.max;
  return (
    <Sheet title={prompt.title} subtitle={prompt.min === prompt.max ? `Choose ${prompt.max}` : `Choose ${prompt.min} to ${prompt.max}`} onClose={onClose}>
      <div className="engine-rows">
        {prompt.modes.map((m, i) => (
          <button key={m.index} className={`engine-row engine-mode${count(m.index) ? " is-selected" : ""}`} onClick={() => toggle(m.index)} aria-pressed={count(m.index) > 0}>
            <span className="engine-row-text">
              <span>{m.text || `Mode ${i + 1}`}</span>
            </span>
            {count(m.index) > 0 && <span className="combat-chip-count">{prompt.allowRepeat ? `x${count(m.index)}` : "✓"}</span>}
          </button>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 10 }}>
        {prompt.allowRepeat && picks.length > 0 && (
          <button className="btn" onClick={() => setPicks([])}>
            Clear
          </button>
        )}
        <button className="btn btn-primary" disabled={!ok || sent} onClick={() => send({ promptId: prompt.promptId, modes: picks })}>
          Confirm{picks.length ? ` (${picks.length})` : ""}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- order (scry, surveil, put back in any order, trigger order)

const BUCKET_LABEL: Record<string, string> = { top: "Top", bottom: "Bottom", graveyard: "Graveyard" };

function OrderSheet({ prompt, view, printings, answer, onClose, onZoom }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "order" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const [order, setOrder] = useState<number[]>(() => prompt.items.map((o) => o.index));
  const [buckets, setBuckets] = useState<Record<number, string>>({});
  useEffect(() => {
    setOrder(prompt.items.map((o) => o.index));
    setBuckets({});
  }, [prompt.promptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const byIndex = useMemo(() => new Map(prompt.items.map((o) => [o.index, o])), [prompt.items]);
  const move = (i: number, d: number) => {
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };
  const defaultBucket = prompt.defaultBucket ?? prompt.buckets?.[0] ?? null;
  const bucketOf = (idx: number) => buckets[idx] ?? defaultBucket;
  // Items in the default bucket (the ones whose order matters) first, then the rest, for a readable list.
  const kept = order.filter((i) => !prompt.buckets || bucketOf(i) === defaultBucket);
  const sent2 = order.filter((i) => prompt.buckets && bucketOf(i) !== defaultBucket);
  const rows = [...kept, ...sent2];
  return (
    <Sheet title={prompt.title} subtitle={prompt.note} onClose={onClose}>
      <div className="engine-rows">
        {rows.map((idx, pos) => {
          const o = byIndex.get(idx);
          if (!o) return null;
          const { title, hint } = describeOption(o, view);
          const inDefault = !prompt.buckets || bucketOf(idx) === defaultBucket;
          const keptPos = kept.indexOf(idx);
          return (
            <div key={idx} className={`engine-row${inDefault ? "" : " is-dim"}`}>
              <OptionArt o={o} view={view} printings={printings} onZoom={onZoom} />
              <span className="engine-row-text">
                <span>
                  {inDefault && kept.length > 1 && <strong className="engine-pos">{keptPos + 1}. </strong>}
                  {title}
                </span>
                {hint && <small>{hint}</small>}
              </span>
              {prompt.buckets && (
                <span className="engine-seg" role="group" aria-label={`Where ${title} goes`}>
                  {prompt.buckets.map((b) => (
                    <button key={b} className={bucketOf(idx) === b ? "is-on" : ""} onClick={() => setBuckets((m) => ({ ...m, [idx]: b }))} aria-pressed={bucketOf(idx) === b}>
                      {BUCKET_LABEL[b] ?? b}
                    </button>
                  ))}
                </span>
              )}
              {inDefault && kept.length > 1 && (
                <span className="engine-row-ctl">
                  <button className="btn" aria-label="Move up" disabled={keptPos <= 0} onClick={() => move(order.indexOf(idx), -1)}>
                    ▲
                  </button>
                  <button className="btn" aria-label="Move down" disabled={keptPos >= kept.length - 1 || pos >= rows.length - 1} onClick={() => move(order.indexOf(idx), 1)}>
                    ▼
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="actions" style={{ marginTop: 10 }}>
        <button
          className="btn btn-primary"
          disabled={sent}
          onClick={() => {
            const b: Record<string, string> = {};
            for (const [k, v] of Object.entries(buckets)) b[k] = v;
            send({ promptId: prompt.promptId, order, buckets: b });
          }}
        >
          Done
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- assign (combat damage, divided damage)

function AssignSheet({ prompt, view, printings, answer, onClose, onZoom }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "assign" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const lethalFirst = (): number[] => {
    let left = prompt.total;
    const out = prompt.targets.map((t) => {
      const l = prompt.lethal[t.index];
      const give = l === undefined ? 0 : Math.min(left, l);
      left -= give;
      return give;
    });
    if (out.length) out[out.length - 1]! += left; // whatever is left goes to the last target (the player, with trample)
    return out;
  };
  const [amounts, setAmounts] = useState<number[]>(lethalFirst);
  useEffect(() => setAmounts(lethalFirst()), [prompt.promptId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = amounts.reduce((a, b) => a + b, 0);
  const left = prompt.total - sum;
  const bump = (i: number, d: number) =>
    setAmounts((a) => {
      const next = [...a];
      next[i] = Math.max(0, (next[i] ?? 0) + d);
      return next;
    });
  const sourceCard = prompt.card ? findCard(view, prompt.card.iid) : null;
  return (
    <Sheet title={prompt.title} subtitle={`${prompt.total} to assign`} onClose={onClose}>
      {sourceCard && (
        <div className="engine-row" style={{ marginBottom: 8 }}>
          <CardTile card={sourceCard} printings={printings} onHold={onZoom} />
          <span className="engine-row-text">
            <span>{nameOf(sourceCard, printings)}</span>
            <small>deals {prompt.total}</small>
          </span>
        </div>
      )}
      <div className="engine-rows">
        {prompt.targets.map((t, i) => {
          const { title, hint } = describeOption(t, view);
          const lethal = prompt.lethal[t.index];
          return (
            <div key={t.index} className="engine-row">
              <OptionArt o={t} view={view} printings={printings} onZoom={onZoom} />
              <span className="engine-row-text">
                <span>{title}</span>
                <small>{[hint, lethal !== undefined ? `lethal ${lethal}` : null].filter(Boolean).join(" - ")}</small>
              </span>
              <span className="engine-row-ctl">
                <button className="btn" aria-label={`Less to ${title}`} disabled={(amounts[i] ?? 0) <= 0} onClick={() => bump(i, -1)}>
                  -
                </button>
                <span className="engine-amount" aria-live="polite">
                  {amounts[i] ?? 0}
                </span>
                <button className="btn" aria-label={`More to ${title}`} disabled={left <= 0} onClick={() => bump(i, 1)}>
                  +
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className={`engine-remaining${left === 0 ? " muted" : ""}`}>{left === 0 ? "All assigned." : left > 0 ? `${left} left to assign` : `${-left} too many`}</p>
      <div className="actions">
        <button className="btn" onClick={() => setAmounts(lethalFirst())}>
          Lethal first
        </button>
        <button className="btn btn-primary" disabled={left !== 0 || sent} onClick={() => send({ promptId: prompt.promptId, amounts })}>
          Assign
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- text (name a card)

function TextSheet({ prompt, answer, onClose }: EnginePromptSheetProps & { prompt: Extract<EnginePrompt, { kind: "text" }> }) {
  const { sent, send } = useOnce(prompt.promptId, answer);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    setText("");
    setSuggestions([]);
  }, [prompt.promptId]);
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    const ctl = new AbortController();
    timer.current = window.setTimeout(() => {
      api
        .search(q, false, ctl.signal)
        .then((r) => setSuggestions(Array.from(new Set(r.results.map((c) => c.name))).slice(0, 8)))
        .catch(() => undefined);
    }, 200);
    return () => {
      ctl.abort();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [text]);
  const submit = () => {
    const t = text.trim();
    if (t) send({ promptId: prompt.promptId, text: t });
  };
  return (
    <Sheet title={prompt.title} subtitle={prompt.hint ?? prompt.source} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Card name" aria-label={prompt.title} autoComplete="off" />
        {suggestions.length > 0 && (
          <div className="engine-suggest">
            {suggestions.map((s) => (
              <button type="button" key={s} className={`engine-row${s === text ? " is-selected" : ""}`} onClick={() => setText(s)}>
                <span className="engine-row-text">
                  <span>{s}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn btn-primary" type="submit" disabled={!text.trim() || sent}>
            Name it
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** For the bar: a one-line summary of a sheet-shaped prompt. */
export function sheetPromptSummary(prompt: EnginePrompt): { head: string; hint: string } {
  switch (prompt.kind) {
    case "confirm":
      return { head: prompt.title, hint: prompt.detail ?? prompt.source ?? "" };
    case "number":
      return { head: prompt.title, hint: prompt.values ? `one of ${prompt.values.join(", ")}` : `${prompt.min} to ${prompt.max}` };
    case "order":
      return { head: prompt.title, hint: prompt.note ?? "" };
    case "assign":
      return { head: prompt.title, hint: `${prompt.total} to split among ${prompt.targets.length}` };
    case "mode":
      return { head: prompt.title, hint: `${prompt.modes.length} modes` };
    case "text":
      return { head: prompt.title, hint: prompt.hint ?? "" };
    default:
      return { head: prompt.title, hint: "" };
  }
}

