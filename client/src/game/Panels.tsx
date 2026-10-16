import { useEffect, useRef, useState } from "react";
import type { CardSummary, Color, LogEntry, PlayerView, ViewCard, ViewPlayer, Row } from "@cgwf/shared";
import { api } from "../api";
import { Avatar } from "../components/Avatar";
import { CardImage } from "../components/CardImage";
import { Footer } from "../components/Footer";
import type { RoomInfo } from "@cgwf/shared";
import { CardTile } from "./CardTile";
import { battlefieldCards, counterSummary, nameOf, totalCommanderDamage, type Printings } from "./model";

/** Modal panels used by the table: zone viewer, opponent field, log, tokens, menu. */

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

export function Panel({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string | undefined; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal panel${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
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

export function CardList({ cards, printings, onTap, onHold, empty = "Nothing here." }: { cards: ViewCard[]; printings: Printings; onTap: (c: ViewCard) => void; onHold: (c: ViewCard) => void; empty?: string }) {
  if (cards.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="card-list">
      {cards.map((c) => (
        <div key={c.iid} className="card-list-item">
          <CardTile card={c} printings={printings} onTap={onTap} onHold={onHold} />
          <span className="small">{nameOf(c, printings)}</span>
        </div>
      ))}
    </div>
  );
}

const ROW_LABEL: Record<Row, string> = { lands: "Lands", creatures: "Creatures", other: "Other" };

export function OpponentPanel({
  player,
  view,
  printings,
  me,
  onClose,
  onTap,
  onHold,
  onShowCards,
  onPlayerSheet,
}: {
  player: ViewPlayer;
  view: PlayerView;
  printings: Printings;
  me: string | null;
  onClose: () => void;
  onTap: (c: ViewCard) => void;
  onHold: (c: ViewCard) => void;
  onShowCards: (title: string, cards: ViewCard[]) => void;
  onPlayerSheet: (p: ViewPlayer) => void;
}) {
  const active = view.activePlayer === player.id;
  return (
    <Panel title={player.name} subtitle={`${player.life} life${player.conceded ? " - conceded" : active ? " - active player" : ""}`} onClose={onClose} wide>
      <div className="opp-stats">
        <span>Hand {player.hand.count}</span>
        <span>Library {player.library.count}</span>
        {counterSummary(player.counters) && <span>{counterSummary(player.counters)}</span>}
        {totalCommanderDamage(player) > 0 && <span>Cmdr dmg {totalCommanderDamage(player)}</span>}
        {me && (
          <button className="btn btn-small" onClick={() => onPlayerSheet(player)}>
            Counters
          </button>
        )}
      </div>
      {player.hand.cards.length > 0 && (
        <div className="opp-row">
          <span className="row-label">Revealed</span>
          {player.hand.cards.map((c) => (
            <CardTile key={c.iid} card={c} printings={printings} onTap={onTap} onHold={onHold} />
          ))}
        </div>
      )}
      {(["lands", "creatures", "other"] as const).map((row) => (
        <div key={row} className="opp-row">
          <span className="row-label">{ROW_LABEL[row]}</span>
          {player.battlefield[row].length === 0 && <span className="muted small">-</span>}
          {player.battlefield[row].map((c) => (
            <CardTile key={c.iid} card={c} printings={printings} onTap={onTap} onHold={onHold} attached={Boolean(c.attachedTo)} />
          ))}
        </div>
      ))}
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

export function LogPanel({ log, canRevert, onRevert, onClose }: { log: LogEntry[]; canRevert: boolean; onRevert: (seq: number) => void; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [log.length]);
  const lastSeq = log.at(-1)?.seq ?? 0;
  return (
    <Panel title="Game log" subtitle={canRevert ? "Tap a line to rewind the game to just after it" : undefined} onClose={onClose}>
      <ol className="log-list">
        {log.map((l, i) => (
          <li key={`${l.seq}-${i}`}>
            <button className="log-line" disabled={!canRevert || l.seq >= lastSeq} onClick={() => onRevert(l.seq)}>
              <span className="log-seq">#{l.seq}</span>
              <span>{l.text}</span>
            </button>
          </li>
        ))}
        <div ref={end} />
      </ol>
    </Panel>
  );
}

const COLORS: Color[] = ["W", "U", "B", "R", "G"];

export function TokenPanel({ onCreate, onClose }: { onCreate: (payload: { printingId: string | null; custom: { name: string; typeLine: string; power: string | null; toughness: string | null; colors: Color[]; text: string } | null; count: number; row: Row }) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"search" | "custom">("search");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CardSummary[]>([]);
  const [count, setCount] = useState(1);
  const [row, setRow] = useState<Row>("creatures");
  const [name, setName] = useState("");
  const [typeLine, setTypeLine] = useState("Creature");
  const [pt, setPt] = useState("1/1");
  const [colors, setColors] = useState<Color[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    if (mode !== "search" || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .search(q.trim(), true, ctl.signal)
        .then((r) => setResults(r.results.filter((c) => c.isToken).slice(0, 24)))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, mode]);

  const rowFor = (typeLineText: string): Row => (/Creature/.test(typeLineText) ? "creatures" : /Land/.test(typeLineText) ? "lands" : "other");

  return (
    <Panel title="Create tokens" onClose={onClose} wide>
      <div className="row-between">
        <div className="actions">
          <button className={`chip${mode === "search" ? " is-selected" : ""}`} onClick={() => setMode("search")}>
            Find a token
          </button>
          <button className={`chip${mode === "custom" ? " is-selected" : ""}`} onClick={() => setMode("custom")}>
            Custom
          </button>
        </div>
        <label className="inline-field small">
          <span className="muted">How many</span>
          <input type="number" inputMode="numeric" min={1} max={20} value={count} onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} style={{ width: 64 }} />
        </label>
      </div>
      {mode === "search" ? (
        <>
          <input className="token-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Token name: treasure, soldier, zombie..." autoFocus />
          <div className="token-results">
            {results.map((c) => (
              <button key={c.id} className="token-result" onClick={() => onCreate({ printingId: c.id, custom: null, count, row: rowFor(c.typeLine) })}>
                <CardImage id={c.id} name={c.name} size="small" />
                <span className="small">{c.name}</span>
                <span className="muted small">{c.typeLine.replace(/^Token /, "")}</span>
              </button>
            ))}
            {q.trim().length >= 2 && results.length === 0 && <p className="muted small">No token by that name. Try the Custom tab.</p>}
          </div>
        </>
      ) : (
        <form
          className="token-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const [power, toughness] = pt.includes("/") ? pt.split("/").map((s) => s.trim()) : [null, null];
            onCreate({ printingId: null, custom: { name: name.trim(), typeLine: typeLine.trim() || "Token", power: power || null, toughness: toughness || null, colors, text: text.trim() }, count, row });
          }}
        >
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Spirit" autoFocus />
          </label>
          <div className="two-up">
            <label className="field">
              <span>Type</span>
              <input value={typeLine} onChange={(e) => setTypeLine(e.target.value)} maxLength={60} />
            </label>
            <label className="field">
              <span>P/T</span>
              <input value={pt} onChange={(e) => setPt(e.target.value)} maxLength={9} placeholder="1/1" />
            </label>
          </div>
          <div className="field">
            <span>Colours</span>
            <div className="actions">
              {COLORS.map((c) => (
                <button key={c} type="button" className={`chip${colors.includes(c) ? " is-selected" : ""}`} onClick={() => setColors(colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c])}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Text (optional)</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Flying" />
          </label>
          <label className="field">
            <span>Row</span>
            <select value={row} onChange={(e) => setRow(e.target.value as Row)}>
              <option value="creatures">Creatures</option>
              <option value="other">Other</option>
              <option value="lands">Lands</option>
            </select>
          </label>
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            Create {count > 1 ? `${count} tokens` : "token"}
          </button>
        </form>
      )}
    </Panel>
  );
}

export function MenuPanel({ room, view, me, status, onClose, actions }: { room: RoomInfo; view: PlayerView; me: string | null; status: string; onClose: () => void; actions: Array<{ label: string; run: () => void; danger?: boolean; disabled?: boolean }> }) {
  return (
    <Panel title={`Table ${room.code}`} subtitle={`Turn ${view.turn} - connection ${status}`} onClose={onClose}>
      <ul className="member-list">
        {room.members.map((m) => (
          <li key={m.userId} className={m.online ? "" : "is-offline"}>
            <Avatar avatar={m.avatar} color={m.color} size={24} />
            <span>
              {m.name}
              {m.userId === me ? " (you)" : ""}
            </span>
            <span className="muted small">{m.role === "player" ? (view.players[m.userId]?.conceded ? "conceded" : `seat ${(m.seat ?? 0) + 1}`) : "watching"}{m.online ? "" : " - offline"}</span>
          </li>
        ))}
      </ul>
      <div className="sheet-actions">
        {actions.map((a) => (
          <button key={a.label} className={`sheet-action${a.danger ? " is-danger" : ""}`} disabled={a.disabled} onClick={a.run}>
            <span>{a.label}</span>
          </button>
        ))}
      </div>
      <Footer />
    </Panel>
  );
}
