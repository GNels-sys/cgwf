import { Link, Navigate, useNavigate } from "react-router-dom";
import { landingFor } from "@cgwf/shared";
import { getToken } from "../api";
import { ProfileForm } from "../components/ProfileForm";
import { useUser } from "../user";

/**
 * What a signed-out visitor sees at "/": what CGwF is, how a game works, two
 * ways in. Signed-in players go straight to their decks (DecksPage).
 */
export function WelcomePage() {
  return (
    <main className="page welcome-page">
      <section className="hero">
        <h1>CGwF</h1>
        <p className="hero-tagline">Card Games with Friends</p>
        <p className="hero-lead">
          A free, synced virtual card table for playing Commander with your friends over the internet. Real card images, hidden hands and
          libraries, every action in a shared log. You enforce the rules, like at a kitchen table.
        </p>
        <div className="hero-actions">
          <Link to="/start" className="btn btn-primary btn-big">
            Start playing
          </Link>
          <Link to="/signin" className="btn btn-big">
            I have an account
          </Link>
        </div>
        <p className="muted small">Starting takes ten seconds: a name and an avatar, no password. Add an email later to use your decks on other devices.</p>
      </section>

      <section className="how-it-works">
        <h2>How a game works</h2>
        <ol className="steps">
          <li>
            <strong>Import a deck.</strong> Paste a decklist from Archidekt, Moxfield, MTGGoldfish, TappedOut or Arena. Every card gets its real
            image and a Commander Bracket read-out.
          </li>
          <li>
            <strong>Open or join a table.</strong> Start a table and share its six-character code, or type a friend's code. Up to four players
            plus spectators; invite friends straight from the lobby.
          </li>
          <li>
            <strong>Play.</strong> Tap a card for its actions, drag if you prefer. Life, counters, commander damage, tokens, dice and the log are
            all shared instantly. Your own last action undoes silently.
          </li>
        </ol>
      </section>

      <section className="features">
        <ul>
          <li>
            <strong>Hidden information stays hidden.</strong> The server keeps the only true game; your phone only ever receives what you are
            allowed to see.
          </li>
          <li>
            <strong>Best on a phone in landscape.</strong> Opponents across the top, your battlefield and hand below. Works on a tablet or
            computer too.
          </li>
          <li>
            <strong>Installable.</strong> Add it to your home screen from Safari or Chrome and it opens like an app.
          </li>
          <li>
            <strong>Yours to personalize.</strong> Playmats, sleeves, table themes, light or dark, ambient sound.
          </li>
        </ul>
      </section>

      <section className="notice fan-content">
        <p>
          <strong>Unofficial Fan Content.</strong> CGwF is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by
          Wizards. Portions of the materials used are property of Wizards of the Coast. &copy;Wizards of the Coast LLC. Card data and images
          courtesy of Scryfall. CGwF is free and will stay free.
        </p>
      </section>
    </main>
  );
}

/** "/start": the name + avatar form on its own page, then straight to the decks page (where the tour appears). */
export function StartPage() {
  const { user, loading, register } = useUser();
  const navigate = useNavigate();
  if (loading) return <main className="page narrow">Loading...</main>;
  if (user) return <Navigate to="/" replace />;
  return (
    <main className="page narrow">
      <section className="welcome">
        <h1>Pick a name and an avatar</h1>
        <p className="muted">This is how your friends will see you at the table. This device remembers you; no password needed.</p>
        <ProfileForm
          submitLabel="Start"
          onSubmit={async (body) => {
            await register(body);
            navigate("/", { replace: true });
          }}
        />
        <p className="muted small">
          Already have an account? <Link to="/signin">Sign in instead</Link>
        </p>
      </section>
    </main>
  );
}

/** Root route: welcome for signed-out visitors, the app otherwise. */
export function Landing({ app }: { app: React.ReactNode }) {
  const { user, loading } = useUser();
  const where = landingFor({ hasToken: Boolean(getToken()), loading, signedIn: Boolean(user) });
  if (where === "loading") return <main className="page narrow">Loading...</main>;
  if (where === "welcome") return <WelcomePage />;
  return <>{app}</>;
}
