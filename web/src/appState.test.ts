// @ts-ignore - bun:test is provided by Bun at runtime in this package.
import { describe, expect, test } from "bun:test";
import { createInitialAppState, reduceAppServerMessage } from "./appState";

describe("web app state reducer", () => {
  test("applies ready state", () => {
    const state = reduceAppServerMessage(createInitialAppState(), {
      type: "app.ready",
      protocolVersion: 1,
      inputEnabled: true,
      abort: { status: "idle" },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    });

    expect(state.status.inputEnabled).toBe(true);
    expect(state.abort).toEqual({ status: "idle" });
  });

  test("appends messages and accumulates deltas", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.append",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "hello",
        },
      },
    });
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.delta",
        delta: " world",
      },
    });

    expect(state.messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "hello world",
      },
    ]);
  });

  test("tracks pending permission requests and resolutions", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "permission.requested",
        request: {
          requestId: "perm-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "pwd" },
            tool_use_id: "toolu_1",
          },
        },
      },
    });

    expect(state.pendingPermissions).toHaveLength(1);

    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "permission.resolved",
        requestId: "perm-1",
        response: { behavior: "deny", message: "no" },
      },
    });

    expect(state.pendingPermissions).toEqual([]);
  });

  test("records errors as system messages", () => {
    const state = reduceAppServerMessage(createInitialAppState(), {
      type: "app.error",
      requestId: "submit-1",
      code: "turn_already_running",
      message: "Session turn already running",
      retryable: true,
    });

    expect(state.messages[0]).toMatchObject({
      role: "system",
      content: "Session turn already running",
    });
  });
});
