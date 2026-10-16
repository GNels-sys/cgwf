import { Link, useNavigate } from "react-router-dom";
import { ProfileForm } from "../components/ProfileForm";
import { RequireUser } from "../components/RequireUser";
import { useUser } from "../user";

export function ProfilePage() {
  const { user, update, signOut } = useUser();
  const navigate = useNavigate();
  return (
    <main className="page narrow">
      <h1>Your profile</h1>
      <RequireUser>
        {user && (
          <>
            <ProfileForm
              initial={{ displayName: user.displayName, avatar: user.avatar, color: user.color }}
              submitLabel="Save"
              onSubmit={async (body) => {
                await update(body);
                navigate("/");
              }}
            />
            <hr />
            <p>
              <Link to="/settings" className="btn">
                Personalize your table
              </Link>
              <span className="muted small"> &nbsp; playmat, sleeves, theme, layout</span>
            </p>
            <hr />
            <p className="muted small">
              Signing out forgets this device. Your decks stay on the server but you will not be able to reach them
              again without the device token, so only do this on a shared device you are leaving.
            </p>
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm("Forget this device? You will lose access to your decks.")) {
                  signOut();
                  navigate("/");
                }
              }}
            >
              Sign out on this device
            </button>
          </>
        )}
      </RequireUser>
    </main>
  );
}
