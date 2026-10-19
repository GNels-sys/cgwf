import type {
  AdminOpenTable,
  DeckPerformance,
  DeckStatsListResponse,
  DeckOptionsResponse,
  AddAgentsResponse,
  AdminStatsQuery,
  AdminStatsResponse,
  AdminUserDetail,
  AgentGamesResponse,
  AgentsStatus,
  CardAvailabilityResponse,
  CardResponse,
  DraftPrimerResponse,
  RoomAgentsResponse,
  ChangePasswordRequest,
  CreateDeckRequest,
  CreateRoomRequest,
  CreateRoomResponse,
  FeaturesResponse,
  DeckAnalysisResponse,
  DeckStatsResponse,
  MyRoomsResponse,
  RoomResponse,
  DeckDetail,
  DeckSummary,
  FriendsResponse,
  NotificationsResponse,
  PublicProfile,
  RoomInviteInfo,
  SubmissionInfo,
  ImportUrlResponse,
  LibraryDeckDetail,
  LibraryImportState,
  LibraryListResponse,
  LibraryPatchRequest,
  RegisterRequest,
  RegisterResponse,
  ResolveResponse,
  SearchResponse,
  SessionInfo,
  ShoppingReport,
  SignInRequest,
  SignUpRequest,
  StatusResponse,
  StoresResponse,
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

  auth: {
    /** Add an email + password to the current device profile. */
    signUp: (body: SignUpRequest) => request<{ user: User }>("/api/auth/signup", { json: body }),
    /** Open a new session for an existing account; the token replaces this device's identity. */
    signIn: (body: SignInRequest) => request<RegisterResponse>("/api/auth/signin", { json: body }),
    changePassword: (body: ChangePasswordRequest) => request<{ ok: true }>("/api/auth/password", { json: body }),
    sessions: () => request<{ sessions: SessionInfo[] }>("/api/me/sessions"),
    signOutSession: (id: string) => request<{ ok: true }>(`/api/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    signOutEverywhere: () => request<{ ok: true }>("/api/me/sessions", { method: "DELETE" }),
    claimOwner: (code: string) => request<{ user: User }>("/api/me/owner-claim", { json: { code } }),
  },

  decks: {
    list: () => request<{ decks: DeckSummary[] }>("/api/decks"),
    get: (id: string) => request<{ deck: DeckDetail }>(`/api/decks/${encodeURIComponent(id)}`),
    create: (body: CreateDeckRequest) => request<{ deck: DeckDetail }>("/api/decks", { json: body }),
    rename: (id: string, name: string) => request<{ deck: DeckDetail }>(`/api/decks/${encodeURIComponent(id)}`, { method: "PATCH", json: { name } }),
    remove: (id: string) => request<{ ok: true }>(`/api/decks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    parse: (text: string) => request<ResolveResponse>("/api/decks/parse", { json: { text } }),
    analysis: (id: string, refresh = false) => request<DeckAnalysisResponse>(`/api/decks/${encodeURIComponent(id)}/analysis${refresh ? "?refresh=1" : ""}`),
    stats: (id: string) => request<DeckStatsResponse>(`/api/decks/${encodeURIComponent(id)}/stats`),
    importUrl: (url: string) => request<ImportUrlResponse>(`/api/decks/import-url?url=${encodeURIComponent(url)}`),
  },

  /** Owner-only deck library (Phase 6). */
  library: {
    list: (filters: { bracket?: number; tag?: string; q?: string; source?: string; agent?: string } = {}) => {
      const qs = Object.entries(filters)
        .filter(([, v]) => v !== undefined && v !== "" && v !== 0)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join("&");
      return request<LibraryListResponse>(`/api/library${qs ? `?${qs}` : ""}`);
    },
    importStatus: () => request<{ importState: LibraryImportState }>("/api/library/import-status"),
    importPrecons: (opts: { force?: boolean; combos?: boolean } = {}) => request<{ started: boolean; importState: LibraryImportState }>("/api/library/import-precons", { json: opts }),
    fromDeck: (deckId: string) => request<{ deck: LibraryDeckDetail }>(`/api/library/from-deck/${encodeURIComponent(deckId)}`, { json: {} }),
    get: (id: string) => request<{ deck: LibraryDeckDetail }>(`/api/library/${encodeURIComponent(id)}`),
    stats: (id: string) => request<DeckStatsResponse>(`/api/library/${encodeURIComponent(id)}/stats`),
    patch: (id: string, body: LibraryPatchRequest) => request<{ deck: LibraryDeckDetail }>(`/api/library/${encodeURIComponent(id)}`, { method: "PATCH", json: body }),
    remove: (id: string) => request<{ ok: true }>(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" }),
    analyze: (id: string) => request<{ deck: LibraryDeckDetail }>(`/api/library/${encodeURIComponent(id)}/analyze`, { method: "POST", json: {} }),
    primerSkeleton: (id: string) => request<{ primer: string }>(`/api/library/${encodeURIComponent(id)}/primer-skeleton`),
    draftPrimer: (id: string, force = false) => request<DraftPrimerResponse>(`/api/library/${encodeURIComponent(id)}/draft-primer`, { json: { force } }),
  },

  /** Phase 7 computer opponents (owner only, AGENTS_ENABLED=1). */
  agents: {
    status: () => request<AgentsStatus>("/api/agents/status"),
    games: () => request<AgentGamesResponse>("/api/agents/games"),
    add: (code: string, body: { count: number; bracket: number }) => request<AddAgentsResponse>(`/api/rooms/${encodeURIComponent(code)}/agents`, { json: body }),
    remove: (code: string) => request<{ removed: number }>(`/api/rooms/${encodeURIComponent(code)}/agents`, { method: "DELETE" }),
    room: (code: string) => request<RoomAgentsResponse>(`/api/rooms/${encodeURIComponent(code)}/agents`),
    draftPrimer: (libraryDeckId: string, force = false) => request<DraftPrimerResponse>(`/api/library/${encodeURIComponent(libraryDeckId)}/draft-primer`, { json: { force } }),
  },

  /** Owner-only platform overview (who is on the platform, who is using it). */
  admin: {
    stats: (query: AdminStatsQuery & { refresh?: boolean } = {}, signal?: AbortSignal) => {
      const qs = new URLSearchParams();
      if (query.sort) qs.set("sort", query.sort);
      if (query.q) qs.set("q", query.q);
      if (query.limit) qs.set("limit", String(query.limit));
      if (query.refresh) qs.set("refresh", "1");
      const s = qs.toString();
      return request<AdminStatsResponse>(`/api/admin/stats${s ? `?${s}` : ""}`, { ...(signal ? { signal } : {}) });
    },
    user: (id: string) => request<AdminUserDetail>(`/api/admin/users/${encodeURIComponent(id)}`),
    tables: () => request<{ tables: AdminOpenTable[] }>("/api/admin/tables"),
    closeTable: (code: string) => request<{ closed: boolean }>(`/api/admin/tables/${encodeURIComponent(code)}/close`, { method: "POST", json: {} }),
    closeIdle: (hours: number) => request<{ open: number; closed: number; codes: string[] }>("/api/admin/tables/close-idle", { method: "POST", json: { hours } }),
  },

  /** Phase 8: friends, invites, the bell and the agent deck queue. */
  social: {
    friends: () => request<FriendsResponse>("/api/friends"),
    friendCode: () => request<{ code: string }>("/api/me/friend-code"),
    sendRequest: (code: string) => request<{ outcome: "sent" | "accepted"; user: PublicProfile }>("/api/friends/requests", { json: { code } }),
    acceptRequest: (id: string) => request<{ friend: PublicProfile }>(`/api/friends/requests/${encodeURIComponent(id)}/accept`, { method: "POST", json: {} }),
    declineRequest: (id: string) => request<{ ok: true }>(`/api/friends/requests/${encodeURIComponent(id)}/decline`, { method: "POST", json: {} }),
    cancelRequest: (id: string) => request<{ ok: true }>(`/api/friends/requests/${encodeURIComponent(id)}/cancel`, { method: "POST", json: {} }),
    removeFriend: (userId: string) => request<{ ok: true }>(`/api/friends/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    notifications: (signal?: AbortSignal) => request<NotificationsResponse>("/api/notifications", { ...(signal ? { signal } : {}) }),
    markRead: (ids?: string[]) => request<{ ok: true }>("/api/notifications/read", { json: ids ? { ids } : {} }),
    invite: (code: string, userIds: string[]) => request<{ invites: RoomInviteInfo[] }>(`/api/rooms/${encodeURIComponent(code)}/invites`, { json: { userIds } }),
    roomInvites: (code: string) => request<{ invites: RoomInviteInfo[] }>(`/api/rooms/${encodeURIComponent(code)}/invites`),
    myInvites: () => request<{ invites: RoomInviteInfo[] }>("/api/invites"),
    acceptInvite: (id: string) => request<{ code: string; seated: boolean }>(`/api/invites/${encodeURIComponent(id)}/accept`, { method: "POST", json: {} }),
    declineInvite: (id: string) => request<{ ok: true }>(`/api/invites/${encodeURIComponent(id)}/decline`, { method: "POST", json: {} }),
    submitDeck: (deckId: string, note: string) => request<{ submission: SubmissionInfo }>(`/api/decks/${encodeURIComponent(deckId)}/submit`, { json: { note } }),
    deckSubmission: (deckId: string) => request<{ submission: SubmissionInfo | null }>(`/api/decks/${encodeURIComponent(deckId)}/submission`),
    withdraw: (id: string) => request<{ ok: true }>(`/api/submissions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    queue: () => request<{ submissions: SubmissionInfo[] }>("/api/library/submissions"),
    approve: (id: string) => request<{ submission: SubmissionInfo }>(`/api/library/submissions/${encodeURIComponent(id)}/approve`, { method: "POST", json: {} }),
    reject: (id: string, reason: string) => request<{ submission: SubmissionInfo }>(`/api/library/submissions/${encodeURIComponent(id)}/reject`, { json: { reason } }),
  },

  /** Phase 10 local stores bridge: read-only, signed-in; every link in an answer leaves CGwF. */
  singles: {
    availability: (cardId: string, signal?: AbortSignal) =>
      request<CardAvailabilityResponse>(`/api/cards/${encodeURIComponent(cardId)}/availability`, { ...(signal ? { signal } : {}) }),
    deckShopping: (deckId: string, signal?: AbortSignal) => request<ShoppingReport>(`/api/decks/${encodeURIComponent(deckId)}/shopping`, { ...(signal ? { signal } : {}) }),
    libraryShopping: (id: string, signal?: AbortSignal) => request<ShoppingReport>(`/api/library/${encodeURIComponent(id)}/shopping`, { ...(signal ? { signal } : {}) }),
    stores: (signal?: AbortSignal) => request<StoresResponse>("/api/stores", { ...(signal ? { signal } : {}) }),
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

  features: () => request<FeaturesResponse>("/api/features"),
  /** Deck statistics from counted rules-engine games (personal decks: owner only; library decks: everyone). */
  deckStats: {
    list: (bots: boolean) => request<DeckStatsListResponse>(`/api/deck-stats${bots ? "" : "?bots=0"}`),
    deck: (ref: string, bots: boolean) => request<DeckPerformance>(`/api/deck-stats/deck/${encodeURIComponent(ref)}${bots ? "" : "?bots=0"}`),
  },
  rooms: {
    create: (opts: CreateRoomRequest = {}) => request<CreateRoomResponse>("/api/rooms", { method: "POST", json: opts }),
    get: (code: string) => request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}`),
    join: (code: string) => request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST", json: {} }),
    mine: () => request<MyRoomsResponse>("/api/rooms/mine"),
    /** Host (or owner): close a table without a result. */
    end: (code: string) => request<{ closed: boolean }>(`/api/rooms/${encodeURIComponent(code)}/end`, { method: "POST", json: {} }),
    decks: () => request<{ decks: Array<{ id: string; name: string; commanders: string[] }> }>("/api/rooms/decks"),
    /** The lobby deck picker: own decks OR the deck library, filtered by bracket (null = any), alphabetical. */
    deckOptions: (bracket: number | null) => request<DeckOptionsResponse>(`/api/rooms/deck-options${bracket ? `?bracket=${bracket}` : ""}`),
  },
};
