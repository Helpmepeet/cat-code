import { randomUUID } from 'crypto'
import type * as React from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/controlTypes.js'
import type { Tool } from '../Tool.js'
import { findToolByName } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionAskDecision } from '../types/permissions.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { RemotePermissionResponse } from './RemoteSessionManager.js'

/**
 * Create a synthetic AssistantMessage for remote permission requests.
 * The ToolUseConfirm type requires an AssistantMessage, but in remote mode
 * we don't have a real one — the tool use runs on the CCR container.
 */
export function createSyntheticAssistantMessage(
  request: SDKControlPermissionRequest,
  requestId: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      id: `remote-${requestId}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: request.tool_use_id,
          name: request.tool_name,
          input: request.input,
        },
      ],
      model: '',
      stop_reason: null,
      stop_sequence: null,
      container: null,
      context_management: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as AssistantMessage['message'],
    requestId: undefined,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Create a minimal Tool stub for tools that aren't loaded locally.
 * This happens when the remote CCR has tools (e.g., MCP tools) that the
 * local CLI doesn't know about. The stub routes to FallbackPermissionRequest.
 */
export function createToolStub(toolName: string): Tool {
  return {
    name: toolName,
    inputSchema: {} as Tool['inputSchema'],
    isEnabled: () => true,
    userFacingName: () => toolName,
    renderToolUseMessage: (input: Record<string, unknown>) => {
      const entries = Object.entries(input)
      if (entries.length === 0) return ''
      return entries
        .slice(0, 3)
        .map(([key, value]) => {
          const valueStr =
            typeof value === 'string' ? value : jsonStringify(value)
          return `${key}: ${valueStr}`
        })
        .join(', ')
    },
    call: async () => ({ data: '' }),
    description: async () => '',
    prompt: () => '',
    isReadOnly: () => false,
    isMcp: false,
    needsPermissions: () => true,
  } as unknown as Tool
}

/**
 * Build the ToolUseConfirm a remote transport queues when the far side asks for
 * permission. Every remote transport (CCR websocket, direct connect, ssh) had a
 * verbatim copy of this: the tool lookup, the synthetic assistant message, the
 * ask decision, and the four callbacks that answer the manager and drop the
 * entry from the queue. Nothing about it is transport-specific, so a copy that
 * drifted would silently change what one transport asks the user.
 *
 * The decision callbacks are no-ops for classifier and recheck because both run
 * on the remote side; there is no local permission state to consult.
 */
export function buildRemoteToolUseConfirm(args: {
  request: SDKControlPermissionRequest
  requestId: string
  tools: readonly Tool[]
  respond: (requestId: string, response: RemotePermissionResponse) => void
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
}): ToolUseConfirm {
  const { request, requestId, respond, setIsLoading, setToolUseConfirmQueue } =
    args
  const description =
    request.description ?? `${request.tool_name} requires permission`
  const dropFromQueue = () =>
    setToolUseConfirmQueue(queue =>
      queue.filter(item => item.toolUseID !== request.tool_use_id),
    )

  const permissionResult: PermissionAskDecision = {
    behavior: 'ask',
    message: description,
    suggestions: request.permission_suggestions,
    blockedPath: request.blocked_path,
  }

  return {
    assistantMessage: createSyntheticAssistantMessage(request, requestId),
    // Unknown tools (an MCP tool only the remote knows) get a stub, which
    // routes rendering to FallbackPermissionRequest.
    tool:
      findToolByName(args.tools, request.tool_name) ??
      createToolStub(request.tool_name),
    description,
    input: request.input,
    toolUseContext: {} as ToolUseConfirm['toolUseContext'],
    toolUseID: request.tool_use_id,
    permissionResult,
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction() {},
    onAbort() {
      respond(requestId, { behavior: 'deny', message: 'User aborted' })
      dropFromQueue()
    },
    onAllow(updatedInput) {
      respond(requestId, { behavior: 'allow', updatedInput })
      dropFromQueue()
      setIsLoading(true)
    },
    onReject(feedback?: string) {
      respond(requestId, {
        behavior: 'deny',
        message: feedback ?? 'User denied permission',
      })
      dropFromQueue()
    },
    async recheckPermission() {},
  }
}
