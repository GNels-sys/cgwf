import type { ReactNode } from "react";
import { ProfileForm } from "./ProfileForm";
import { useUser } from "../user";

/** Gate for pages that need an identity: shows the first-run profile form instead. */
export function RequireUser({ children }: { children: ReactNode }) {
  const { user, loading, register } = useUser();
  if (loading) return <p className="muted">Loading...</p>;
  if (user) return <>{children}</>;
  return (
    <section className="welcome">
      <h2>Welcome to the table</h2>
      <p className="muted">Pick a name and an avatar. This device remembers you; no password needed.</p>
      <ProfileForm submitLabel="Start" onSubmit={register} />
    </section>
  );
}
