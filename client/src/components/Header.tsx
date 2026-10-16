import { NavLink } from "react-router-dom";
import { Avatar } from "./Avatar";
import { useUser } from "../user";

export function Header() {
  const { user } = useUser();
  return (
    <header className="top-nav">
      <NavLink to="/" className="brand">
        CGwF
      </NavLink>
      <nav>
        <NavLink to="/" end>
          Decks
        </NavLink>
        <NavLink to="/cards">Cards</NavLink>
      </nav>
      <NavLink to="/me" className="nav-user" aria-label="Your profile">
        {user ? (
          <>
            <Avatar avatar={user.avatar} color={user.color} size={32} />
            <span className="nav-user-name">{user.displayName}</span>
          </>
        ) : (
          <span className="nav-user-name">Sign in</span>
        )}
      </NavLink>
    </header>
  );
}
