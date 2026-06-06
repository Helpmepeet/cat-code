import type {
  AppAbortState,
  AppPermissionRequest,
  AppServerMessage,
  BrowserMessage,
} from "./appProtocol";

export type WebAppState = {
  messages: BrowserMessage[];
  status: {
    connected: boolean;
    reconnecting: boolean;
    inputEnabled: boolean;
    activeTurn: boolean;
    model?: string;
    effort?: string;
    contextTokens?: number;
    notice?: string;
  };
  abort: AppAbortState;
  goalSnapshot: unknown;
  pendingPermissions: AppPermissionRequest[];
};

export function createInitialAppState(): WebAppState {
  return {
    messages: [],
    status: {
      connected: false,
      reconnecting: true,
      inputEnabled: false,
      activeTurn: false,
    },
    abort: { status: "idle" },
    goalSnapshot: null,
    pendingPermissions: [],
  };
}

export function reduceAppServerMessage(
  state: WebAppState,
  message: AppServerMessage,
): WebAppState {
  if (message.type === "app.ready") {
    return {
      ...state,
      status: {
        ...state.status,
        connected: true,
        reconnecting: false,
        inputEnabled: message.inputEnabled,
      },
      abort: message.abort,
      goalSnapshot: message.goalSnapshot,
      pendingPermissions: message.pendingPermissionRequests,
    };
  }

  if (message.type === "app.ack" || message.type === "app.pong") {
    return state;
  }

  if (message.type === "app.error") {
    const fallbackRequestId = `${message.code}-${state.messages.length}`;

    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: `error-${message.requestId ?? fallbackRequestId}`,
          role: "system",
          content: message.message,
          sdkType: "app.error",
          sdkSubtype: message.code,
        },
      ],
    };
  }

  const event = message.event;

  if (event.type === "message.append") {
    return { ...state, messages: [...state.messages, event.message] };
  }

  if (event.type === "message.replace") {
    const existingIndex = state.messages.findIndex(
      candidate => candidate.id === event.message.id,
    );

    if (existingIndex === -1) {
      return { ...state, messages: [...state.messages, event.message] };
    }

    return {
      ...state,
      messages: state.messages.map((candidate, index) =>
        index === existingIndex ? event.message : candidate,
      ),
    };
  }

  if (event.type === "message.delta") {
    if (event.id !== undefined) {
      const existingIndex = state.messages.findIndex(
        candidate => candidate.id === event.id,
      );

      if (existingIndex !== -1) {
        return {
          ...state,
          messages: state.messages.map((candidate, index) =>
            index === existingIndex
              ? { ...candidate, content: candidate.content + event.delta }
              : candidate,
          ),
        };
      }

      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: event.id,
            role: "assistant",
            content: event.delta,
          },
        ],
      };
    }

    const last = state.messages[state.messages.length - 1];
    if (last?.role === "assistant") {
      return {
        ...state,
        messages: [
          ...state.messages.slice(0, -1),
          { ...last, content: last.content + event.delta },
        ],
      };
    }

    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: `assistant-delta-${state.messages.length}`,
          role: "assistant",
          content: event.delta,
        },
      ],
    };
  }

  if (event.type === "status.update") {
    return {
      ...state,
      status: {
        ...state.status,
        connected: event.connected ?? state.status.connected,
        inputEnabled: event.inputEnabled ?? state.status.inputEnabled,
        activeTurn: event.activeTurn ?? state.status.activeTurn,
        model: event.model ?? state.status.model,
        effort: event.effort ?? state.status.effort,
        contextTokens: event.contextTokens ?? state.status.contextTokens,
        notice: event.notice ?? state.status.notice,
      },
    };
  }

  if (event.type === "goal.snapshot") {
    return { ...state, goalSnapshot: event.snapshot };
  }

  if (event.type === "permission.requested") {
    return {
      ...state,
      pendingPermissions: [
        ...state.pendingPermissions.filter(
          request => request.requestId !== event.request.requestId,
        ),
        event.request,
      ],
    };
  }

  if (event.type === "permission.resolved") {
    return {
      ...state,
      pendingPermissions: state.pendingPermissions.filter(
        request => request.requestId !== event.requestId,
      ),
    };
  }

  if (event.type === "abort.status") {
    return { ...state, abort: event.abort };
  }

  return state;
}
