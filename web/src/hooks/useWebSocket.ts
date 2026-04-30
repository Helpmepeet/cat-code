import { useCallback, useEffect, useRef, useState } from "react";

type IncomingMessage = {
  type: "message";
  message?: {
    role: "user" | "assistant" | "system";
    content?: string;
    replaceLast?: boolean;
  };
};

type IncomingDelta = {
  type: "delta";
  delta?: string;
};

type IncomingStatus = {
  type: "status";
  connected: boolean;
  reconnecting?: boolean;
  model?: string;
  effort?: string;
  contextTokens?: number;
  activeProfile?: string;
  inputEnabled?: boolean;
  notice?: string;
};

export type WebUIIncomingEvent = IncomingMessage | IncomingDelta | IncomingStatus;

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

export function useWebSocket(onMessage: (data: WebUIIncomingEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(true);
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

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WebUIIncomingEvent;
          onMessageRef.current(data);
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closedByCleanup) return;
        setReconnecting(true);
        reconnectTimerRef.current = window.setTimeout(() => connect(), 1500);
      };

      ws.onerror = () => {
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

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, connected, reconnecting };
}
