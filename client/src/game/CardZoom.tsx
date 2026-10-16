import { useEffect, useState } from "react";
import { hasBackFace, type ViewCard } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";
import { ManaCost, OracleText } from "../components/ManaCost";
import { imageFace, nameOf, printingOf, type Printings } from "./model";

/** Big view of one card from the data we already have (no API round trip). */
export function CardZoom({ card, printings, onClose }: { card: ViewCard; printings: Printings; onClose: () => void }) {
  const printing = printingOf(card, printings);
  const [face, setFace] = useState<0 | 1>(imageFace(card, printing));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const twoFaced = printing ? hasBackFace(printing.layout) : false;
  const faces = printing?.faces.length ? printing.faces : printing ? [{ name: printing.name, manaCost: printing.manaCost, typeLine: printing.typeLine, oracleText: printing.oracleText, power: printing.power, toughness: printing.toughness, loyalty: printing.loyalty, defense: printing.defense }] : [];

  return (
    <div className="modal-backdrop zoom-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={nameOf(card, printings)}>
      <div className="zoom" onClick={(e) => e.stopPropagation()}>
        <div className="zoom-image">
          {printing ? (
            <CardImage id={printing.id} name={printing.name} size="normal" face={face} loading="eager" />
          ) : (
            <div className="tile-back is-custom zoom-custom">
              <strong>{card.custom?.name ?? "Face-down card"}</strong>
              {card.custom && (
                <>
                  <span>{card.custom.typeLine}</span>
                  {card.custom.text && <p>{card.custom.text}</p>}
                  {card.custom.power && (
                    <em>
                      {card.custom.power}/{card.custom.toughness}
                    </em>
                  )}
                </>
              )}
            </div>
          )}
          {twoFaced && (
            <button className="btn btn-small" onClick={() => setFace(face === 0 ? 1 : 0)}>
              {face === 0 ? "Show back" : "Show front"}
            </button>
          )}
        </div>
        {printing && (
          <div className="zoom-text">
            {faces.map((f, i) => (
              <section key={i} className={`card-face${twoFaced && i !== face ? " is-dim" : ""}`}>
                <h2>
                  {f.name} <ManaCost cost={f.manaCost} size={14} />
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
            ))}
            {Object.keys(card.counters).length > 0 && (
              <p className="muted small">
                Counters:{" "}
                {Object.entries(card.counters)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(", ")}
              </p>
            )}
          </div>
        )}
        <button className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
    </div>
  );
}
