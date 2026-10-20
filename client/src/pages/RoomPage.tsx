import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { RequireUser } from "../components/RequireUser";
import { FirstRollOverlay } from "../game/FirstRoll";
import { Lobby } from "../game/Lobby";
import { useRoomSocket } from "../game/socket";
import { Table } from "../game/Table";

function Room({ code }: { code: string }) {
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Joining is a REST call so the room page works from a shared link; the socket then takes over.
  useEffect(() => {
    api.rooms
      .join(code)
      .then(() => setJoined(true))
      .catch((e: Error) => setError(e.message));
  }, [code]);

  const sock = useRoomSocket(joined ? code : null);

  if (error) {
    return (
      <main className="page narrow">
        <p className="error">{error}</p>
        <Link to="/play" className="btn">
          Back to Play
        </Link>
      </main>
    );
  }
  if (!joined || !sock.room) {
    return (
      <main className="page narrow">
        <p className="muted">{sock.status === "closed" ? "Connection closed." : "Joining the table..."}</p>
      </main>
    );
  }
  // Engine tables: the D20 roll for who goes first sits over the lobby (before the engine's first frame) or the table.
  const roll = sock.room.firstRoll ? <FirstRollOverlay room={sock.room} sock={sock} /> : null;
  if (sock.room.status === "lobby" || !sock.view) {
    return (
      <>
        <Lobby room={sock.room} sock={sock} />
        {roll}
      </>
    );
  }
  return (
    <ErrorBoundary>
      <Table room={sock.room} view={sock.view} printings={sock.printings} sock={sock} />
      {roll}
    </ErrorBoundary>
  );
}

export function RoomPage() {
  const { code } = useParams();
  const clean = (code ?? "").toUpperCase();
  return <RequireUser>{clean && <Room code={clean} />}</RequireUser>;
}
