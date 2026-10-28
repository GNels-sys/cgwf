import { NavLink } from "react-router-dom";
import { Avatar } from "./Avatar";
import { Bell } from "./Bell";
import { isOwner, useUser } from "../user";

export function Header() {
  const { user } = useUser();
  const owner = isOwner(user);
  return (
    <header className="top-nav">
      <NavLink to="/" className="brand">
        <span className="brand-mark" aria-hidden="true">◇</span> CGwF
      </NavLink>
      <nav>
        <NavLink to="/" end>
          Decks
        </NavLink>
        <NavLink to="/cards">Cards</NavLink>
        <NavLink to="/play">Play</NavLink>
        {user && <NavLink to="/friends">Friends</NavLink>}
        {user && <NavLink to="/players">Players</NavLink>}
        {user && <NavLink to="/stats">Stats</NavLink>}
        {user && <NavLink to="/stores">Stores</NavLink>}
        {user && <NavLink to="/settings">Personalize</NavLink>}
        {owner && <NavLink to="/admin/library">Library</NavLink>}
        {owner && <NavLink to="/admin/agents">Agents</NavLink>}
        {owner && (
          <NavLink to="/admin" end>
            Admin
          </NavLink>
        )}
      </nav>
      {user && <Bell />}
      <NavLink to="/me" className={`nav-user${user ? "" : " is-start"}`} aria-label="Your profile">
        {user ? (
          <>
            <Avatar avatar={user.avatar} color={user.color} size={32} />
            <span className="nav-user-name">{user.displayName}</span>
          </>
        ) : (
          <span className="nav-user-name">Start</span>
        )}
      </NavLink>
    </header>
  );
}
