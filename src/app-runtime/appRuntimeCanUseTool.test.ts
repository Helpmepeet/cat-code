import { describe, expect, test } from 'bun:test'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import { createAppRuntimeCanUseTool } from './appRuntimeCanUseTool.js'

describe('createAppRuntimeCanUseTool', () => {
  test('turns ask decisions into app permission requests', async () => {
    const baseCanUseTool: CanUseToolFn = async () => ({
      behavior: 'ask',
      message: 'Need approval',
      updatedInput: { command: 'pwd' },
      suggestions: [],
      blockedPath: '/tmp',
    })
    const requests: unknown[] = []
    const canUseTool = createAppRuntimeCanUseTool({
      baseCanUseTool,
      createRequestId: () => 'request-1',
      getPermissionRequestHandler: () => async request => {
        requests.push(request)
        return { behavior: 'allow', updatedInput: request.request.input }
      },
    })

    const decision = await canUseTool(
      { name: 'Bash' } as Tool,
      { command: 'pwd' },
      { agentId: 'agent-1' } as ToolUseContext,
      {} as AssistantMessage,
      'toolu_1',
    )

    expect(requests).toEqual([
      {
        requestId: 'request-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'pwd' },
          permission_suggestions: [],
          blocked_path: '/tmp',
          decision_reason: 'Need approval',
          tool_use_id: 'toolu_1',
          agent_id: 'agent-1',
        },
      },
    ])
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'pwd' })
  })

  test('returns ask decisions unchanged when no app handler is active', async () => {
    const askDecision: PermissionDecision = {
      behavior: 'ask',
      message: 'Need approval',
    }
    const canUseTool = createAppRuntimeCanUseTool({
      baseCanUseTool: async () => askDecision,
      getPermissionRequestHandler: () => undefined,
    })

    await expect(
      canUseTool(
        { name: 'Read' } as Tool,
        { file_path: '/tmp/demo.txt' },
        {} as ToolUseContext,
        {} as AssistantMessage,
        'toolu_2',
      ),
    ).resolves.toBe(askDecision)
  })
})
