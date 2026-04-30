/**
 * WebUIBus — event bus that bridges the core engine and the WebSocket server.
 *
 * The REPL emits events here; the WS server subscribes and relays them to
 * browser clients. Browser input arrives via WS → bus → REPL.
 *
 * Singleton so any module can import and use it without prop-drilling.
 */

import { EventEmitter } from "node:events";

export type WebUIEvent =
  | { type: "delta"; delta: string }
  | { type: "message"; message: { role: string; content: string; replaceLast?: boolean; [k: string]: unknown } }
  | { type: "stream_mode"; mode: string }
  | { type: "tool_use"; toolName: string; toolUseId: string; status: string; input?: unknown; output?: unknown }
  | {
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

export type WebUIUserInput = {
  type: "user_input";
  text: string;
};

class WebUIBus extends EventEmitter {
  private _enabled = false;

  get enabled() {
    return this._enabled;
  }

  enable() {
    this._enabled = true;
  }

  /** Emit an event to all WS clients (no-op if not enabled). */
  emitToWeb(event: WebUIEvent) {
    if (!this._enabled) return;
    this.emit("web:event", event);
  }

  /** Called by WS server when browser sends user input. */
  emitUserInput(input: WebUIUserInput) {
    if (!this._enabled) return;
    this.emit("web:user_input", input);
  }

  onWebEvent(handler: (event: WebUIEvent) => void) {
    this.on("web:event", handler);
    return () => { this.off("web:event", handler); };
  }

  onUserInput(handler: (input: WebUIUserInput) => void) {
    this.on("web:user_input", handler);
    return () => { this.off("web:user_input", handler); };
  }
}

export const webUIBus = new WebUIBus();
