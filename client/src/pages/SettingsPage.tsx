import { Link } from "react-router-dom";
import { RequireUser } from "../components/RequireUser";
import { SettingsPanel } from "../game/SettingsPanel";

/** Personalize your table outside a game. The same panel opens from the table menu during one. */
export function SettingsPage() {
  return (
    <main className="page narrow">
      <div className="row-between">
        <h1>Personalize</h1>
        <Link to="/play" className="btn btn-small">
          Play
        </Link>
      </div>
      <p className="muted small">Your playmat, sleeves and table look are saved to your account and follow you to every table.</p>
      <RequireUser>
        <SettingsPanel />
      </RequireUser>
    </main>
  );
}
