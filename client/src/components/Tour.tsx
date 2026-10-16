import { useState } from "react";
import { Link } from "react-router-dom";
import { TOUR_STEPS, shouldShowTour } from "@cgwf/shared";
import { getTourState, setTourState } from "../tour";
import { useUser } from "../user";

/**
 * Three-step tour shown once after the first profile is created. Dismissing it
 * (Skip, Done, or the X) writes "done" and it never returns on this device.
 */
export function Tour() {
  const { user } = useUser();
  const [state, setState] = useState(getTourState());
  const [step, setStep] = useState(0);
  if (!shouldShowTour(state, Boolean(user))) return null;
  const dismiss = () => {
    setTourState("done");
    setState("done");
  };
  const s = TOUR_STEPS[step]!;
  const last = step === TOUR_STEPS.length - 1;
  return (
    <section className="tour" aria-label="Getting started">
      <div className="row-between">
        <strong>
          Welcome, {user?.displayName}. Step {step + 1} of {TOUR_STEPS.length}
        </strong>
        <button className="btn btn-small" onClick={dismiss} aria-label="Dismiss the tour">
          Skip
        </button>
      </div>
      <ol className="tour-dots" aria-hidden="true">
        {TOUR_STEPS.map((t, i) => (
          <li key={t.title} className={i === step ? "is-current" : i < step ? "is-done" : ""} />
        ))}
      </ol>
      <h3>{s.title}</h3>
      <p>{s.body}</p>
      <div className="actions">
        <Link to={s.to} className="btn btn-primary btn-small" onClick={dismiss}>
          {s.cta}
        </Link>
        {last ? (
          <button className="btn btn-small" onClick={dismiss}>
            Done
          </button>
        ) : (
          <button className="btn btn-small" onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}
