import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RegisterRequest, SignInRequest, SignUpRequest, User } from "@cgwf/shared";
import { api, ApiError, getToken, setToken } from "./api";

/**
 * Identity on this device. The session token lives in localStorage; the user
 * record comes from the server. A visitor starts as a device-only profile
 * (name + avatar); adding an email + password makes it an account that can
 * sign in elsewhere. Signing in here replaces this device's identity.
 */
interface UserState {
  user: User | null;
  /** True until the first /api/me round trip settles. */
  loading: boolean;
  register: (body: RegisterRequest) => Promise<void>;
  update: (body: Partial<RegisterRequest>) => Promise<void>;
  /** Add an email + password to the current profile (nothing else changes). */
  signUp: (body: SignUpRequest) => Promise<void>;
  /** Replace this device's identity with an existing account. */
  signIn: (body: SignInRequest) => Promise<void>;
  /** Sign out this device only (deletes its session on the server when it can). */
  signOut: () => Promise<void>;
  /** Sign out every device of this account, this one included. */
  signOutEverywhere: () => Promise<void>;
  /** Re-read /api/me (after an owner claim, for example). */
  refresh: () => Promise<void>;
  setUser: (user: User) => void;
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
        // A 401 means the token is dead (signed out elsewhere or server reset); anything else keeps the token for a retry.
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

  const signUp = useCallback(async (body: SignUpRequest) => {
    const r = await api.auth.signUp(body);
    setUser(r.user);
  }, []);

  const signIn = useCallback(async (body: SignInRequest) => {
    const r = await api.auth.signIn(body);
    setToken(r.token);
    setUser(r.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      const { sessions } = await api.auth.sessions();
      const current = sessions.find((s) => s.current);
      if (current) await api.auth.signOutSession(current.id);
    } catch {
      /* offline or already dead: forgetting the token is what matters */
    }
    setToken(null);
    setUser(null);
  }, []);

  const signOutEverywhere = useCallback(async () => {
    await api.auth.signOutEverywhere();
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const r = await api.me();
    setUser(r.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, register, update, signUp, signIn, signOut, signOutEverywhere, refresh, setUser }),
    [user, loading, register, update, signUp, signIn, signOut, signOutEverywhere, refresh],
  );
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
