import type { CardResponse, SearchResponse, StatusResponse } from "@cgwf/shared";

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const api = {
  status: (signal?: AbortSignal) => getJson<StatusResponse>("/api/status", signal),
  search: (q: string, tokens: boolean, signal?: AbortSignal) =>
    getJson<SearchResponse>(`/api/cards/search?q=${encodeURIComponent(q)}&tokens=${tokens ? 1 : 0}&limit=40`, signal),
  card: (id: string, signal?: AbortSignal) => getJson<CardResponse>(`/api/cards/${encodeURIComponent(id)}`, signal),
};
