import { recordContextualHumanApproval } from '../utils/permissions/contextualAuthorization.js'
import { randomUUID } from 'crypto'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage, CodeModeMetadata } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import {
  permissionPromptToolResultToPermissionDecision,
  type Output as PermissionToolOutput,
} from '../utils/permissions/PermissionPromptToolResultSchema.js'
import {
  createInitialAutoModePermissionObservation,
  hasPermissionsToUseTool,
} from '../utils/permissions/permissions.js'
import { resolveInitialPermissionOccurrence } from '../utils/permissions/autoModeObservation.js'
import { issueUserApprovalReceipt } from '../services/tools/toolInputSecurity.js'
import { isPermissionRequestCancelled, markHumanPermissionRefusal, markPermissionRequestCancelled } from '../utils/permissions/permissionDecisionContext.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
} from './sessionEvents.js'

export type BackgroundScriptApprovalOwner = Pick<CodeModeMetadata, 'cellId' | 'generation'>

export type AppPermissionRequestHandler = (
  request: AppPermissionRequest,
  signal?: AbortSignal,
  backgroundScript?: BackgroundScriptApprovalOwner,
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
    const observation = createInitialAutoModePermissionObservation(
      tool,
      toolUseContext,
      toolUseID,
    )
    if (forceDecision !== undefined) observation?.markRoute('forced')
    const permissionResult = await resolveInitialPermissionOccurrence({
      observer: observation?.observer ?? null,
      forceDecision,
      getPermissionResult: () =>
        baseCanUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
          undefined,
          observation,
        ),
      finishResult: result => observation!.finishResult(result.behavior),
      finishError: () => observation!.finishError(),
    })

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
    // This owner is for work accounting inside the controller, outside the wire request.
    const backgroundScript = toolUseContext.codeModeBackgroundCell && assistantMessage.isVirtual
      ? assistantMessage.codeMode
      : undefined
    toolUseContext.onHumanPermissionWait?.(true)
    const result = await handler({
      requestId: createRequestId(),
      request: {
        subtype: 'can_use_tool',
        tool_name: tool.name,
        ...(permissionResult.humanOnly && { human_only: true }),
        input: updatedInput,
        permission_suggestions: permissionResult.suggestions,
        blocked_path: permissionResult.blockedPath,
        decision_reason: permissionResult.message,
        tool_use_id: toolUseID,
        agent_id: toolUseContext.agentId,
      },
    }, toolUseContext.abortController?.signal, backgroundScript).finally(() => toolUseContext.onHumanPermissionWait?.(false))

    const decision = permissionPromptToolResultToPermissionDecision(
      normalizePermissionResponse(result.behavior === 'allow' && permissionResult.humanOnly
        ? { ...result, updatedPermissions: undefined } : result, updatedInput, toolUseID),
      tool,
      input,
      toolUseContext,
    )
    if (decision.behavior === 'deny') {
      if (isPermissionRequestCancelled(result)) markPermissionRequestCancelled(decision)
      else markHumanPermissionRefusal(decision, result.behavior === 'deny' && permissionResult.humanOnly
        ? (!result.interrupt && (!result.message.trim() || result.message === 'Denied by user') ? 'skip' : 'correction')
        : true, result.behavior === 'deny' && permissionResult.humanOnly && result.message !== 'Denied by user'
          ? result.message : undefined)
    }
    if (decision.behavior === 'allow' && decision.updatedInput !== undefined) {
      // The receipt must bind the normalized object returned to tool execution.
      if (permissionResult.humanOnly) recordContextualHumanApproval(toolUseContext, toolUseID, decision.updatedInput)
      issueUserApprovalReceipt(tool.name, decision.updatedInput, toolUseID)
    }
    return decision
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
