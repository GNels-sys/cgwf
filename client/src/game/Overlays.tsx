import { useEffect, useMemo, useRef, useState } from "react";
import { AVATAR_COLORS, STEP_LABELS, isEventEntry, logKind, type CardPrinting, type LogEntry, type PlayerView, type RoomMember, type ViewCard, type ViewPlayer } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { Battlefield } from "./Battlefield";
import type { SleeveStyle } from "./look";
import { battlefieldCards, deriveFor, type Printings } from "./model";

/**
 * Stage 2 M4 overlays for engine tables, both frosted and both on top of the board (never a page
 * change): the Active Board on the LEFT edge follows the turn around the table (whose turn, which
 * step, that player's board with their latest action highlighted, what they could still do) and
 * minimises to an arrow tab; the Game Log on the RIGHT third lists the sentence log with every
 * card name tappable and minimises to an arrow tab, after which new lines appear as small toasts
 * (top-right, at most three, about five seconds each, below the Stack panel when that shows).
 */

export { isStepLine } from "@cgwf/shared";

// ---------------------------------------------------------------- card names in text

/** Known card names (from the printings this client has seen), longest first, as one regex. */
export function nameMatcher(printings: Printings): { regex: RegExp | null; byName: Map<string, CardPrinting> } {
  const byName = new Map<string, CardPrinting>();
  for (const p of Object.values(printings)) {
    if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), p);
    // double-faced / split cards: each face name too
    for (const face of p.name.split(" // ")) if (face && !byName.has(face.toLowerCase())) byName.set(face.toLowerCase(), p);
  }
  const names = [...byName.keys()].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length);
  if (names.length === 0) return { regex: null, byName };
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return { regex: new RegExp(`(^|[^A-Za-z'])(${escaped.join("|")})(?![A-Za-z'])`, "gi"), byName };
}

/** A log line with its card names turned into buttons. */
export function LinkedText({ text, matcher, onCard }: { text: string; matcher: ReturnType<typeof nameMatcher>; onCard: (p: CardPrinting) => void }) {
  if (!matcher.regex) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  matcher.regex.lastIndex = 0;
  for (let m = matcher.regex.exec(text); m; m = matcher.regex.exec(text)) {
    const lead = m[1] ?? "";
    const name = m[2] ?? "";
    const start = m.index + lead.length;
    if (start > last) parts.push(text.slice(last, start));
    const printing = matcher.byName.get(name.toLowerCase());
    if (printing) {
      parts.push(
        <button key={`${start}-${i++}`} type="button" className="log-card" onClick={() => onCard(printing)} aria-label={`${name}, read the card`}>
          {name}
        </button>,
      );
    } else parts.push(name);
    last = start + name.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A printing as a card the zoom can show (public information: it was named in the log). */
export function printingAsCard(p: CardPrinting, owner: string): ViewCard {
  return {
    iid: `printing:${p.id}`,
    printingId: p.id,
    custom: null,
    owner,
    zone: { kind: "battlefield", owner, row: "other" },
    tapped: false,
    faceDown: false,
    face: 0,
    counters: {},
    attachedTo: null,
    isToken: false,
    isCommander: false,
    effect: null,
    modifier: null,
    anthemDismissed: false,
    public: true,
  };
}

// ---------------------------------------------------------------- edge tabs

export function EdgeTab({ side, label, count, onClick }: { side: "left" | "right"; label: string; count?: number | undefined; onClick: () => void }) {
  return (
    <button className={`edge-tab is-${side}`} onClick={onClick} aria-label={`Open the ${label}`}>
      <span className="edge-tab-arrow" aria-hidden="true">
        {side === "left" ? "▶" : "◀"}
      </span>
      <span className="edge-tab-label">{label}</span>
      {count !== undefined && count > 0 && <span className="edge-tab-count">{count}</span>}
    </button>
  );
}

// ---------------------------------------------------------------- active board

export interface ActiveBoardProps {
  view: PlayerView;
  printings: Printings;
  members: RoomMember[];
  me: string | null;
  sleeveOf: (ownerId: string) => SleeveStyle;
  onTap: (c: ViewCard) => void;
  onHold: (c: ViewCard) => void;
  onMinimize: () => void;
}

function colorOf(members: RoomMember[], id: string): string {
  const m = members.find((x) => x.userId === id);
  return m ? AVATAR_COLORS[m.color] : "var(--accent)";
}

/** The active player's most recent log line, and the cards it names (to light them up on their board). */
function latestAction(view: PlayerView, player: ViewPlayer, printings: Printings): { text: string | null; iids: Set<string> } {
  // engine log lines are system lines that start with the player's name; classic lines carry the actor
  const line = [...view.log].reverse().find((l) => isEventEntry(l) && (l.actor === player.id || l.text.startsWith(`${player.name} `)));
  const iids = new Set<string>();
  if (!line) return { text: null, iids };
  const lower = line.text.toLowerCase();
  for (const c of battlefieldCards(player)) {
    const p = c.printingId ? printings[c.printingId] : undefined;
    if (p && lower.includes(p.name.toLowerCase())) iids.add(c.iid);
  }
  return { text: line.text, iids };
}

export function ActiveBoard({ view, printings, members, me, sleeveOf, onTap, onHold, onMinimize }: ActiveBoardProps) {
  const player = view.players[view.activePlayer];
  if (!player) return null;
  const derived = deriveFor(player, printings);
  const member = members.find((m) => m.userId === player.id);
  const lands = battlefieldCards(player).filter((c) => c.zone.row === "lands");
  const untappedLands = lands.filter((c) => !c.tapped).length;
  const creatures = battlefieldCards(player).filter((c) => c.zone.row === "creatures");
  const untappedCreatures = creatures.filter((c) => !c.tapped).length;
  const latest = latestAction(view, player, printings);
  const mine = player.id === me;
  return (
    <aside className="active-board" aria-label={`Active board: ${player.name}`}>
      <header className="active-board-head">
        {member && <Avatar avatar={member.avatar} color={member.color} size={28} />}
        <div className="active-board-title">
          <strong style={{ color: colorOf(members, player.id) }}>
            {view.round ? `Round ${view.round} · ` : ""}
            {mine ? "Your turn" : `${player.name}'s turn`}
          </strong>
          <span className="muted small">
            {STEP_LABELS[view.step]} · Game turn {view.turn}
          </span>
        </div>
        <button className="sheet-close" onClick={onMinimize} aria-label="Minimise the active board">
          &times;
        </button>
      </header>
      <div className="active-board-facts">
        <span title="Cards in hand">Hand {player.hand.count}</span>
        <span title="Untapped lands">{untappedLands} land{untappedLands === 1 ? "" : "s"} open</span>
        {creatures.length > 0 && (
          <span title="Untapped creatures">
            {untappedCreatures}/{creatures.length} creatures untapped
          </span>
        )}
        <span>{player.life} life</span>
      </div>
      {latest.text && (
        <p className="active-board-latest">
          <span className="muted small">Latest:</span> {latest.text}
        </p>
      )}
      <div className="active-board-field">
        <Battlefield player={player} printings={printings} derived={derived} onTap={onTap} onHold={onHold} highlighted={latest.iids} sleeveOf={sleeveOf} compact />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- game log

export function GameLog({ log, members, printings, onCard, onMinimize }: { log: LogEntry[]; members: RoomMember[]; printings: Printings; onCard: (p: CardPrinting) => void; onMinimize: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const matcher = useMemo(() => nameMatcher(printings), [printings]);
  // Step announcements ("Blair's Upkeep step") are hidden by default (owner, 2026-10-29): the log reads as what
  // happened, turn by turn. "Show steps" brings them back for this sitting.
  const [showSteps, setShowSteps] = useState(false);
  const lines = useMemo(() => (showSteps ? log : log.filter((l) => logKind(l) !== "step")), [log, showSteps]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);
  const colorOfActor = (actor: string): string | null => {
    const m = members.find((x) => x.userId === actor);
    return m ? AVATAR_COLORS[m.color] : null;
  };
  return (
    <aside className="game-log" aria-label="Game log">
      <header className="game-log-head">
        <strong>Game log</strong>
        <span className="muted small">tap a card name to read it</span>
        <button type="button" className={`game-log-steps${showSteps ? " is-on" : ""}`} onClick={() => setShowSteps((v) => !v)} aria-pressed={showSteps} title={showSteps ? "Hide the untap, upkeep and draw announcements" : "Also list every step of each turn"}>
          {showSteps ? "Hide steps" : "Show steps"}
        </button>
        <button className="sheet-close" onClick={onMinimize} aria-label="Minimise the game log">
          &times;
        </button>
      </header>
      <ol className="game-log-list">
        {lines.length === 0 && <li className="muted small">Nothing has happened yet.</li>}
        {lines.map((l, i) => {
          const kind = logKind(l);
          const turn = kind === "turn";
          const round = kind === "round";
          const color = colorOfActor(l.actor);
          return (
            <li key={`${l.seq}-${i}`} className={`game-log-line${turn ? " is-turn" : ""}${round ? " is-round" : ""}`}>
              <span className="log-dot" style={color ? { background: color } : undefined} aria-hidden="true" />
              <span className="game-log-text">
                <LinkedText text={l.text} matcher={matcher} onCard={onCard} />
              </span>
            </li>
          );
        })}
        <div ref={end} />
      </ol>
    </aside>
  );
}

const TOAST_MS = 5000;
const TOAST_MAX = 3;

/** While the log is minimised: the newest lines as toasts, each for about five seconds, at most three. */
export function LogToasts({ log, active, printings, onCard }: { log: LogEntry[]; active: boolean; printings: Printings; onCard: (p: CardPrinting) => void }) {
  const [shown, setShown] = useState<Array<{ entry: LogEntry; until: number }>>([]);
  const seen = useRef<number>(log.at(-1)?.seq ?? 0);
  const matcher = useMemo(() => nameMatcher(printings), [printings]);
  useEffect(() => {
    if (!active) {
      seen.current = log.at(-1)?.seq ?? 0; // while the log is open nothing is "new"
      setShown([]);
      return;
    }
    const fresh = log.filter((l) => l.seq > seen.current && isEventEntry(l)); // never a step, turn or round announcement
    if (fresh.length === 0) return;
    seen.current = log.at(-1)?.seq ?? seen.current;
    const now = Date.now();
    setShown((s) => [...s, ...fresh.map((entry) => ({ entry, until: now + TOAST_MS }))].slice(-TOAST_MAX));
  }, [log, active]);
  useEffect(() => {
    if (shown.length === 0) return;
    const t = window.setTimeout(() => setShown((s) => s.filter((x) => x.until > Date.now())), Math.max(50, Math.min(...shown.map((x) => x.until)) - Date.now() + 10));
    return () => window.clearTimeout(t);
  }, [shown]);
  if (!active || shown.length === 0) return null;
  return (
    <div className="log-toasts" role="status" aria-live="polite">
      {shown.map(({ entry }) => (
        <div key={entry.seq} className="log-toast">
          <LinkedText text={entry.text} matcher={matcher} onCard={onCard} />
        </div>
      ))}
    </div>
  );
}
