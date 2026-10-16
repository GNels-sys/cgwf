import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RegisterRequest, User } from "@cgwf/shared";
import { api, ApiError, getToken, setToken } from "./api";

/**
 * Device identity. The token lives in localStorage; the user record comes
 * from the server. No passwords in v1 (see users table for the later upgrade).
 */
interface UserState {
  user: User | null;
  /** True until the first /api/me round trip settles. */
  loading: boolean;
  register: (body: RegisterRequest) => Promise<void>;
  update: (body: Partial<RegisterRequest>) => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<UserState | null>(null);

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    api
      .me()
      .then((r) => {
        if (!cancelled) setUser(r.user);
      })
      .catch((e: unknown) => {
        // A 401 means the token is dead (server reset); anything else keeps the token for a retry.
        if (e instanceof ApiError && e.status === 401) setToken(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async (body: RegisterRequest) => {
    const r = await api.register(body);
    setToken(r.token);
    setUser(r.user);
  }, []);

  const update = useCallback(async (body: Partial<RegisterRequest>) => {
    const r = await api.updateMe(body);
    setUser(r.user);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, loading, register, update, signOut }), [user, loading, register, update, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Owner check for admin-only UI (the server enforces it; this only hides links).
 * Phase 5 adds `isOwner` to the shared User type; until that merge the field is read loosely.
 */
export function isOwner(user: User | null): boolean {
  return Boolean(user && (user as { isOwner?: boolean }).isOwner);
}

export function useUser(): UserState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUser outside UserProvider");
  return v;
}
