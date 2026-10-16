import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { PASSWORD_MIN, type SignInRequest, type SignUpRequest } from "@cgwf/shared";
import { ApiError } from "../api";
import { Avatar } from "../components/Avatar";
import { RequireUser } from "../components/RequireUser";
import { useUser } from "../user";

/** Sign-up form: email, password, confirm; explains why; "email already used" gets a way out. */
function SignUpForm({ onSubmit }: { onSubmit: (body: SignUpRequest) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    setTaken(false);
    try {
      await onSubmit({ email: email.trim(), password });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && /already in use/i.test(err.message)) {
        setTaken(true);
        setError(null);
      } else setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="profile-form" onSubmit={submit}>
      <ol className="signup-steps small muted">
        <li className={email.trim() ? "is-done" : ""}>Email</li>
        <li className={password.length >= PASSWORD_MIN ? "is-done" : ""}>Password</li>
        <li className={confirm && !mismatch ? "is-done" : ""}>Confirm</li>
      </ol>
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required />
        <span className="muted small">Only used to sign in. No newsletters, nothing is sent to it yet.</span>
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} required />
        <span className="muted small">At least {PASSWORD_MIN} characters. There is no password reset yet, so keep it somewhere safe (a password manager is ideal).</span>
      </label>
      <label className="field">
        <span>Confirm password</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} required aria-invalid={mismatch} />
        {mismatch && <span className="error small">Does not match yet.</span>}
      </label>
      {taken && (
        <div className="notice">
          <p>
            <strong>That email already has an account.</strong>
          </p>
          <p className="muted small">
            If it is yours, sign in with it instead; this device's profile would be replaced by that account. If you forgot the password there is no reset yet, so pick a different email to keep this profile.
          </p>
          <div className="actions">
            <Link to="/signin" className="btn btn-small btn-primary">
              Sign in instead
            </Link>
            <button type="button" className="btn btn-small" onClick={() => setTaken(false)}>
              Use a different email
            </button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim() || password.length < PASSWORD_MIN || !confirm || mismatch}>
        {busy ? "One moment..." : "Create account"}
      </button>
    </form>
  );
}

/** Email + password fields shared by sign-up and sign-in. */
function CredentialsForm({
  submitLabel,
  passwordAutocomplete,
  onSubmit,
}: {
  submitLabel: string;
  passwordAutocomplete: "new-password" | "current-password";
  onSubmit: (body: SignUpRequest | SignInRequest) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ email: email.trim(), password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="profile-form" onSubmit={submit}>
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required />
      </label>
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={passwordAutocomplete}
          minLength={passwordAutocomplete === "new-password" ? PASSWORD_MIN : undefined}
          required
        />
        {passwordAutocomplete === "new-password" && <span className="muted small">At least {PASSWORD_MIN} characters. There is no password reset yet, so keep it somewhere safe.</span>}
      </label>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? "One moment..." : submitLabel}
      </button>
    </form>
  );
}

/**
 * Sign up = add an email + password to the profile on this device. A brand-new
 * visitor first gets the usual name + avatar form (RequireUser), so nothing is
 * lost and nobody fills in a password before they have played.
 */
export function SignUpPage() {
  const { user, signUp } = useUser();
  const navigate = useNavigate();
  return (
    <main className="page narrow">
      <h1>Create an account</h1>
      <RequireUser>
        {user?.email ? (
          <Navigate to="/me" replace />
        ) : (
          user && (
            <>
              <div className="notice">
                <p>
                  <strong>Why an account?</strong>
                </p>
                <ul className="small muted why-list">
                  <li>Use your decks, playmats and friends on another phone or computer.</li>
                  <li>Keep them safe if this device is lost or the browser is cleared.</li>
                  <li>See which devices are signed in and sign any of them out.</li>
                </ul>
                <p className="muted small">Your profile, decks and table look stay exactly as they are; nothing moves.</p>
              </div>
              <div className="account-who">
                <Avatar avatar={user.avatar} color={user.color} size={40} />
                <span>
                  Adding an account to <strong>{user.displayName}</strong>
                </span>
              </div>
              <SignUpForm
                onSubmit={async (body) => {
                  await signUp(body);
                  navigate("/me");
                }}
              />
              <p className="muted small">
                Already have an account? <Link to="/signin">Sign in instead</Link>
              </p>
            </>
          )
        )}
      </RequireUser>
    </main>
  );
}

/** Sign in to an existing account from this device, replacing whatever profile the device had. */
export function SignInPage() {
  const { user, loading, signIn } = useUser();
  const navigate = useNavigate();
  if (loading) return <main className="page narrow">Loading...</main>;
  if (user?.email) return <Navigate to="/me" replace />;
  const deviceProfile = user && !user.email ? user : null;
  return (
    <main className="page narrow">
      <h1>Sign in</h1>
      {deviceProfile && (
        <div className="notice">
          <p>
            This device is currently <strong>{deviceProfile.displayName}</strong>, a profile with no account. Signing in replaces it on
            this device. Its decks stay on the server under that profile, so if you want to keep them, go back and{" "}
            <Link to="/signup">add an email and password to {deviceProfile.displayName}</Link> instead.
          </p>
        </div>
      )}
      <CredentialsForm
        submitLabel="Sign in"
        passwordAutocomplete="current-password"
        onSubmit={async (body) => {
          if (deviceProfile && !confirm(`Replace "${deviceProfile.displayName}" on this device with your account? Its decks stay on the server under that profile.`)) return;
          await signIn(body);
          navigate("/");
        }}
      />
      <p className="muted small">
        No account yet? <Link to="/signup">Create one</Link>
        {!deviceProfile && (
          <>
            {" "}
            or <Link to="/">just pick a name and play</Link>
          </>
        )}
      </p>
    </main>
  );
}
