import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { isOwner, useUser } from "../user";

/**
 * AI Coach is OWNER ONLY and only when the server enables it: everyone else never sees a trace of it.
 * The server answers /api/coach/status with 404 (off) or 403 (not the owner); only a 200 shows the UI.
 */
let cached: boolean | null = null;
export function useCoachEnabled(): boolean {
  const { user } = useUser();
  const owner = isOwner(user);
  const [on, setOn] = useState<boolean>(owner && cached === true);
  useEffect(() => {
    if (!owner) {
      setOn(false);
      return;
    }
    if (cached !== null) {
      setOn(cached);
      return;
    }
    let live = true;
    api.coach
      .status()
      .then(() => {
        cached = true;
        if (live) setOn(true);
      })
      .catch(() => {
        cached = false;
        if (live) setOn(false);
      });
    return () => {
      live = false;
    };
  }, [owner]);
  return on;
}

/** "Coach me" link to a game's coach report (rendered only for the owner with the coach on). */
export function CoachLink({ code, className = "btn btn-small", children = "Coach me" }: { code: string; className?: string; children?: React.ReactNode }) {
  const on = useCoachEnabled();
  if (!on) return null;
  return (
    <Link className={`${className} coach-link`} to={`/coach/${code}`}>
      {children}
    </Link>
  );
}
