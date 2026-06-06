export type BrowserRole = "user" | "assistant" | "system";

export type BrowserMessage = {
  id: string;
  role: BrowserRole;
  content: string;
  sdkType?: string;
  sdkSubtype?: string;
};

export type AppAbortState =
  | { status: "idle" }
  | { status: "requested"; reason?: string }
  | { status: "aborted"; reason?: string };

export type AppBrowserEvent =
  | { type: "message.append"; message: BrowserMessage }
  | { type: "message.replace"; message: BrowserMessage }
  | { type: "message.delta"; id?: string; delta: string }
  | {
      type: "status.update";
      connected?: boolean;
      inputEnabled?: boolean;
      activeTurn?: boolean;
      model?: string;
      effort?: string;
      contextTokens?: number;
      notice?: string;
    }
  | { type: "goal.snapshot"; snapshot: unknown }
  | { type: "permission.requested"; request: AppPermissionRequest }
  | { type: "permission.resolved"; requestId: string; response: unknown }
  | { type: "abort.status"; abort: AppAbortState };

export type AppServerMessage =
  | {
      type: "app.ready";
      protocolVersion: 1;
      inputEnabled: boolean;
      abort: AppAbortState;
      goalSnapshot: unknown;
      pendingPermissionRequests: AppPermissionRequest[];
    }
  | { type: "app.event"; event: AppBrowserEvent }
  | { type: "app.ack"; requestId: string }
  | {
      type: "app.error";
      requestId?: string;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { type: "app.pong"; nonce: string };

export type AppPermissionRequest = {
  requestId: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: unknown[];
    blocked_path?: string;
    decision_reason?: string;
    title?: string;
    display_name?: string;
    tool_use_id: string;
    agent_id?: string;
    description?: string;
  };
};

export type AppClientMessage =
  | {
      type: "app.submit";
      requestId: string;
      prompt: string;
      options?: {
        uuid?: string;
        isMeta?: boolean;
        goalSnapshot?: unknown;
      };
    }
  | { type: "app.abort"; requestId: string; reason?: string }
  | {
      type: "permission.response";
      requestId: string;
      response:
        | {
            behavior: "allow";
            updatedInput: Record<string, unknown>;
            updatedPermissions?: unknown[];
            toolUseID?: string;
            decisionClassification?:
              | "user_temporary"
              | "user_permanent"
              | "user_reject";
          }
        | {
            behavior: "deny";
            message: string;
            interrupt?: boolean;
            toolUseID?: string;
            decisionClassification?:
              | "user_temporary"
              | "user_permanent"
              | "user_reject";
          };
    }
  | { type: "app.ping"; nonce: string };
