import type {
  CardResponse,
  CreateDeckRequest,
  CreateRoomResponse,
  DeckAnalysisResponse,
  MyRoomsResponse,
  RoomResponse,
  DeckDetail,
  DeckSummary,
  ImportUrlResponse,
  RegisterRequest,
  RegisterResponse,
  ResolveResponse,
  SearchResponse,
  StatusResponse,
  TokenSearchResponse,
  UploadInfo,
  UploadKind,
  User,
  UserSettings,
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

const blobCache = new Map<string, Promise<string | null>>();

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
    analysis: (id: string, refresh = false) => request<DeckAnalysisResponse>(`/api/decks/${encodeURIComponent(id)}/analysis${refresh ? "?refresh=1" : ""}`),
    importUrl: (url: string) => request<ImportUrlResponse>(`/api/decks/import-url?url=${encodeURIComponent(url)}`),
  },

  tokens: (q: string, signal?: AbortSignal) => request<TokenSearchResponse>(`/api/tokens?q=${encodeURIComponent(q)}`, { ...(signal ? { signal } : {}) }),

  settings: {
    get: () => request<{ settings: UserSettings }>("/api/me/settings"),
    save: (patch: unknown) => request<{ settings: UserSettings }>("/api/me/settings", { method: "PUT", json: patch }),
  },

  uploads: {
    list: () => request<{ uploads: UploadInfo[] }>("/api/uploads"),
    remove: (id: string) => request<{ ok: true }>(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    /** Raw image body; the server checks the bytes and the 2 MB limit. */
    async create(kind: UploadKind, file: File): Promise<UploadInfo> {
      const headers: Record<string, string> = { Accept: "application/json", "Content-Type": file.type || "application/octet-stream" };
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`/api/uploads?kind=${kind}`, { method: "POST", headers, body: file });
      if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
          message = ((await res.json()) as { error?: string }).error ?? message;
        } catch {
          /* non-JSON */
        }
        throw new ApiError(res.status, message);
      }
      return ((await res.json()) as { upload: UploadInfo }).upload;
    },
    /** Fetch a private upload with the device token and hand back a blob: URL (cached per id). */
    async blobUrl(id: string): Promise<string | null> {
      const cached = blobCache.get(id);
      if (cached) return cached;
      const job = (async () => {
        const headers: Record<string, string> = {};
        const token = getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { headers });
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      })();
      blobCache.set(id, job);
      const url = await job;
      if (!url) blobCache.delete(id);
      return url;
    },
  },

  rooms: {
    create: () => request<CreateRoomResponse>("/api/rooms", { method: "POST", json: {} }),
    get: (code: string) => request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}`),
    join: (code: string) => request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST", json: {} }),
    mine: () => request<MyRoomsResponse>("/api/rooms/mine"),
    decks: () => request<{ decks: Array<{ id: string; name: string; commanders: string[] }> }>("/api/rooms/decks"),
  },
};
