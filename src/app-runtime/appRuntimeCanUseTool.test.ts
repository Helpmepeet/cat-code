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

  test('preserves permission update suggestions and maps cancel to deny with interrupt', async () => {
    const baseCanUseTool: CanUseToolFn = async () =>
      ({
        behavior: 'ask',
        message: 'Need sandboxed network approval',
        updatedInput: { command: 'curl https://example.com' },
        suggestions: [
          {
            type: 'addRules',
            rules: [
              { toolName: 'Bash', ruleContent: 'curl https://example.com' },
            ],
            behavior: 'allow',
            destination: 'projectSettings',
          },
        ],
      }) as never
    const requests: unknown[] = []
    const canUseTool = createAppRuntimeCanUseTool({
      baseCanUseTool,
      createRequestId: () => 'request-1',
      getPermissionRequestHandler: () => async request => {
        requests.push(request)
        return {
          behavior: 'deny',
          message: 'cancelled in browser',
          interrupt: true,
        }
      },
    })

    const decision = await canUseTool(
      { name: 'Bash' } as Tool,
      { command: 'curl http://example.com' },
      {
        agentId: 'worker-7',
        abortController: { abort: () => {} },
      } as ToolUseContext,
      {} as AssistantMessage,
      'toolu_7',
    )

    expect(requests).toEqual([
      {
        requestId: 'request-1',
        request: expect.objectContaining({
          tool_name: 'Bash',
          input: { command: 'curl https://example.com' },
          agent_id: 'worker-7',
          permission_suggestions: [
            expect.objectContaining({
              type: 'addRules',
              rules: [
                { toolName: 'Bash', ruleContent: 'curl https://example.com' },
              ],
              behavior: 'allow',
              destination: 'projectSettings',
            }),
          ],
        }),
      },
    ])
    expect(decision).toMatchObject({
      behavior: 'deny',
      interrupt: true,
    })
  })
})
