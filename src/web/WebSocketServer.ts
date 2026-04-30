/**
 * WebSocket server for the Cat Code web UI.
 *
 * Listens on port 3456, relays engine events to browser clients,
 * and forwards browser input back to the engine via WebUIBus.
 */

import { WebSocketServer as WSServer, type WebSocket } from "ws";
import { webUIBus, type WebUIEvent } from "./WebUIBus.js";

const WEB_UI_PORT = 3456;

let server: WSServer | null = null;

export function startWebUIServer(): { port: number } {
  if (server) return { port: WEB_UI_PORT };

  webUIBus.enable();

  server = new WSServer({ port: WEB_UI_PORT, path: "/ws" });
  server.on("error", (error) => {
    // biome-ignore lint/suspicious/noConsole:: intentional startup diagnostics
    console.error(`[web] Web UI server error: ${error instanceof Error ? error.message : String(error)}`);
  });
  server.on("listening", () => {
    // biome-ignore lint/suspicious/noConsole:: intentional startup diagnostics
    console.log(`[web] Web UI server bound to port ${WEB_UI_PORT}`);
  });

  const clients = new Set<WebSocket>();

  server.on("connection", (ws) => {
    clients.add(ws);

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(String(raw));
        if (data.type === "user_input" && typeof data.text === "string") {
          webUIBus.emitUserInput(data);
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", () => {
      clients.delete(ws);
    });

    // Send a welcome status so the frontend knows it's connected.
    ws.send(JSON.stringify({
      type: "status",
      connected: true,
      reconnecting: false,
      inputEnabled: false,
      notice: "Web mode is browser-first now, but the backend still depends on the terminal REPL path. Sending is intentionally disabled until that backend path is split out.",
    }));
  });

  // Relay engine events to all connected clients
  webUIBus.onWebEvent((event: WebUIEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  });

  return { port: WEB_UI_PORT };
}

export function stopWebUIServer() {
  if (server) {
    server.close();
    server = null;
  }
}
