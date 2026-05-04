import { randomUUID } from 'crypto'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import {
  permissionPromptToolResultToPermissionDecision,
  type Output as PermissionToolOutput,
} from '../utils/permissions/PermissionPromptToolResultSchema.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
} from './sessionEvents.js'

export type AppPermissionRequestHandler = (
  request: AppPermissionRequest,
) => Promise<AppPermissionResponse>

export type AppRuntimeCanUseToolOptions = {
  getPermissionRequestHandler: () => AppPermissionRequestHandler | undefined
  baseCanUseTool?: CanUseToolFn
  createRequestId?: () => string
}

export function createAppRuntimeCanUseTool({
  getPermissionRequestHandler,
  baseCanUseTool = hasPermissionsToUseTool,
  createRequestId = randomUUID,
}: AppRuntimeCanUseToolOptions): CanUseToolFn {
  return async (
    tool: Tool,
    input: Record<string, unknown>,
    toolUseContext: ToolUseContext,
    assistantMessage: AssistantMessage,
    toolUseID: string,
    forceDecision?: PermissionDecision,
  ): Promise<PermissionDecision> => {
    const permissionResult =
      forceDecision ??
      (await baseCanUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
      ))

    if (
      permissionResult.behavior === 'allow' ||
      permissionResult.behavior === 'deny'
    ) {
      return permissionResult
    }

    const handler = getPermissionRequestHandler()
    if (!handler) {
      return permissionResult
    }

    const updatedInput = permissionResult.updatedInput ?? input
    const result = await handler({
      requestId: createRequestId(),
      request: {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        input: updatedInput,
        permission_suggestions: permissionResult.suggestions,
        blocked_path: permissionResult.blockedPath,
        decision_reason: permissionResult.message,
        tool_use_id: toolUseID,
        agent_id: toolUseContext.agentId,
      },
    })

    return permissionPromptToolResultToPermissionDecision(
      normalizePermissionResponse(result, updatedInput, toolUseID),
      tool,
      input,
      toolUseContext,
    )
  }
}

function normalizePermissionResponse(
  response: AppPermissionResponse,
  input: Record<string, unknown>,
  toolUseID: string,
): PermissionToolOutput {
  if (response.behavior === 'allow') {
    return {
      ...response,
      updatedInput: response.updatedInput ?? input,
      toolUseID: response.toolUseID ?? toolUseID,
    }
  }

  return {
    ...response,
    toolUseID: response.toolUseID ?? toolUseID,
  }
}
