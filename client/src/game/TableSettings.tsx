import { BRACKET_NAMES, MAX_FREE_MULLIGANS, OPENING_HAND_TEXT, freeMulligansLabel, openingHandSummary, type Bracket, type OpeningHandMode, type RoomInfo } from "@cgwf/shared";
import type { RoomSocket } from "./socket";

const BRACKETS: Bracket[] = [1, 2, 3, 4, 5];

/**
 * Engine lobbies: the two settings agreed before the game, frozen when it starts. The host edits them;
 * everyone else sees them. "Test game" = played normally, never counted in deck statistics. "Table
 * bracket" = the bracket this table plays at (default: the highest suggested bracket of the seated decks).
 */
export function TableSettings({ room, sock, isHost }: { room: RoomInfo; sock: RoomSocket; isHost: boolean }) {
  const auto = room.tableBracketChosen ? "" : "auto";
  const label = room.tableBracket ? `B${room.tableBracket} · ${BRACKET_NAMES[room.tableBracket as Bracket]}` : "not known yet";
  return (
    <section className="table-settings" aria-label="Table settings">
      <label className={`table-settings-test${room.testGame ? " is-on" : ""}`}>
        <input
          type="checkbox"
          checked={room.testGame}
          disabled={!isHost}
          onChange={(e) => sock.send({ t: "tableSettings", testGame: e.target.checked })}
        />
        <span>
          <strong>Test game</strong> <span className="muted small">(not counted in deck stats)</span>
        </span>
      </label>
      {isHost ? (
        <label className="field table-settings-bracket">
          <span>Table bracket</span>
          <select value={room.tableBracketChosen ? String(room.tableBracket) : auto} onChange={(e) => sock.send({ t: "tableSettings", tableBracket: e.target.value === "auto" ? null : Number(e.target.value) })}>
            <option value="auto">Automatic ({room.tableBracket ? `B${room.tableBracket}` : "no decks yet"}): highest deck bracket</option>
            {BRACKETS.map((b) => (
              <option key={b} value={b}>
                B{b} · {BRACKET_NAMES[b]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="table-settings-bracket muted small">
          Table bracket: <strong>{label}</strong>
          {room.tableBracketChosen ? "" : " (automatic: highest deck bracket)"}
        </p>
      )}
      {isHost ? (
        <label className="field table-settings-first">
          <span>Who goes first</span>
          <select value={room.firstPlayer} onChange={(e) => sock.send({ t: "tableSettings", firstPlayer: e.target.value === "random" ? "random" : "roll" })}>
            <option value="roll">Roll a D20 (everyone rolls)</option>
            <option value="random">Random (no roll)</option>
          </select>
        </label>
      ) : (
        <p className="table-settings-first muted small">
          Who goes first: <strong>{room.firstPlayer === "random" ? "Random" : "Roll a D20"}</strong>
        </p>
      )}
      <fieldset className="table-settings-hand">
        <legend>Opening hand</legend>
        {isHost ? (
          (["draw7", "draw10"] as OpeningHandMode[]).map((mode) => (
            <label key={mode} className={`table-settings-hand-option${room.openingHand.mode === mode ? " is-on" : ""}`}>
              <input type="radio" name="opening-hand" checked={room.openingHand.mode === mode} onChange={() => sock.send({ t: "tableSettings", openingHand: { mode } })} />
              <span>
                <strong>{OPENING_HAND_TEXT[mode].title}</strong>
                <span className="muted small table-settings-rules">{OPENING_HAND_TEXT[mode].rules}</span>
              </span>
            </label>
          ))
        ) : (
          <p className="small">
            <strong>{openingHandSummary(room.openingHand)}</strong>
            <span className="muted small table-settings-rules">{OPENING_HAND_TEXT[room.openingHand.mode].rules}</span>
          </p>
        )}
        {isHost && room.openingHand.mode === "draw7" && (
          <label className="field table-settings-free">
            <span>Free mulligans</span>
            <select value={room.openingHand.freeMulligans} onChange={(e) => sock.send({ t: "tableSettings", openingHand: { freeMulligans: Number(e.target.value) } })}>
              {Array.from({ length: MAX_FREE_MULLIGANS + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {n}
                  {n === 1 ? " (official multiplayer rule)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isHost && room.openingHand.mode === "draw7" && <p className="muted small">{freeMulligansLabel(room.openingHand.freeMulligans)} per player.</p>}
      </fieldset>
      <p className="muted small table-settings-note">These settings are fixed when the game starts. Only finished games that are not test games count in deck stats.</p>
    </section>
  );
}
