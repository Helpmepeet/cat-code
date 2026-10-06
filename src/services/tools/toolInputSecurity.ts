import { isDeepStrictEqual } from 'util'
import type { Tool, ToolUseContext } from '../../Tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import {
  consumeTrustedSedEditApproval,
  type TrustedSedEdit,
} from '../../tools/BashTool/sedEditCapability.js'

type UserApprovalReceipt = {
  toolName: string
  toolUseID: string
  input: Record<string, unknown>
  source: 'user' | 'interactiveHook'
}

const userApprovalReceipts = new WeakMap<object, UserApprovalReceipt>()
const userApprovalInputsByToolUseID = new Map<string, Set<object>>()

export function issueUserApprovalReceipt(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
): void {
  try {
    const snapshot = structuredClone(input)
    const prior = userApprovalReceipts.get(input)
    if (prior) forgetUserApprovalReceipt(input, prior.toolUseID)
    userApprovalReceipts.set(input, {
      toolName,
      toolUseID,
      input: snapshot,
      source: 'user',
    })
    const inputs =
      userApprovalInputsByToolUseID.get(toolUseID) ?? new Set<object>()
    inputs.add(input)
    userApprovalInputsByToolUseID.set(toolUseID, inputs)
  } catch {
    return
  }
}

export function issueHookInteractionReceipt(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
): void {
  try {
    const prior = userApprovalReceipts.get(input)
    if (prior) forgetUserApprovalReceipt(input, prior.toolUseID)
    userApprovalReceipts.set(input, {
      toolName,
      toolUseID,
      input: structuredClone(input),
      source: 'interactiveHook',
    })
    const inputs =
      userApprovalInputsByToolUseID.get(toolUseID) ?? new Set<object>()
    inputs.add(input)
    userApprovalInputsByToolUseID.set(toolUseID, inputs)
  } catch {
    return
  }
}

function forgetUserApprovalReceipt(input: object, toolUseID: string): void {
  userApprovalReceipts.delete(input)
  const inputs = userApprovalInputsByToolUseID.get(toolUseID)
  inputs?.delete(input)
  if (inputs?.size === 0) userApprovalInputsByToolUseID.delete(toolUseID)
}

function consumeUserApprovalReceipt(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
): UserApprovalReceipt['source'] | undefined {
  const receipt = userApprovalReceipts.get(input)
  if (receipt) forgetUserApprovalReceipt(input, receipt.toolUseID)
  if (
    !receipt ||
    receipt.toolName !== tool.name ||
    receipt.toolUseID !== toolUseID
  ) {
    return undefined
  }
  try {
    return isDeepStrictEqual(
      tool.inputSchema.parse(structuredClone(input)),
      tool.inputSchema.parse(structuredClone(receipt.input)),
    )
      ? receipt.source
      : undefined
  } catch {
    return undefined
  }
}

export function clearUserApprovalReceipts(toolUseID: string): void {
  const inputs = userApprovalInputsByToolUseID.get(toolUseID)
  if (!inputs) return
  for (const input of inputs) userApprovalReceipts.delete(input)
  userApprovalInputsByToolUseID.delete(toolUseID)
}

export type FinalToolInputResult =
  | {
      allowed: true
      input: Record<string, unknown>
      context: ToolUseContext
      decision: PermissionDecision
      trustedSedEdit?: TrustedSedEdit
    }
  | {
      allowed: false
      input: Record<string, unknown>
      decision: PermissionDecision
    }

export class ToolInputPreparation {
  private current:
    | {
        toolName: string
        input: Record<string, unknown>
        context: ToolUseContext
        cleanup(): Promise<void> | void
      }
    | undefined

  async prepare(
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ): Promise<ToolUseContext> {
    if (
      this.current?.toolName === tool.name &&
      this.current.input === input
    ) {
      return this.current.context
    }
    await this.dispose()
    const cleanContext = { ...context }
    delete cleanContext.preparedExecution
    if (!tool.prepareExecution) return cleanContext
    const prepared = await tool.prepareExecution(input, cleanContext)
    const preparedContext: ToolUseContext = {
      ...cleanContext,
      preparedExecution: {
        toolName: tool.name,
        input,
        state: prepared.state,
      },
    }
    this.current = {
      toolName: tool.name,
      input,
      context: preparedContext,
      cleanup: prepared.cleanup,
    }
    return preparedContext
  }

  async dispose(): Promise<void> {
    const current = this.current
    this.current = undefined
    await current?.cleanup()
  }
}

function cloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(input)
}

export function freezeCanonicalToolInput<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const pending: object[] = [value]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && 'value' in descriptor) {
        const child = descriptor.value
        if (child !== null && typeof child === 'object') pending.push(child)
      }
    }
    if (!Object.isFrozen(current)) Object.freeze(current)
  }
  return value
}

function deniedInput(
  input: Record<string, unknown>,
  message: string,
): FinalToolInputResult {
  return {
    allowed: false,
    input,
    decision: {
      behavior: 'deny',
      message,
      decisionReason: {
        type: 'hook',
        hookName: 'FinalToolInputValidation',
        reason: message,
      },
    },
  }
}

export async function authorizeFinalToolInput(
  tool: Tool,
  proposedInput: Record<string, unknown>,
  previouslyAuthorizedInput: Record<string, unknown>,
  previousDecision: PermissionDecision,
  toolUseID: string,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  preparation: ToolInputPreparation,
  checkCurrentPermissions: (
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
  ) => Promise<PermissionDecision | null>,
  canUseTool: (
    tool: Tool,
    input: Record<string, unknown>,
    context: ToolUseContext,
    assistantMessage: AssistantMessage,
    toolUseID: string,
  ) => Promise<PermissionDecision>,
): Promise<FinalToolInputResult> {
  let trustedSedEdit: TrustedSedEdit | undefined
  if (tool.name === 'Bash') {
    trustedSedEdit = consumeTrustedSedEditApproval(proposedInput, toolUseID)
  }
  const approvalReceiptSource = consumeUserApprovalReceipt(
    tool,
    proposedInput,
    toolUseID,
  )

  let candidate: Record<string, unknown>
  let authorized: Record<string, unknown>
  try {
    candidate = tool.inputSchema.parse(cloneInput(proposedInput))
    authorized = tool.inputSchema.parse(cloneInput(previouslyAuthorizedInput))
  } catch {
    return deniedInput(proposedInput, 'Tool input failed final schema validation.')
  }

  const preparedCanonicalInput =
    toolUseContext.preparedExecution?.toolName === tool.name
      ? toolUseContext.preparedExecution.input
      : undefined
  if (
    tool.prepareExecution &&
    preparedCanonicalInput !== undefined &&
    isDeepStrictEqual(candidate, preparedCanonicalInput)
  ) {
    candidate = preparedCanonicalInput
  } else if (
    (approvalReceiptSource !== undefined || trustedSedEdit !== undefined) &&
    isDeepStrictEqual(candidate, proposedInput)
  ) {
    candidate = proposedInput
  } else if (
    (!tool.prepareExecution ||
      preparedCanonicalInput === previouslyAuthorizedInput) &&
    isDeepStrictEqual(candidate, authorized)
  ) {
    candidate = previouslyAuthorizedInput
  }

  let preparedContext: ToolUseContext
  try {
    preparedContext = await preparation.prepare(tool, candidate, toolUseContext)
  } catch {
    return deniedInput(proposedInput, 'Tool input preparation failed.')
  }
  candidate = freezeCanonicalToolInput(candidate)
  try {
    const validation = await tool.validateInput?.(candidate, preparedContext)
    if (validation?.result === false) {
      return deniedInput(proposedInput, validation.message)
    }
  } catch {
    return deniedInput(proposedInput, 'Tool input failed final semantic validation.')
  }

  let decision = previousDecision
  if (!isDeepStrictEqual(candidate, authorized)) {
    let currentPolicyDecision: PermissionDecision | null
    try {
      currentPolicyDecision = await checkCurrentPermissions(
        tool,
        candidate,
        preparedContext,
      )
    } catch {
      return deniedInput(
        proposedInput,
        'Current permission policy could not validate the final input.',
      )
    }
    if (currentPolicyDecision?.behavior === 'deny') {
      return { allowed: false, input: candidate, decision: currentPolicyDecision }
    }
    const receiptSatisfiesPrompt =
      approvalReceiptSource === 'user' ||
      trustedSedEdit !== undefined ||
      (approvalReceiptSource === 'interactiveHook' &&
        currentPolicyDecision === null)

    if (!receiptSatisfiesPrompt) {
      const authorizationInput = freezeCanonicalToolInput(candidate)
      let freshDecision: PermissionDecision
      try {
        freshDecision = await canUseTool(
          tool,
          authorizationInput,
          preparedContext,
          assistantMessage,
          toolUseID,
        )
      } catch {
        return deniedInput(
          proposedInput,
          'Tool input changed after approval and could not be re-authorized.',
        )
      }
      if (freshDecision.behavior !== 'allow') {
        return { allowed: false, input: candidate, decision: freshDecision }
      }
      decision = freshDecision

      const returnedInput =
        freshDecision.updatedInput ?? authorizationInput
      const freshReceiptSource =
        freshDecision.updatedInput === undefined
          ? undefined
          : consumeUserApprovalReceipt(tool, returnedInput, toolUseID)
      try {
        const canonicalReturnedInput = tool.inputSchema.parse(
          cloneInput(returnedInput),
        )
        const changedAfterFreshAuthorization = !isDeepStrictEqual(
          canonicalReturnedInput,
          authorizationInput,
        )
        if (
          changedAfterFreshAuthorization &&
          freshReceiptSource === undefined
        ) {
          return deniedInput(
            proposedInput,
            'Permission checks returned changed input without an approval receipt.',
          )
        }
        candidate =
          isDeepStrictEqual(canonicalReturnedInput, authorizationInput)
            ? authorizationInput
            : freshReceiptSource !== undefined &&
                isDeepStrictEqual(canonicalReturnedInput, returnedInput)
              ? returnedInput
              : canonicalReturnedInput
      } catch {
        return deniedInput(
          proposedInput,
          'Re-authorized tool input failed final schema validation.',
        )
      }
      try {
        preparedContext = await preparation.prepare(
          tool,
          candidate,
          toolUseContext,
        )
      } catch {
        return deniedInput(
          proposedInput,
          'Re-authorized tool input preparation failed.',
        )
      }
      candidate = freezeCanonicalToolInput(candidate)
      try {
        const validation = await tool.validateInput?.(candidate, preparedContext)
        if (validation?.result === false) {
          return deniedInput(proposedInput, validation.message)
        }
      } catch {
        return deniedInput(
          proposedInput,
          'Re-authorized tool input failed semantic validation.',
        )
      }

      if (freshReceiptSource !== undefined) {
        let finalPolicyDecision: PermissionDecision | null
        try {
          finalPolicyDecision = await checkCurrentPermissions(
            tool,
            candidate,
            preparedContext,
          )
        } catch {
          return deniedInput(
            proposedInput,
            'Current permission policy could not validate the re-authorized input.',
          )
        }
        if (finalPolicyDecision?.behavior === 'deny') {
          return {
            allowed: false,
            input: candidate,
            decision: finalPolicyDecision,
          }
        }
        if (
          finalPolicyDecision?.behavior === 'ask' &&
          freshReceiptSource !== 'user'
        ) {
          return {
            allowed: false,
            input: candidate,
            decision: finalPolicyDecision,
          }
        }
      }
    }
  }

  return {
    allowed: true,
    input: candidate,
    context: preparedContext,
    decision,
    ...(trustedSedEdit ? { trustedSedEdit } : {}),
  }
}
