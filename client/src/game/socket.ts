import { useCallback, useEffect, useRef, useState } from "react";
import type { CardPrinting, ClientMessage, EngineNotice, EventInput, PlayerView, RoomInfo, ServerMessage } from "@cgwf/shared";
import { getToken } from "../api";

/**
 * One WebSocket per open table. Reconnects with backoff whenever the socket
 * drops (phone sleeps, network blips); the server replays the log and sends a
 * fresh view, so nothing is lost. Printings arrive once per connection and are
 * merged into a local catalogue keyed by printing id.
 */

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface RoomSocket {
  status: ConnectionStatus;
  room: RoomInfo | null;
  view: PlayerView | null;
  printings: Record<string, CardPrinting>;
  /** Last server error, cleared automatically after a few seconds. */
  error: string | null;
  /** Engine tables: cards revealed to me / values Forge announced, oldest first, until dismissed. */
  notices: EngineNotice[];
  dismissNotice: (id: number) => void;
  send: (msg: ClientMessage) => void;
  dispatch: (event: EventInput) => void;
  leave: () => void;
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export function useRoomSocket(code: string | null): RoomSocket {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<EngineNotice[]>([]);
  const printingsRef = useRef<Record<string, CardPrinting>>({});
  const [printings, setPrintings] = useState<Record<string, CardPrinting>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!code) return;
    closedRef.current = false;
    attemptRef.current = 0;

    const connect = () => {
      if (closedRef.current) return;
      const token = getToken();
      if (!token) {
        setStatus("closed");
        return;
      }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(code)}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        attemptRef.current = 0;
        setStatus("open");
      };
      ws.onmessage = (e) => {
        if (wsRef.current !== ws) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(e.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.t) {
          case "room":
            setRoom(msg.room);
            break;
          case "state": {
            const next = Object.keys(msg.printings).length ? { ...printingsRef.current, ...msg.printings } : printingsRef.current;
            printingsRef.current = next;
            setPrintings(next);
            setView(msg.view);
            break;
          }
          case "error":
            setError(msg.message);
            if (errorTimer.current) window.clearTimeout(errorTimer.current);
            errorTimer.current = window.setTimeout(() => setError(null), 4000);
            break;
          case "notice": {
            if (Object.keys(msg.printings).length) {
              const next = { ...printingsRef.current, ...msg.printings };
              printingsRef.current = next;
              setPrintings(next);
            }
            const n = msg.notice;
            setNotices((prev) => [...prev, n].slice(-12));
            break;
          }
          case "pong":
            break;
        }
      };
      ws.onclose = (e) => {
        // A socket we already replaced (navigating from one table straight to another, e.g. a
        // rematch) must not touch the new one when its close event arrives late.
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (closedRef.current || e.code === 4001 || e.code === 1000) {
          setStatus("closed");
          return;
        }
        // The server forgets what it sent on this socket, so start the catalogue over.
        printingsRef.current = {};
        const delay = RETRY_MS[Math.min(attemptRef.current, RETRY_MS.length - 1)]!;
        attemptRef.current++;
        setStatus("reconnecting");
        timerRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    };
    connect();

    // Keep the socket warm through proxies, and reconnect promptly when the tab wakes up.
    const ping = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: "ping" }));
    }, 25_000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && !wsRef.current && !closedRef.current) {
        if (timerRef.current) window.clearTimeout(timerRef.current);
        attemptRef.current = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      closedRef.current = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.clearInterval(ping);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      wsRef.current?.close(1000, "navigated away");
      wsRef.current = null;
      // Start the next table with a clean slate (the server sends its printings afresh).
      printingsRef.current = {};
      setPrintings({});
      setView(null);
      setRoom(null);
      setError(null);
    };
  }, [code]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Not connected; reconnecting...");
      return;
    }
    ws.send(JSON.stringify(msg));
  }, []);

  const dispatch = useCallback((event: EventInput) => send({ t: "event", event }), [send]);
  const leave = useCallback(() => {
    send({ t: "leave" });
    closedRef.current = true;
  }, [send]);

  const dismissNotice = useCallback((id: number) => setNotices((prev) => prev.filter((n) => n.id !== id)), []);

  return { status, room, view, printings, error, notices, dismissNotice, send, dispatch, leave };
}
