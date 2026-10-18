import { useEffect, useState } from "react";
import { hasBackFace, type DerivedCard, type PlayerView, type ViewCard } from "@cgwf/shared";
import { CardImage } from "../components/CardImage";
import { ManaCost, OracleText } from "../components/ManaCost";
import { describeEffect } from "./actions";
import type { SleeveStyle } from "./look";
import { imageFace, nameOf, printingOf, type Printings } from "./model";

/**
 * Big view of one card from the data we already have (no API round trip):
 * full image, oracle text for every face, where it sits and its status. On the
 * battlefield it also shows the derived P/T, keywords, attachments and every
 * granted effect, so "why is this a 6/4?" has an answer.
 */
/** Phones get the 488 px image (plenty for a card that fits the screen); larger screens the 672 px one. */
function bigScreen(): boolean {
  return typeof window !== "undefined" && Math.min(window.innerWidth, window.innerHeight) > 700;
}

export function CardZoom({
  card,
  printings,
  view,
  sleeve,
  derived,
  attachments = [],
  onClose,
}: {
  card: ViewCard;
  printings: Printings;
  view?: PlayerView;
  sleeve?: SleeveStyle | undefined;
  derived?: DerivedCard | undefined;
  attachments?: ViewCard[];
  onClose: () => void;
}) {
  const printing = printingOf(card, printings);
  const [face, setFace] = useState<0 | 1>(imageFace(card, printing));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const twoFaced = printing ? hasBackFace(printing.layout) : false;
  const faces = printing?.faces.length ? printing.faces : printing ? [{ name: printing.name, manaCost: printing.manaCost, typeLine: printing.typeLine, oracleText: printing.oracleText, power: printing.power, toughness: printing.toughness, loyalty: printing.loyalty, defense: printing.defense }] : [];
  const counters = Object.entries(card.counters);
  const owner = view?.players[card.owner]?.name;
  const controller = view?.players[card.zone.owner]?.name;
  const where = card.iid.startsWith("printing:") ? "named in the game log" : card.iid.startsWith("stack:") ? "on the stack" : `${card.zone.kind === "battlefield" ? `battlefield (${card.zone.row ?? "other"})` : card.zone.kind}${controller ? `, ${controller}` : ""}${owner && owner !== controller ? ` (owned by ${owner})` : ""}`;
  const status = [card.tapped ? "tapped" : null, card.faceDown ? "face down" : null, card.isToken ? "token" : null, card.isCommander ? "commander" : null].filter(Boolean).join(", ");

  return (
    <div className="modal-backdrop zoom-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={nameOf(card, printings)}>
      <div className="zoom" onClick={(e) => e.stopPropagation()}>
        <div className="zoom-image">
          {printing ? (
            <CardImage id={printing.id} name={printing.name} size={bigScreen() ? "large" : "normal"} face={face} loading="eager" />
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
          {derived && card.zone.kind === "battlefield" && (
            <section className="zoom-now">
              {derived.isCreature && derived.power !== null && (
                <p className="zoom-pt">
                  <strong>
                    {derived.power}/{derived.toughness}
                  </strong>
                  {(derived.deltaPower || derived.deltaToughness) && derived.basePower !== null ? (
                    <span className="muted small">
                      {" "}
                      printed {derived.basePower}/{derived.baseToughness}
                    </span>
                  ) : null}
                </p>
              )}
              {derived.keywords.length > 0 && (
                <p className="zoom-keywords">
                  {derived.keywords.map((k) => (
                    <span key={k} className="chip is-selected">
                      {k}
                    </span>
                  ))}
                </p>
              )}
              {attachments.length > 0 && (
                <p className="small">
                  Attached: {attachments.map((a) => `${nameOf(a, printings)}${a.effect ? ` (${describeEffect(a.effect)})` : ""}`).join(", ")}
                </p>
              )}
              {derived.effects.length > 0 && (
                <ul className="zoom-effects small">
                  {derived.effects.map((e, i) => (
                    <li key={`${e.source}-${i}`}>
                      <span className="muted">{e.label}:</span> {describeEffect(e)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
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
          {counters.length > 0 && (
            <p className="muted small">Counters: {counters.map(([k, v]) => `${v} ${k}`).join(", ")}</p>
          )}
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>
    </div>
  );
}
