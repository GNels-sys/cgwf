import { useEffect, useState } from "react";
import { hasBackFace, type PlayerView, type ViewCard } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";
import { ManaCost, OracleText } from "../components/ManaCost";
import type { SleeveStyle } from "./look";
import { imageFace, nameOf, printingOf, type Printings } from "./model";

/**
 * Big view of one card from the data we already have (no API round trip):
 * full image, oracle text for every face, counters and where it sits.
 */
export function CardZoom({ card, printings, view, sleeve, onClose }: { card: ViewCard; printings: Printings; view?: PlayerView; sleeve?: SleeveStyle | undefined; onClose: () => void }) {
  const printing = printingOf(card, printings);
  const [face, setFace] = useState<0 | 1>(imageFace(card, printing));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const twoFaced = printing ? hasBackFace(printing.layout) : false;
  const faces = printing?.faces.length ? printing.faces : printing ? [{ name: printing.name, manaCost: printing.manaCost, typeLine: printing.typeLine, oracleText: printing.oracleText, power: printing.power, toughness: printing.toughness, loyalty: printing.loyalty, defense: printing.defense }] : [];
  const owner = view?.players[card.owner]?.name;
  const controller = view?.players[card.zone.owner]?.name;
  const where = `${card.zone.kind === "battlefield" ? `battlefield (${card.zone.row ?? "other"})` : card.zone.kind}${controller ? `, ${controller}` : ""}${owner && owner !== controller ? ` (owned by ${owner})` : ""}`;
  const status = [card.tapped ? "tapped" : null, card.faceDown ? "face down" : null, card.isToken ? "token" : null, card.isCommander ? "commander" : null].filter(Boolean).join(", ");

  return (
    <div className="modal-backdrop zoom-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={nameOf(card, printings)}>
      <div className="zoom" onClick={(e) => e.stopPropagation()}>
        <div className="zoom-image">
          {printing ? (
            <CardImage id={printing.id} name={printing.name} size="normal" face={face} loading="eager" />
          ) : (
            <div className={`tile-back zoom-custom ${card.custom ? "is-custom" : (sleeve?.className ?? "sleeve-classic")}`} style={card.custom ? undefined : sleeve?.style}>
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
        <div className="zoom-text">
          {printing &&
            faces.map((f, i) => (
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
          {!printing && card.custom && (
            <section className="card-face">
              <h2>{card.custom.name}</h2>
              <p className="type-line">{card.custom.typeLine}</p>
              {card.custom.text && <OracleText text={card.custom.text} />}
            </section>
          )}
          <p className="muted small zoom-where">
            In {where}
            {status ? ` - ${status}` : ""}
          </p>
          {Object.keys(card.counters).length > 0 && (
            <p className="muted small">
              Counters:{" "}
              {Object.entries(card.counters)
                .map(([k, v]) => `${v} ${k}`)
                .join(", ")}
            </p>
          )}
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
    </div>
  );
}
