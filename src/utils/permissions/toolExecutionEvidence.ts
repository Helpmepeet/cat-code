import { isDeepStrictEqual } from 'node:util'
import type { Message, UserMessage } from '../../types/message.js'

const MAX_FINAL_INPUT_CHARS = 32_000
const MAX_APPROVAL_FEEDBACK_CHARS = 16_384

export type ToolExecutionEvidence = {
  toolUseId: string
  /** Set once the final Bash invocation is released to the tool. */
  bashDispatch?: { sandboxOverrideRequested: boolean }
  /** Null records that the input changed and its exact value is unavailable. */
  finalInput?: Record<string, unknown> | null
  /** Passed by final-input authorization only when bound to a human receipt. */
  approvalFeedback?: string
}

function readToolExecutionEvidence(value: unknown): ToolExecutionEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const { toolUseId, finalInput, approvalFeedback } = value as Partial<ToolExecutionEvidence>
  if (typeof toolUseId !== 'string' || toolUseId.length === 0 || toolUseId.length > 1_024) return
  if (approvalFeedback !== undefined &&
      (typeof approvalFeedback !== 'string' || approvalFeedback.length > MAX_APPROVAL_FEEDBACK_CHARS)) return
  if (finalInput !== undefined && finalInput !== null) {
    if (typeof finalInput !== 'object' || Array.isArray(finalInput)) return
    try {
      if (JSON.stringify(finalInput).length > MAX_FINAL_INPUT_CHARS) return
    } catch { return }
  }
  return { toolUseId, finalInput, approvalFeedback }
}

export function captureToolExecutionEvidence(
  toolUseId: string,
  proposedInput: unknown,
  authorizedInput: Record<string, unknown>,
  userApprovalFeedback?: string,
): ToolExecutionEvidence | undefined {
  const approvalFeedback = userApprovalFeedback?.slice(0, MAX_APPROVAL_FEEDBACK_CHARS)
  let finalInput: ToolExecutionEvidence['finalInput']
  if (!isDeepStrictEqual(proposedInput, authorizedInput)) {
    try {
      const encoded = JSON.stringify(authorizedInput)
      finalInput = encoded.length <= MAX_FINAL_INPUT_CHARS ? JSON.parse(encoded) : null
    } catch {
      finalInput = null
    }
  }
  if (finalInput === undefined && !approvalFeedback) return
  return { toolUseId, finalInput, approvalFeedback }
}

type PositionedEvidence = {
  byCall: Map<Message, Map<string, ToolExecutionEvidence>>
  byResult: Map<UserMessage, ToolExecutionEvidence>
}

/** Associate engine metadata only with its matching native tool result. */
export function positionToolExecutionEvidence(messages: readonly Message[]): PositionedEvidence {
  const calls = new Map<string, Map<string, Message>>()
  const byCall: PositionedEvidence['byCall'] = new Map()
  const byResult: PositionedEvidence['byResult'] = new Map()
  if (!messages.some(message => message.type === 'user' && message.toolExecutionEvidence)) return { byCall, byResult }
  for (const message of messages) {
    if (message.type === 'assistant' && !message.isVirtual && !message.codeMode) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const siblings = calls.get(message.uuid) ?? new Map()
        siblings.set(block.id, message)
        calls.set(message.uuid, siblings)
      }
      continue
    }
    if (message.type !== 'user' || message.isVirtual || message.codeMode || message.isMeta ||
        message.isCompactSummary || message.origin !== undefined || !message.sourceToolAssistantUUID ||
        !message.toolExecutionEvidence || !Array.isArray(message.message.content)) continue
    const evidence = readToolExecutionEvidence(message.toolExecutionEvidence)
    if (!evidence) continue
    const call = calls.get(message.sourceToolAssistantUUID)?.get(evidence.toolUseId)
    if (!call || !message.message.content.some(block =>
      block.type === 'tool_result' && block.tool_use_id === evidence.toolUseId)) continue
    const siblings = byCall.get(call) ?? new Map()
    siblings.set(evidence.toolUseId, evidence)
    byCall.set(call, siblings)
    byResult.set(message, evidence)
  }
  return { byCall, byResult }
}
