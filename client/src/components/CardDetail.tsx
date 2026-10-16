import { useEffect, useState } from "react";
import { hasBackFace, type CardPrinting } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "./CardImage";
import { ManaCost, OracleText } from "./ManaCost";

/** Full-screen card view: large image (both faces for two-faced cards) plus oracle text. */
export function CardDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [card, setCard] = useState<CardPrinting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [face, setFace] = useState<0 | 1>(0);

  useEffect(() => {
    const ctl = new AbortController();
    setCard(null);
    setFace(0);
    api
      .card(id, ctl.signal)
      .then((r) => setCard(r.card))
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctl.abort();
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const twoFaced = card ? hasBackFace(card.layout) : false;
  const shownFace = card?.faces[face] ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={card?.name ?? "Card"}>
      <div className="modal card-detail" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
        {error && <p className="error">{error}</p>}
        {card && (
          <>
            <div className="card-detail-image">
              <CardImage id={card.id} name={card.name} size="large" face={face} loading="eager" />
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
