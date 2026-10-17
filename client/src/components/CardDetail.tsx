import { useEffect, useRef, useState } from "react";
import { hasBackFace, type CardPrinting } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "./CardImage";
import { AvailabilityPanel, PurchaseLinks } from "./LocalStores";
import { ManaCost, OracleText } from "./ManaCost";

/** Full-screen card view: large image (both faces for two-faced cards) plus oracle text. */
interface CardNavigation {
  position: number;
  total: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}

export function CardDetail({ id, onClose, navigation }: { id: string; onClose: () => void; navigation?: CardNavigation }) {
  const [card, setCard] = useState<CardPrinting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [face, setFace] = useState<0 | 1>(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setCard(null);
    setError(null);
    setFace(0);
    api
      .card(id, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setCard(r.card); })
      .catch((e: Error) => {
        if (!ctl.signal.aborted && e.name !== "AbortError") setError(e.message);
      });
    return () => ctl.abort();
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (!navigation || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (e.key === "ArrowLeft") navigation.onPrevious?.();
        else navigation.onNext?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, navigation]);

  useEffect(() => {
    // Start each new card at the top without replacing the focused arrow button.
    panel.current?.scrollTo({ top: 0 });
  }, [id]);

  const twoFaced = card ? hasBackFace(card.layout) : false;
  const shownFace = card?.faces[face] ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={card?.name ?? "Card"}>
      <div ref={panel} className="modal card-detail" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
        {navigation && <nav className="card-detail-nav" aria-label="Browse deck cards">
          <button className="btn" type="button" aria-label="Previous card" title="Previous card (Left arrow)" disabled={!navigation.onPrevious} onClick={() => navigation.onPrevious?.()}>
            <span aria-hidden="true">←</span>
          </button>
          <span className="muted small" aria-live="polite" aria-atomic="true">Card {navigation.position} of {navigation.total}</span>
          <button className="btn" type="button" aria-label="Next card" title="Next card (Right arrow)" disabled={!navigation.onNext} onClick={() => navigation.onNext?.()}>
            <span aria-hidden="true">→</span>
          </button>
        </nav>}
        {error && <p className="error">{error}</p>}
        {!card && !error && <p className="muted card-detail-loading" role="status">Loading card…</p>}
        {card && (
          <>
            <div className="card-detail-image">
              <CardImage key={`${card.id}:${face}`} id={card.id} name={card.name} size="large" face={face} loading="eager" />
              {twoFaced && (
                <button className="btn" onClick={() => setFace(face === 0 ? 1 : 0)}>
                  {face === 0 ? "Show back" : "Show front"}
                </button>
              )}
            </div>
            <div className="card-detail-text">
              {card.faces.length > 1 ? (
                card.faces.map((f, i) => (
                  <section key={i} className={`card-face${twoFaced && i !== face ? " is-dim" : ""}`}>
                    <h2>
                      {f.name} <ManaCost cost={f.manaCost} size={16} />
                    </h2>
                    <p className="type-line">{f.typeLine}</p>
                    <OracleText text={f.oracleText} />
                    {(f.power || f.loyalty || f.defense) && (
                      <p className="stats">
                        {f.power && `${f.power}/${f.toughness}`}
                        {f.loyalty && `Loyalty ${f.loyalty}`}
                        {f.defense && `Defense ${f.defense}`}
                      </p>
                    )}
                  </section>
                ))
              ) : (
                <section className="card-face">
                  <h2>
                    {card.name} <ManaCost cost={card.manaCost} size={16} />
                  </h2>
                  <p className="type-line">{card.typeLine}</p>
                  <OracleText text={card.oracleText} />
                  {(card.power || card.loyalty || card.defense) && (
                    <p className="stats">
                      {card.power && `${card.power}/${card.toughness}`}
                      {card.loyalty && `Loyalty ${card.loyalty}`}
                      {card.defense && `Defense ${card.defense}`}
                    </p>
                  )}
                </section>
              )}
              <p className="muted small">
                {card.setName} ({card.set.toUpperCase()}) #{card.collectorNumber} &middot; {card.rarity}
                {shownFace?.artist || card.artist ? <> &middot; Illustrated by {shownFace?.artist ?? card.artist}</> : null}
              </p>
              {card.keywords.length > 0 && <p className="muted small">Keywords: {card.keywords.join(", ")}</p>}
              <p className="muted small">
                <a href={card.scryfallUri} target="_blank" rel="noreferrer">
                  View on Scryfall
                </a>
              </p>
              <AvailabilityPanel cardId={card.id} />
              <PurchaseLinks links={card.purchaseUris} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
