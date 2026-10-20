import { useEffect, useRef, useState } from "react";
import {
  AVATAR_COLORS,
  D20_SIDES,
  joinNames,
  type FirstRollInfo,
  type FirstRollSeat,
  type RoomInfo,
} from "@cgwf/shared";
import type { RoomSocket } from "./socket";
import { installLayoutCheck } from "./layoutCheck";

/** How long the result stays up after the roll (the mulligan comes up underneath). */
export const FIRST_ROLL_RESULT_MS = 4500;
const SPIN_MS = 900;

/** Pure: is the overlay up? While rolling, and briefly after (also right after a reload), unless dismissed. */
export function firstRollVisible(
  info: FirstRollInfo | null,
  now: number,
  dismissedAt: number | null,
): boolean {
  if (!info || info.method !== "roll") return false;
  if (info.status === "rolling") return true;
  if (info.doneAt === null || dismissedAt === info.doneAt) return false;
  return now - info.doneAt < FIRST_ROLL_RESULT_MS;
}

/** Pure: the line under the title. */
export function firstRollStatus(info: FirstRollInfo): string {
  const byName = (seat: number | null) =>
    info.seats.find((s) => s.seat === seat)?.name ?? "Someone";
  if (info.status === "done") return `${byName(info.winnerSeat)} goes first`;
  if (info.round > 1) {
    const tied = info.seats.filter((s) => s.contending);
    const at = tied[0]?.history.at(-1);
    return `Tie${at ? ` at ${at}` : ""}: ${joinNames(tied.map((s) => s.name))} roll again`;
  }
  return "Highest roll goes first";
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Shows `value` after a short tumble of random faces (decorative; the value is the server's). Reduced motion: no tumble. */
function useTumble(value: number | null): {
  shown: number | null;
  spinning: boolean;
} {
  const [shown, setShown] = useState<number | null>(value);
  const [spinning, setSpinning] = useState(false);
  const last = useRef<number | null>(value);
  useEffect(() => {
    if (value === last.current) return;
    last.current = value;
    if (value === null || reducedMotion()) {
      setShown(value);
      setSpinning(false);
      return;
    }
    setSpinning(true);
    const tick = setInterval(
      () => setShown(1 + Math.floor(Math.random() * D20_SIDES)),
      70,
    );
    const stop = setTimeout(() => {
      clearInterval(tick);
      setShown(value);
      setSpinning(false);
    }, SPIN_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [value]);
  return { shown, spinning };
}

/** An original line drawing of a twenty-sided die: hexagon silhouette, front face, facet lines. */
function D20({
  value,
  spinning,
  size,
  label,
}: {
  value: number | null;
  spinning: boolean;
  size: "big" | "small";
  label: string;
}) {
  return (
    <span
      className={`d20 d20-${size}${spinning ? " is-spinning" : ""}`}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <polygon
          className="d20-body"
          points="50,3 91,26 91,74 50,97 9,74 9,26"
        />
        <polygon className="d20-face" points="50,22 77,68 23,68" />
        <path
          className="d20-facet"
          d="M50,3 L50,22 M91,26 L77,68 M9,26 L23,68 M50,97 L23,68 M50,97 L77,68 M9,74 L23,68 M91,74 L77,68 M9,26 L50,22 L91,26"
        />
      </svg>
      <span className="d20-value">{value ?? "?"}</span>
    </span>
  );
}

function SeatRoll({
  s,
  mine,
  canRoll,
  onRoll,
  winner,
  color,
}: {
  s: FirstRollSeat;
  mine: boolean;
  canRoll: boolean;
  onRoll: () => void;
  winner: boolean;
  color: string;
}) {
  const { shown, spinning } = useTumble(s.value);
  const out = !s.contending && s.value === null;
  return (
    <li
      className={`first-roll-seat${winner ? " is-winner" : ""}${out ? " is-out" : ""}`}
      style={{ "--who": color } as React.CSSProperties}
    >
      <span className="first-roll-name">
        <span className="first-roll-dot" aria-hidden="true" />
        {s.name}
        {mine ? " (you)" : ""}
      </span>
      <D20
        value={out ? (s.history.at(-1) ?? null) : shown}
        spinning={spinning}
        size="small"
        label={
          s.value === null
            ? `${s.name} has not rolled`
            : `${s.name} rolled ${s.value}`
        }
      />
      <span className="first-roll-note small">
        {canRoll ? (
          <button
            type="button"
            className="btn btn-primary first-roll-roll"
            onClick={onRoll}
          >
            Roll
          </button>
        ) : out ? (
          "out this round"
        ) : s.value !== null ? (
          s.history.length > 1 ? (
            `rolls: ${s.history.join(", ")}`
          ) : (
            ""
          )
        ) : s.auto ? (
          "rolls automatically"
        ) : (
          "waiting…"
        )}
      </span>
    </li>
  );
}

/** "Roll to see who goes first": everyone sees every die; each player rolls their own (the server rolls it). */
export function FirstRollOverlay({
  room,
  sock,
}: {
  room: RoomInfo;
  sock: RoomSocket;
}) {
  const info = room.firstRoll;
  const [now, setNow] = useState(() => Date.now());
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const visible = firstRollVisible(info, now, dismissedAt);

  // re-evaluate when the result should go away
  useEffect(() => {
    if (!info || info.status !== "done" || info.doneAt === null) return;
    const left = info.doneAt + FIRST_ROLL_RESULT_MS - Date.now();
    if (left <= 0) {
      setNow(Date.now());
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), left + 20);
    return () => clearTimeout(t);
  }, [info?.status, info?.doneAt]);

  // the layout check still works while the roll covers the table (and before the table exists)
  useEffect(() => {
    if (!visible || window.cgwfLayoutCheck) return;
    return installLayoutCheck();
  }, [visible]);

  if (!info || !visible) return null;
  const meSeat = room.you?.seat ?? null;
  const myKey = `${info.round}:${meSeat}`;
  const roll = () => {
    setSent(myKey);
    sock.send({ t: "roll" });
  };
  const winner = info.seats.find((s) => s.seat === info.winnerSeat) ?? null;
  const mine = info.seats.find((s) => s.seat === meSeat) ?? null;
  const bigValue =
    info.status === "done"
      ? (winner?.history.at(-1) ?? null)
      : (mine?.value ?? null);
  const colorOf = (userId: string) => {
    const m = room.members.find((x) => x.userId === userId);
    return m ? AVATAR_COLORS[m.color] : "var(--accent)";
  };
  return (
    <div
      className="first-roll"
      role="dialog"
      aria-modal="true"
      aria-label="Roll for who goes first"
    >
      <div className="first-roll-box">
        <p className="eyebrow">
          {info.round > 1 ? `Round ${info.round}` : "Before the mulligans"}
        </p>
        <h2>
          {info.status === "done"
            ? "Who goes first"
            : "Roll for who goes first"}
        </h2>
        <BigDie value={bigValue} done={info.status === "done"} />
        <p className="first-roll-status" aria-live="polite">
          {firstRollStatus(info)}
        </p>
        <ul className="first-roll-seats">
          {info.seats.map((s) => (
            <SeatRoll
              key={s.seat}
              s={s}
              mine={s.seat === meSeat}
              canRoll={
                info.status === "rolling" &&
                s.seat === meSeat &&
                s.contending &&
                s.value === null &&
                sent !== myKey
              }
              onRoll={roll}
              winner={info.status === "done" && s.seat === info.winnerSeat}
              color={colorOf(s.userId)}
            />
          ))}
        </ul>
        {info.status === "done" && (
          <button
            type="button"
            className="btn first-roll-close"
            onClick={() => setDismissedAt(info.doneAt)}
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}

function BigDie({ value, done }: { value: number | null; done: boolean }) {
  const { shown, spinning } = useTumble(value);
  return (
    <D20
      value={shown}
      spinning={spinning}
      size="big"
      label={
        value === null
          ? "Your D20"
          : done
            ? `Winning roll ${value}`
            : `You rolled ${value}`
      }
    />
  );
}
