import { useEffect } from "react";
import type { CardPrinting, EngineNotice } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";

/** How long a text-only notice ("Blair chose blue") stays before it fades on its own. */
const INFO_MS = 8000;
const SHOWN = 2;

/**
 * Engine tables: what Forge shows this player without asking. Revealed cards (an opponent's hand after
 * Gitaxian Probe, a tutored card, the rest of a dig) stay until dismissed; announced values ("Blair chose
 * blue", a vote, a coin flip) fade after a few seconds. The newest two show; the rest wait behind a count.
 * Tap a card to read it.
 */
export function EngineNotices({ notices, printings, onDismiss, onCard }: {
  notices: EngineNotice[];
  printings: Record<string, CardPrinting>;
  onDismiss: (id: number) => void;
  onCard: (p: CardPrinting) => void;
}) {
  const shown = notices.slice(-SHOWN).reverse();
  const waiting = notices.length - shown.length;
  return (
    <div className="engine-notices" role="status" aria-live="polite">
      {shown.map((n) => (
        <NoticeCard key={n.id} notice={n} printings={printings} onDismiss={onDismiss} onCard={onCard} />
      ))}
      {waiting > 0 && (
        <button className="engine-notice-more" onClick={() => onDismiss(shown[shown.length - 1]!.id)}>
          +{waiting} more
        </button>
      )}
    </div>
  );
}

function NoticeCard({ notice, printings, onDismiss, onCard }: {
  notice: EngineNotice;
  printings: Record<string, CardPrinting>;
  onDismiss: (id: number) => void;
  onCard: (p: CardPrinting) => void;
}) {
  const autoFade = notice.kind === "info" || notice.cards.length === 0;
  useEffect(() => {
    if (!autoFade) return;
    const t = window.setTimeout(() => onDismiss(notice.id), INFO_MS);
    return () => window.clearTimeout(t);
  }, [autoFade, notice.id, onDismiss]);
  const source = notice.source?.printingId ? printings[notice.source.printingId] : undefined;
  return (
    <div className={`engine-notice is-${notice.kind}`}>
      <div className="engine-notice-head">
        <strong className="engine-notice-title">{notice.title || (notice.kind === "reveal" ? "Revealed to you" : "Note")}</strong>
        <button className="engine-notice-close" aria-label="Dismiss" onClick={() => onDismiss(notice.id)}>
          ×
        </button>
      </div>
      {notice.text && (
        <p className="engine-notice-text">
          {source ? (
            <button className="log-card" onClick={() => onCard(source)}>
              {source.name}
            </button>
          ) : null}
          {source ? ": " : null}
          {notice.text}
        </p>
      )}
      {notice.cards.length > 0 && (
        <div className="engine-notice-cards">
          {notice.cards.map((c, i) => {
            const p = c.printingId ? printings[c.printingId] : undefined;
            return p ? (
              <button key={i} className="engine-notice-card" onClick={() => onCard(p)} aria-label={`Read ${c.name}`}>
                <CardImage id={p.id} name={c.name} size="small" loading="eager" />
              </button>
            ) : (
              <span key={i} className="engine-notice-card is-text">{c.name}</span>
            );
          })}
        </div>
      )}
    </div>
  );
}
