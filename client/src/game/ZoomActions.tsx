import type { EnginePlayable, EnginePrompt, ViewCard } from "@cgwf/shared";
import { ManaCost } from "../components/ManaCost";

/** Display only actions supplied for this card by the current priority prompt. */
export function zoomOptions(prompt: EnginePrompt | null, iid: string): EnginePlayable[] {
  return prompt?.kind === "priority" ? prompt.options.filter((option) => option.iid === iid) : [];
}

export function playableHand(hand: ViewCard[], prompt: EnginePrompt | null): ViewCard[] {
  const ids = new Set(prompt?.kind === "priority" ? prompt.options.map((option) => option.iid) : []);
  return hand.filter((card) => ids.has(card.iid) && !card.faceDown);
}

export function ZoomActions({ options, hand = false, onPick }: { options: EnginePlayable[]; hand?: boolean; onPick: (index: number) => void }) {
  return <section className="zoom-decisions" aria-label={hand ? "Play this card" : "Available abilities"}>
    <p className="eyebrow">{hand ? "Your next move" : "Choose an ability"}</p>
    {options.length === 0 ? <>
      <button className="btn btn-primary" disabled>{hand ? "Play now" : "Activate ability"}</button>
      <p className="muted small">{hand ? "This card cannot be played at this moment. The rules engine controls timing and costs." : "No ability is available at this moment."}</p>
    </> : options.map((option) => <button key={option.index} className="zoom-play-option" onClick={() => onPick(option.index)}>
      <span className="zoom-option-verb">{hand ? "Play now" : "Activate"} <span aria-hidden="true">↗</span></span>
      <span>{option.description}</span>
      {option.cost && <span className="zoom-option-cost"><ManaCost cost={option.cost} /> <small>{option.cost}</small></span>}
    </button>)}
  </section>;
}
