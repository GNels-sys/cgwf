import { useEffect, useRef } from "react";
import type { LogEntry, PlayerView, ViewCard, ViewPlayer, RoomInfo, RoomMember } from "@cgwf/shared";
import { AVATAR_COLORS } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { Footer } from "../components/Footer";
import { Battlefield } from "./Battlefield";
import { CardTile } from "./CardTile";
import { useMat, type SleeveStyle } from "./look";
import { ManaSummary } from "./Mana";
import { battlefieldCards, counterSummary, deriveFor, nameOf, totalCommanderDamage, type Printings } from "./model";

/** Modal panels used by the table: zone viewer, opponent field, log, menu. */

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Panel({ title, subtitle, onClose, children, wide = false, className = "" }: { title: string; subtitle?: string | undefined; onClose: () => void; children: React.ReactNode; wide?: boolean; className?: string }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal panel${wide ? " is-wide" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <strong>{title}</strong>
          {subtitle && <span className="muted small">{subtitle}</span>}
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </div>
  );
}

type SleeveOf = (ownerId: string) => SleeveStyle;

export function CardList({ cards, printings, onTap, onHold, sleeveOf, empty = "Nothing here." }: { cards: ViewCard[]; printings: Printings; onTap: (c: ViewCard) => void; onHold: (c: ViewCard) => void; sleeveOf?: SleeveOf; empty?: string }) {
  if (cards.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="card-list">
      {cards.map((c) => (
        <div key={c.iid} className="card-list-item">
          <CardTile card={c} printings={printings} onTap={onTap} onHold={onHold} sleeve={sleeveOf?.(c.owner)} />
          <span className="small">{nameOf(c, printings)}</span>
        </div>
      ))}
    </div>
  );
}

export function OpponentPanel({
  player,
  member,
  view,
  printings,
  me,
  sleeveOf,
  onClose,
  onTap,
  onHold,
  onShowCards,
  onPlayerSheet,
  onAnthems,
  highlighted,
}: {
  player: ViewPlayer;
  member: RoomMember | undefined;
  view: PlayerView;
  printings: Printings;
  me: string | null;
  sleeveOf: SleeveOf;
  onClose: () => void;
  onTap: (c: ViewCard) => void;
  onHold: (c: ViewCard) => void;
  onShowCards: (title: string, cards: ViewCard[]) => void;
  onPlayerSheet: (p: ViewPlayer) => void;
  onAnthems: (p: ViewPlayer) => void;
  highlighted: ReadonlySet<string>;
}) {
  const active = view.activePlayer === player.id;
  const derived = deriveFor(player, printings);
  const mat = useMat(member?.look);
  return (
    <Panel title={player.name} subtitle={`${player.life} life${player.conceded ? " - conceded" : player.eliminated ? ` - out of the game (${player.eliminated})` : active ? " - active player" : ""}`} onClose={onClose} wide className="opponent-panel">
      <div className="opp-stats">
        <span>Hand {player.hand.count}</span>
        <span>Library {player.library.count}</span>
        {counterSummary(player.counters) && <span>{counterSummary(player.counters)}</span>}
        {totalCommanderDamage(player) > 0 && <span>Cmdr dmg {totalCommanderDamage(player)}</span>}
        <ManaSummary player={player} />
        {me && (
          <button className="btn btn-small" onClick={() => onPlayerSheet(player)}>
            Counters
          </button>
        )}
      </div>
      <div className="zone-btns">
        <button className="btn btn-small" onClick={() => onShowCards(`${player.name}'s command zone`, player.command)}>
          Command {player.command.length}
        </button>
        <button className="btn btn-small" onClick={() => onShowCards(`${player.name}'s graveyard`, player.graveyard)}>
          Graveyard {player.graveyard.length}
        </button>
        <button className="btn btn-small" onClick={() => onShowCards(`${player.name}'s exile`, player.exile)}>
          Exile {player.exile.length}
        </button>
        {player.library.known.length > 0 && (
          <button className="btn btn-small" onClick={() => onShowCards(`Revealed from ${player.name}'s library`, player.library.known)}>
            Revealed {player.library.known.length}
          </button>
        )}
      </div>
      <div className={`opp-field mat ${mat.className}`} style={mat.style}>
        {player.hand.cards.length > 0 && (
          <div className="opp-row">
            <span className="row-label">Revealed</span>
            {player.hand.cards.map((c) => (
              <CardTile key={c.iid} card={c} printings={printings} onTap={onTap} onHold={onHold} sleeve={sleeveOf(c.owner)} />
            ))}
          </div>
        )}
        <Battlefield player={player} printings={printings} derived={derived} onTap={onTap} onHold={onHold} highlighted={highlighted} onAnthems={() => onAnthems(player)} sleeveOf={sleeveOf} compact />
      </div>
      {Object.keys(player.commanderDamage).length > 0 && (
        <p className="muted small">
          Commander damage taken:{" "}
          {Object.entries(player.commanderDamage)
            .map(([iid, n]) => {
              const c = Object.values(view.players)
                .flatMap((p) => [...p.command, ...battlefieldCards(p), ...p.graveyard, ...p.exile])
                .find((x) => x.iid === iid);
              return `${n} from ${c ? nameOf(c, printings) : "a commander"}`;
            })
            .join(", ")}
        </p>
      )}
    </Panel>
  );
}

const TURN_LINE = /^(Turn \d+:|Everyone kept\.|Game started)/;

/**
 * The game log as sentences. Turn changes are drawn as separators, each line
 * carries the actor's colour, and tapping a line (when allowed) rewinds to it.
 */
export function LogPanel({ log, members, canRevert, onRevert, onClose }: { log: LogEntry[]; members: RoomMember[]; canRevert: boolean; onRevert: (seq: number) => void; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [log.length]);
  const lastSeq = log.at(-1)?.seq ?? 0;
  const colorOf = (actor: string): string | null => {
    const m = members.find((x) => x.userId === actor);
    return m ? AVATAR_COLORS[m.color] : null;
  };
  return (
    <Panel title="Game log" subtitle={canRevert ? "Tap a line to rewind the game to just after it" : undefined} onClose={onClose}>
      {log.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      <ol className="log-list">
        {log.map((l, i) => {
          const turn = TURN_LINE.test(l.text);
          const color = colorOf(l.actor);
          return (
            <li key={`${l.seq}-${i}`} className={turn ? "is-turn" : ""}>
              <button className="log-line" disabled={!canRevert || l.seq >= lastSeq} onClick={() => onRevert(l.seq)} aria-label={`${l.text}${canRevert && l.seq < lastSeq ? ". Rewind to here" : ""}`}>
                <span className="log-dot" style={color ? { background: color } : undefined} aria-hidden="true" />
                <span className="log-text">{l.text}</span>
                <span className="log-seq">#{l.seq}</span>
              </button>
            </li>
          );
        })}
        <div ref={end} />
      </ol>
    </Panel>
  );
}

export function MenuPanel({ room, view, me, status, onClose, actions }: { room: RoomInfo; view: PlayerView; me: string | null; status: string; onClose: () => void; actions: Array<{ label: string; run: () => void; danger?: boolean; disabled?: boolean; hint?: string | undefined }> }) {
  return (
    <Panel title={`Table ${room.code}`} subtitle={`Turn ${view.turn} - connection ${status}`} onClose={onClose}>
      <ul className="member-list">
        {room.members.map((m) => (
          <li key={m.userId} className={m.online ? "" : "is-offline"}>
            <Avatar avatar={m.avatar} color={m.color} size={24} />
            <span>
              {m.name}
              {m.userId === me ? " (you)" : ""}
              {m.userId === room.hostId ? <span className="muted small"> (host)</span> : null}
              {m.isAgent ? <span className="bot-chip">{m.thinking ? "thinking…" : "BOT"}</span> : null}
            </span>
            <span className="muted small">
              {m.role === "player" ? (view.players[m.userId]?.conceded ? "conceded" : view.players[m.userId]?.eliminated ? `out (${view.players[m.userId]!.eliminated})` : `seat ${(m.seat ?? 0) + 1}`) : "watching"}
              {m.online ? "" : " - offline"}
            </span>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        {actions.map((a) => (
          <button key={a.label} className={`sheet-action${a.danger ? " is-danger" : ""}`} disabled={a.disabled} onClick={a.run}>
            <span>{a.label}</span>
            {a.hint && <small className="muted">{a.hint}</small>}
          </button>
        ))}
      </div>
      <Footer />
    </Panel>
  );
}
