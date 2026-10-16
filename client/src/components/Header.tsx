import { NavLink } from "react-router-dom";
import { Avatar } from "./Avatar";
import { isOwner, useUser } from "../user";

export function Header() {
  const { user } = useUser();
  const owner = isOwner(user);
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
        <NavLink to="/play">Play</NavLink>
        {owner && <NavLink to="/admin/library">Library</NavLink>}
        {owner && <NavLink to="/admin/agents">Agents</NavLink>}
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
