import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { PASSWORD_MIN, type SignInRequest, type SignUpRequest } from "@cgwf/shared";
import { Avatar } from "../components/Avatar";
import { RequireUser } from "../components/RequireUser";
import { useUser } from "../user";

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
              <p className="muted">
                Your profile, decks and table look stay exactly as they are. An email and password just let you sign in to them from
                another phone or computer.
              </p>
              <div className="account-who">
                <Avatar avatar={user.avatar} color={user.color} size={40} />
                <span>
                  Adding an account to <strong>{user.displayName}</strong>
                </span>
              </div>
              <CredentialsForm
                submitLabel="Create account"
                passwordAutocomplete="new-password"
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
