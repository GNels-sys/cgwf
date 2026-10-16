import { PageHeading } from "../components/PageHeading";
import { Link } from "react-router-dom";
import { RequireUser } from "../components/RequireUser";
import { SettingsPanel } from "../game/SettingsPanel";

/** Personalize your table outside a game. The same panel opens from the table menu during one. */
export function SettingsPage() {
  return (
    <main className="page settings-page">
      <PageHeading title="Personalize" eyebrow="Set the scene" illustrated actions={<Link to="/play" className="btn btn-small">Play ↗</Link>}>Your playmat, sleeves, and room. A table that feels like yours.</PageHeading>
      <p className="muted small">Your playmat, sleeves and table look are saved to your account and follow you to every table.</p>
      <RequireUser>
        <SettingsPanel />
      </RequireUser>
    </main>
  );
}
