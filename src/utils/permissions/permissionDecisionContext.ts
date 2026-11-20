import { z } from 'zod/v4'
import type { Message } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { getRecordedAutoModeOutcome } from './autoModeMeta.js'

// These marks cannot be supplied through a tool argument or a permission wire response.
type HumanRefusal = { disposition?: 'skip' | 'correction'; feedback?: string }
const humanRefusals = new WeakMap<object, HumanRefusal>()
const cancelledRequests = new WeakSet<object>()

export function markHumanPermissionRefusal<T extends PermissionDecision>(decision: T, disposition: 'skip' | 'correction' | true = true, feedback?: string): T {
  humanRefusals.set(decision, {
    disposition: disposition === true ? undefined : disposition,
    feedback: feedback?.slice(0, 16_384),
  })
  return decision
}

export function getHumanPermissionRefusal(decision: PermissionDecision): HumanRefusal | undefined {
  return humanRefusals.get(decision)
}

export function markPermissionRequestCancelled<T extends object>(response: T): T {
  cancelledRequests.add(response)
  return response
}

export function isPermissionRequestCancelled(response: object): boolean {
  return cancelledRequests.has(response)
}

export function permissionRefusalOutcome(decision: PermissionDecision, toolUseId: string): PermissionDecisionContext['outcome'] {
  if (cancelledRequests.has(decision)) return 'unanswered'
  if (humanRefusals.has(decision)) return 'rejected-by-user'
  if (decision.decisionReason?.type === 'classifier') {
    const outcome = getRecordedAutoModeOutcome(toolUseId)?.outcome
    return outcome === 'automode-unavailable' || outcome === 'automode-parsing-error' || outcome === 'interrupted' ||
        (decision.behavior === 'ask' && decision.humanOnly && outcome === 'unanswered')
      ? outcome : 'automode-blocked'
  }
  return decision.behavior === 'ask' ? 'unanswered' : 'blocked-by-permissions'
}

const permissionDecisionContextSchema = z.strictObject({
  version: z.literal(1),
  toolUseId: z.string().min(1),
  assistantUuid: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  humanDisposition: z.enum(['skip', 'correction']).optional(),
  humanFeedback: z.string().max(16_384).optional(),
  contextual: z.literal(true).optional(),
  outcome: z.enum(['rejected-by-user', 'unanswered', 'blocked-by-permissions', 'automode-blocked', 'automode-unavailable', 'automode-parsing-error', 'interrupted']),
})

/** Engine-owned decision metadata, never inferred from result bodies or summaries. */
export type PermissionDecisionContext = z.infer<typeof permissionDecisionContextSchema>

export function readPermissionDecisionContext(value: unknown): PermissionDecisionContext | null {
  const parsed = permissionDecisionContextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Negative evidence has no time expiry. It follows the selected conversation
 * ancestry, including compaction and ordinary restart, not a process-wide cache.
 * Clearing or rewinding before the decision removes it. New approval is for the
 * checker to compare to this historical action, never a reason to rewrite it.
 */
export function collectPermissionDecisionContexts(messages: readonly Message[]): PermissionDecisionContext[] {
  return [...positionPermissionDecisionContexts(messages).values()].flat()
}

/** Native results win over carried copies, without moving a decision in time. */
export function positionPermissionDecisionContexts(messages: readonly Message[]): Map<Message, PermissionDecisionContext[]> {
  const records = new Map<string, PermissionDecisionContext>()
  const owners = new Map<string, Message>()
  const calls = new Map<string, { assistantUuid: string; toolName: string }>()
  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') calls.set(block.id, { assistantUuid: message.uuid, toolName: block.name })
      }
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      // This field is populated by the engine after summarization, not by the model.
      const saved = 'permissionDecisions' in message ? message.permissionDecisions : undefined
      if (Array.isArray(saved)) for (const value of saved) {
        const record = readPermissionDecisionContext(value)
        if (record) {
          const key = JSON.stringify([record.assistantUuid, record.toolUseId])
          if (!records.has(key)) {
            records.set(key, record)
            owners.set(key, message)
          }
        }
      }
    } else if (message.type === 'user') {
      const record = readPermissionDecisionContext(message.permissionDecision)
      if (!record || message.isCompactSummary || message.origin !== undefined) continue
      const call = calls.get(record.toolUseId)
      if (call?.assistantUuid !== record.assistantUuid || call.toolName !== record.toolName ||
        message.sourceToolAssistantUUID !== record.assistantUuid ||
        !Array.isArray(message.message.content) || !message.message.content.some(block =>
          block.type === 'tool_result' && block.tool_use_id === record.toolUseId && block.is_error === true)) continue
      const key = JSON.stringify([record.assistantUuid, record.toolUseId])
      records.set(key, record)
      owners.set(key, message)
    }
  }
  const positioned = new Map<Message, PermissionDecisionContext[]>()
  for (const [key, owner] of owners) {
    const values = positioned.get(owner) ?? []
    values.push(records.get(key)!)
    positioned.set(owner, values)
  }
  return new Map(messages.filter(message => positioned.has(message))
    .map(message => [message, positioned.get(message)!]))
}
