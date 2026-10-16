import type {
  CardResponse,
  CreateDeckRequest,
  DeckDetail,
  DeckSummary,
  ImportUrlResponse,
  RegisterRequest,
  RegisterResponse,
  ResolveResponse,
  SearchResponse,
  StatusResponse,
  User,
} from "@cgwf/shared";

const TOKEN_KEY = "cgwf.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session simply will not persist */
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Options {
  method?: string;
  json?: unknown;
  signal?: AbortSignal;
}

async function request<T>(url: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"), headers };
  if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(url, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  status: (signal?: AbortSignal) => request<StatusResponse>("/api/status", { ...(signal ? { signal } : {}) }),
  search: (q: string, tokens: boolean, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/cards/search?q=${encodeURIComponent(q)}&tokens=${tokens ? 1 : 0}&limit=40`, { ...(signal ? { signal } : {}) }),
  card: (id: string, signal?: AbortSignal) => request<CardResponse>(`/api/cards/${encodeURIComponent(id)}`, { ...(signal ? { signal } : {}) }),

  register: (body: RegisterRequest) => request<RegisterResponse>("/api/me/register", { json: body }),
  me: () => request<{ user: User }>("/api/me"),
  updateMe: (body: Partial<RegisterRequest>) => request<{ user: User }>("/api/me", { method: "PATCH", json: body }),

  decks: {
    list: () => request<{ decks: DeckSummary[] }>("/api/decks"),
    get: (id: string) => request<{ deck: DeckDetail }>(`/api/decks/${encodeURIComponent(id)}`),
    create: (body: CreateDeckRequest) => request<{ deck: DeckDetail }>("/api/decks", { json: body }),
    rename: (id: string, name: string) => request<{ deck: DeckDetail }>(`/api/decks/${encodeURIComponent(id)}`, { method: "PATCH", json: { name } }),
    remove: (id: string) => request<{ ok: true }>(`/api/decks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    parse: (text: string) => request<ResolveResponse>("/api/decks/parse", { json: { text } }),
    importUrl: (url: string) => request<ImportUrlResponse>(`/api/decks/import-url?url=${encodeURIComponent(url)}`),
  },
};
