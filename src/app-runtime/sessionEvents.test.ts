import { describe, expect, test } from 'bun:test'

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import {
  createAbortStatusEvent,
  createGoalSnapshotEvent,
  createMessageEvent,
  createPermissionRequest,
  createPermissionRequestedEvent,
  createPermissionResolvedEvent,
} from './sessionEvents.js'

describe('sessionEvents', () => {
  test('createMessageEvent wraps an SDK message', () => {
    const message: SDKMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    }

    expect(createMessageEvent(message)).toEqual({
      type: 'message',
      message,
    })
  })

  test('permission event helpers preserve request and response payloads', () => {
    const request = createPermissionRequest({
      requestId: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'pwd' },
        tool_use_id: 'toolu_1',
        title: 'Run bash',
        description: 'List the current directory',
        decision_reason: 'Needs shell access',
        permission_suggestions: [],
        blocked_path: '/tmp',
        display_name: 'Bash',
        agent_id: 'agent-1',
      },
    })

    const response = {
      behavior: 'allow' as const,
      updatedInput: { command: 'pwd', timeout: 1000 },
    }

    expect(createPermissionRequestedEvent(request)).toEqual({
      type: 'permission.requested',
      request,
    })
    expect(createPermissionResolvedEvent(request, response)).toEqual({
      type: 'permission.resolved',
      request,
      response,
    })
  })

  test('goal snapshot and abort helpers emit minimal app-facing payloads', () => {
    const goal: ThreadGoal = {
      threadId: 'session-1',
      goalId: 'goal-1',
      objective: 'Ship the runtime boundary',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAtMs: 100,
      updatedAtMs: 200,
    }

    expect(createGoalSnapshotEvent(goal)).toEqual({
      type: 'goal.snapshot',
      snapshot: goal,
    })

    expect(
      createAbortStatusEvent({
        status: 'requested',
        reason: 'User aborted',
      }),
    ).toEqual({
      type: 'abort.status',
      abort: {
        status: 'requested',
        reason: 'User aborted',
      },
    })
  })
})
