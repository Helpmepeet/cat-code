import { useCallback, useEffect, useRef, useState } from "react";
import type { AppClientMessage, AppServerMessage } from "../appProtocol";

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

function getWebSocketProtocols() {
  const token = import.meta.env.VITE_CAT_CODE_WS_TOKEN as string | undefined;
  return token ? [`cat-code.${token}`] : undefined;
}

const RECONNECT_INITIAL_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Backs off exponentially so a tab whose backend has gone away (e.g. the
// cat-code session exited but the dev server kept serving the page) doesn't
// retry every 1.5s forever.
export function getReconnectDelayMs(failedAttempts: number): number {
  return Math.min(
    RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, failedAttempts),
    RECONNECT_MAX_DELAY_MS,
  );
}

export function useWebSocket(onMessage: (data: AppServerMessage) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(true);
  const [lastError, setLastError] = useState<string | undefined>();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const failedAttemptsRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let closedByCleanup = false;

    function connect(initial = false) {
      if (!initial) {
        setReconnecting(true);
      }

      const ws = new WebSocket(getWebSocketUrl(), getWebSocketProtocols());
      wsRef.current = ws;

      ws.onopen = () => {
        failedAttemptsRef.current = 0;
        setConnected(true);
        setReconnecting(false);
        setLastError(undefined);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as AppServerMessage;
          onMessageRef.current(data);
        } catch {
          setLastError("Received an invalid server message.");
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closedByCleanup) return;
        setReconnecting(true);
        const delay = getReconnectDelayMs(failedAttemptsRef.current);
        failedAttemptsRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(() => connect(), delay);
      };

      ws.onerror = () => {
        setLastError("WebSocket connection failed.");
        ws.close();
      };
    }

    connect(true);

    return () => {
      closedByCleanup = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((data: AppClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, connected, reconnecting, lastError };
}
