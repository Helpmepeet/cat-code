// @ts-ignore - bun:test is provided by Bun at runtime in this package.
import { describe, expect, test } from "bun:test";
import { createInitialAppState, reduceAppServerMessage } from "./appState";

describe("web app state reducer", () => {
  test("applies ready state", () => {
    const state = reduceAppServerMessage(createInitialAppState(), {
      type: "app.ready",
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: "idle" },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    });

    expect(state.status.connected).toBe(true);
    expect(state.status.reconnecting).toBe(false);
    expect(state.status.inputEnabled).toBe(true);
    expect(state.status.activeTurn).toBe(false);
    expect(state.abort).toEqual({ status: "idle" });
  });

  test("ready snapshots reset stale active turn state", () => {
    const busyState = reduceAppServerMessage(createInitialAppState(), {
      type: "app.event",
      event: {
        type: "status.update",
        inputEnabled: false,
        activeTurn: true,
      },
    });

    const state = reduceAppServerMessage(busyState, {
      type: "app.ready",
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: "idle" },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    });

    expect(state.status.inputEnabled).toBe(true);
    expect(state.status.activeTurn).toBe(false);
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

  test("applies deltas to matching message ids", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.append",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "first",
        },
      },
    });
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.append",
        message: {
          id: "assistant-2",
          role: "assistant",
          content: "second",
        },
      },
    });

    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.delta",
        id: "assistant-1",
        delta: " updated",
      },
    });

    expect(state.messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "first updated",
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "second",
      },
    ]);
  });

  test("appends deltas with unknown message ids", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.append",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "first",
        },
      },
    });

    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.delta",
        id: "assistant-2",
        delta: "second",
      },
    });

    expect(state.messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "first",
      },
      {
        id: "assistant-2",
        role: "assistant",
        content: "second",
      },
    ]);
  });

  test("appends idless deltas deterministically", () => {
    const state = createInitialAppState();
    const message = {
      type: "app.event" as const,
      event: {
        type: "message.delta" as const,
        delta: "hello",
      },
    };

    expect(reduceAppServerMessage(state, message)).toEqual(
      reduceAppServerMessage(state, message),
    );
  });

  test("replaces messages in place", () => {
    let state = createInitialAppState();
    for (const message of [
      { id: "message-1", role: "user" as const, content: "one" },
      { id: "message-2", role: "assistant" as const, content: "two" },
      { id: "message-3", role: "system" as const, content: "three" },
    ]) {
      state = reduceAppServerMessage(state, {
        type: "app.event",
        event: {
          type: "message.append",
          message,
        },
      });
    }

    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.replace",
        message: {
          id: "message-2",
          role: "assistant",
          content: "two replaced",
        },
      },
    });

    expect(state.messages).toEqual([
      { id: "message-1", role: "user", content: "one" },
      { id: "message-2", role: "assistant", content: "two replaced" },
      { id: "message-3", role: "system", content: "three" },
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

  test("preserves pending permission display fields for the browser panel", () => {
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
            display_name: "Run shell command",
            input: { command: "pwd" },
            permission_suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Bash", ruleContent: "pwd" }],
                behavior: "allow",
                destination: "projectSettings",
              },
            ],
            blocked_path: "/repo",
            decision_reason: "Need shell approval",
            tool_use_id: "toolu_1",
            agent_id: "worker-1",
          },
        },
      },
    });

    expect(state.pendingPermissions).toEqual([
      {
        requestId: "perm-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          display_name: "Run shell command",
          input: { command: "pwd" },
          permission_suggestions: [
            expect.objectContaining({
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "pwd" }],
              behavior: "allow",
              destination: "projectSettings",
            }),
          ],
          blocked_path: "/repo",
          decision_reason: "Need shell approval",
          tool_use_id: "toolu_1",
          agent_id: "worker-1",
        },
      },
    ]);
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

  test("records requestless errors deterministically", () => {
    const state = createInitialAppState();
    const message = {
      type: "app.error" as const,
      code: "internal_error",
      message: "Internal error",
      retryable: true,
    };

    expect(reduceAppServerMessage(state, message)).toEqual(
      reduceAppServerMessage(state, message),
    );
  });
});
