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

export function useWebSocket(onMessage: (data: AppServerMessage) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(true);
  const [lastError, setLastError] = useState<string | undefined>();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
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
        reconnectTimerRef.current = window.setTimeout(() => connect(), 1500);
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
