import { BRACKET_NAMES, type Bracket, type RoomInfo } from "@cgwf/shared";
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
      <p className="muted small table-settings-note">Both settings are fixed when the game starts. Only finished games that are not test games count in deck stats.</p>
    </section>
  );
}
