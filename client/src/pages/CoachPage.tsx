import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { CardSummary, CoachRoomResponse } from "@cgwf/shared";
import { api } from "../api";
import { CardImage } from "../components/CardImage";
import { PageHeading } from "../components/PageHeading";
import { RequireUser } from "../components/RequireUser";
import { isOwner, useUser } from "../user";

/** Tap a card name in the report to read the card. */
function CardChip({ name, onOpen }: { name: string; onOpen: (name: string) => void }) {
  return (
    <button type="button" className="coach-card" onClick={() => onOpen(name)}>
      {name}
    </button>
  );
}

function CardReader({ name, onClose }: { name: string; onClose: () => void }) {
  const [card, setCard] = useState<CardSummary | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api
      .search(name, false)
      .then((r) => live && setCard(r.results[0] ?? null))
      .catch(() => live && setCard(null));
    return () => {
      live = false;
    };
  }, [name]);
  return (
    <div className="coach-reader" role="dialog" aria-label={name} onClick={onClose}>
      <div className="coach-reader-box" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {card === undefined && <p className="muted">Loading {name}…</p>}
        {card === null && <p className="muted">{name}: not found.</p>}
        {card && <CardImage id={card.id} name={card.name} size="normal" loading="eager" />}
      </div>
    </div>
  );
}

function Coach({ code }: { code: string }) {
  const [data, setData] = useState<CoachRoomResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [reading, setReading] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.coach.room(code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  // poll while the report or a follow-up is being written
  const working = data?.report?.status === "running" || data?.report?.followups.some((f) => f.status === "running");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [working, load]);

  const start = async () => {
    setBusy(true);
    try {
      await api.coach.start(code);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    try {
      await api.coach.followup(code, question.trim());
      setQuestion("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
  const { game, report } = data;
  const r = report?.report;
  return (
    <div className="coach">
      <p className="muted">
        Table {game.code} · {game.won ? "you won" : `you finished ${game.place ?? "?"} of ${game.playerCount}`} · {game.turns ?? "?"} turns · {game.deckName}
        {game.test ? " · test game" : ""}
      </p>
      {game.kind === "light" && (
        <p className="notice small coach-light">
          <strong>Light review.</strong> This game was played before decisions were recorded, so the coach sees only the public log and your raw answers, not your hand or the options you had.
        </p>
      )}
      {error && <p className="error small">{error}</p>}
      {!report && (
        <div className="coach-start">
          <p>The coach reads the whole game from your side, finds the turning points, and suggests stronger lines. It uses Claude Opus (owner only, counted in spend).</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
            Coach me
          </button>
        </div>
      )}
      {report?.status === "running" && <p className="muted">The coach is reviewing the game… this takes a minute or two.</p>}
      {report && (report.status === "error" || report.status === "capped") && (
        <p className="error small">
          {report.status === "capped" ? "Stopped at the spend limit: " : "The review failed: "}
          {report.error}{" "}
          {report.status === "error" && (
            <button className="admin-link-button" disabled={busy} onClick={() => void start()}>
              Try again
            </button>
          )}
        </p>
      )}
      {r && (
        <>
          <section className="surface coach-summary">
            <h2>Summary</h2>
            <p>{r.summary}</p>
          </section>
          <section className="coach-points" aria-label="Turning points">
            <h2>Turning points</h2>
            <ol>
              {r.turningPoints.map((p, i) => (
                <li key={i} className="surface coach-point">
                  <p className="eyebrow">
                    {p.round ? `Round ${p.round}` : ""}
                    {p.round && p.turn ? " · " : ""}
                    {p.turn ? `Turn ${p.turn}` : ""} · {p.theme}
                  </p>
                  <h3>{p.title}</h3>
                  <dl>
                    <dt>You had</dt>
                    <dd>{p.had}</dd>
                    <dt>You chose</dt>
                    <dd>{p.chose}</dd>
                    <dt>Stronger line</dt>
                    <dd>{p.betterLine}</dd>
                    <dt>Why</dt>
                    <dd>{p.why}</dd>
                  </dl>
                  {p.cards.length > 0 && (
                    <p className="coach-cards">
                      {p.cards.map((c) => (
                        <CardChip key={c} name={c} onOpen={setReading} />
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
          <section className="surface coach-habits">
            <h2>Three habits to practise</h2>
            <ol>
              {r.habits.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          </section>
          <p className="muted small">{r.hiddenInfoNote}</p>
          <section className="coach-followups" aria-label="Follow-up questions">
            <h2>Ask a follow-up</h2>
            {report!.followups.map((f) => (
              <div key={f.id} className="coach-qa">
                <p>
                  <strong>You:</strong> {f.question}
                </p>
                <p className={f.status === "error" ? "error small" : ""}>{f.status === "running" ? <span className="muted">Thinking…</span> : f.answer}</p>
              </div>
            ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void ask();
              }}
            >
              <label className="field">
                <span>One question at a time</span>
                <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} maxLength={1000} placeholder="Should I have attacked Blair on turn 6?" />
              </label>
              <button className="btn" type="submit" disabled={busy || !question.trim() || report!.followups.some((f) => f.status === "running")}>
                Ask
              </button>
            </form>
          </section>
          <p className="muted small">
            {report!.model} · {report!.calls} call{report!.calls === 1 ? "" : "s"} · ${report!.costUsd.toFixed(2)} for the report
          </p>
        </>
      )}
      {reading && <CardReader name={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

export function CoachPage() {
  const { code = "" } = useParams();
  const { user } = useUser();
  return (
    <main className="page narrow coach-page">
      <PageHeading title="AI Coach" eyebrow="Owner only">
        Where the game turned, and what stronger lines were open to you.
      </PageHeading>
      <RequireUser>{isOwner(user) ? <Coach code={code.toUpperCase()} /> : <p className="muted">Not available.</p>}</RequireUser>
      <p className="small">
        <Link to="/stats">Deck stats</Link> · <Link to="/play">Play</Link>
      </p>
    </main>
  );
}
