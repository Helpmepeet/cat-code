import { statSync } from 'node:fs'
import { validateUuid } from '../uuid.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from '../attachments.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { SYNTHETIC_MODEL } from '../messages.js'
import { getCommandQueueSnapshot } from '../messageQueueManager.js'
import { queuedCommandOrigin } from '../taskNotification.js'
import { positionPermissionDecisionContexts } from './permissionDecisionContext.js'
import { parsePriorAssistantContext, readAssistantProposal } from './priorAssistantContext.js'
import type { ContextualEvidence } from './contextualReviewPrompt.js'

type Conversation = ContextualEvidence['conversation']
type ConversationEntry = Conversation[number]

function conversationEvidence(
  messages: readonly Message[],
  excluded?: ReadonlySet<string>,
  includeWorkerRequests = false,
): ConversationEntry[] {
  const proposals = new Map<string, ReturnType<typeof readAssistantProposal>>()
  const evidence: ConversationEntry[] = []
  const permissionHistory = positionPermissionDecisionContexts(messages)
  for (const message of messages) {
    if (excluded?.has(message.uuid)) continue
    if (message.type === 'assistant') {
      if (message.isVirtual || message.codeMode) continue
      const proposal = readAssistantProposal(message)
      proposals.set(message.uuid, proposals.has(message.uuid) ? null : proposal)
      if (includeWorkerRequests && !message.isApiErrorMessage && !message.isInternalNoResponseSentinel &&
          !message.discardedStreamMessageId && message.message.model !== SYNTHETIC_MODEL) {
        for (const block of message.message.content) {
          if (block.type !== 'tool_use' || (block.name !== AGENT_TOOL_NAME && block.name !== LEGACY_AGENT_TOOL_NAME)) continue
          const input = block.input
          if (input && typeof input === 'object' && 'prompt' in input && typeof input.prompt === 'string') {
            // The request records whom the assistant addressed, even if launch was refused or rewritten.
            evidence.push({ origin: 'assistant', id: block.id, recipient: 'requested worker', text: input.prompt })
          }
        }
      }
      continue
    }
    for (const refusal of permissionHistory.get(message) ?? []) {
      if (refusal.outcome === 'rejected-by-user' && refusal.humanDisposition === 'correction' && refusal.humanFeedback) {
        evidence.push({ origin: 'operator', text: refusal.humanFeedback })
      }
    }
    const user = message.type === 'user' ? message : undefined
    const attachment = message.type === 'attachment' ? message.attachment as Attachment : undefined
    const queued = attachment?.type === 'queued_command' ? attachment : undefined
    if (!user && !queued) continue
    if (user && (user.isCompactSummary || user.isVirtual || user.isVisibleInTranscriptOnly ||
        user.toolUseResult !== undefined || user.sourceToolAssistantUUID !== undefined)) continue
    const source = user?.origin ?? queuedCommandOrigin(queued)
    if (source?.kind === 'interruption') continue
    const text = user?.message.content ?? queued?.prompt
    if (Array.isArray(text) && text.some(block => block.type === 'tool_result')) continue
    const content = typeof text === 'string' ? text : text?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (!content?.trim()) continue
    if (source?.kind === 'peer' || source?.kind === 'teammate') {
      evidence.push({ origin: 'peer', id: message.uuid, text: content,
        ...(source.kind === 'peer' && { actor: source.name }) })
      continue
    }
    if (!(source?.kind === 'human' || source === undefined) || user?.isMeta || (queued && 'isMeta' in queued && queued.isMeta)) continue
    const reply = parsePriorAssistantContext(user?.priorAssistantContext ??
      (queued && 'priorAssistantContext' in queued ? queued.priorAssistantContext : undefined))
    const prior = reply ? proposals.get(reply.messageUuid) : undefined
    evidence.push({ origin: 'operator', id: message.uuid, text: content,
      ...(prior && reply && prior.binding.textHash === reply.textHash &&
        { proposal: { id: reply.messageUuid, text: prior.text } }) })
  }
  return evidence
}

function stopped(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type === 'user' && row.origin?.kind === 'interruption') return true
    if (conversationEvidence([row]).some(record => record.origin === 'operator')) return false
  }
  return false
}

export type ContextualWorkerAssignment = {
  text: string
  sender: string
  excluded: ReadonlySet<string>
  parentMessages: () => readonly Message[]
  anchor?: string
  parentSignal: AbortSignal
}

export function findContextualAssignmentAnchor(context: ToolUseContext): string | undefined {
  if (context.agentId !== undefined) return undefined
  const evidence = conversationEvidence(context.messages)
  return evidence.findLast(record => record.origin === 'operator' && record.id)?.id
}

type PeerParentEvidence = {
  reference: { parentSessionId: string; userMessageId: string }
  messages: readonly Message[]
  isCurrent: () => boolean
}

// Only a successful host receipt identifies the child. Identical brief text
// or a peer's display name alone can occur in unrelated launches.
function legacyLaunchAnchor(messages: readonly Message[], childId: string, openingBrief: string): string | undefined {
  const matches: number[] = []
  const calls = new Map<string, { index: number; messageId: string }>()
  for (const [index, message] of messages.entries()) {
    if (message.type === 'assistant' && !message.isVirtual && !message.codeMode) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && block.name === 'CreatePeer' && block.input &&
            typeof block.input === 'object' && 'prompt' in block.input && block.input.prompt === openingBrief) {
          if (calls.has(block.id)) return undefined
          calls.set(block.id, { index, messageId: message.uuid })
        }
      }
    }
    if (message.type !== 'user' || message.isVirtual || !Array.isArray(message.message.content) ||
        message.message.content.length !== 1) continue
    const result = message.toolUseResult
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true ||
        'failedStep' in result || !('appSessionId' in result) || result.appSessionId !== childId) continue
    const block = message.message.content[0]
    if (block?.type !== 'tool_result' || block.is_error) continue
    const call = calls.get(block.tool_use_id)
    if (call && call.messageId === message.sourceToolAssistantUUID) matches.push(call.index)
  }
  if (matches.length !== 1) return undefined
  return conversationEvidence(messages.slice(0, matches[0])).findLast(row => row.origin === 'operator' && row.id)?.id
}

export async function resolveContextualPeerParent(
  context: ToolUseContext,
  lookupLegacyCreator?: ToolUseContext['lookupLegacyPeerCreator'],
): Promise<PeerParentEvidence | undefined> {
  if (context.agentId) return undefined
  const current = context.getCurrentAutoModeMessages?.() ?? context.messages
  const origin = current.flatMap(message => {
    const source = message.type === 'user' ? message.origin
      : message.type === 'attachment' ? queuedCommandOrigin(message.attachment) : undefined
    if (source?.kind !== 'peer' || !source.creationPrompt) return []
    const input = message.type === 'user' ? message.message.content : undefined
    const onlyBlock = Array.isArray(input) && input.length === 1 ? input[0] : undefined
    const brief = typeof input === 'string' ? input : onlyBlock?.type === 'text' ? onlyBlock.text : undefined
    return [{ source, brief }]
  })
  if (origin.length !== 1) return undefined
  const { source, brief } = origin[0]!
  const linked = source.assignment
  try {
    const legacy = !linked && brief && validateUuid(source.appSessionId) ? await lookupLegacyCreator?.(source.appSessionId) : undefined
    const parentSessionId = linked?.parentSessionId ?? legacy?.parentSessionId
    if (!parentSessionId || !validateUuid(parentSessionId) || (legacy && !validateUuid(legacy.childAppSessionId))) return undefined
    const { getTranscriptPathForSession, loadTranscriptFromFile } = await import('../sessionStorage.js')
    const path = getTranscriptPathForSession(parentSessionId)
    const fingerprint = () => {
      const file = statSync(path, { bigint: true })
      return [file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')
    }
    const before = fingerprint()
    const transcript = await loadTranscriptFromFile(path)
    const isCurrent = () => {
      try { return fingerprint() === before } catch { return false }
    }
    if (!isCurrent() || transcript.sessionId !== parentSessionId) return undefined
    const userMessageId = linked?.userMessageId ?? (legacy && brief
      ? legacyLaunchAnchor(transcript.messages, legacy.childAppSessionId, brief)
      : undefined)
    if (!userMessageId || !validateUuid(userMessageId) ||
        !conversationEvidence(transcript.messages).some(row => row.id === userMessageId && row.origin === 'operator')) return undefined
    return { reference: { parentSessionId, userMessageId }, messages: transcript.messages, isCurrent }
  } catch {
    return undefined
  }
}

export function workerAssignment(
  parent: ToolUseContext,
  initialMessages: readonly Message[],
  text: string,
): ContextualWorkerAssignment {
  const parentMessages = () => parent.getCurrentAutoModeMessages?.() ?? parent.messages
  const evidence = conversationEvidence(parent.messages, parent.contextualWorkerAssignment?.excluded)
  const anchor = evidence.findLast(record => record.origin === 'operator' && record.id)?.id
  const sender = parent.agentId ?? (evidence.some(record => record.origin === 'peer') ? 'peer-session' : 'main')
  return { text, sender, excluded: new Set(initialMessages.map(message => message.uuid)),
    parentMessages, anchor, parentSignal: parent.abortController.signal }
}

export function readContextualAuthority(context: ToolUseContext, peerParent?: PeerParentEvidence) {
  const worker = context.contextualWorkerAssignment
  const messages = context.getCurrentAutoModeMessages?.() ?? context.messages
  const conversation = conversationEvidence(messages, worker?.excluded, true)
  const peer = conversation.find(record => record.origin === 'peer')
  const actor = context.agentId ?? (peer ? 'peer-session' : 'main')
  for (const entry of conversation) {
    if (entry.origin === 'assistant') entry.actor = actor
  }
  const parentMessages = worker?.parentMessages() ?? (peerParent?.isCurrent() ? peerParent.messages : undefined)
  const parentEvidence = parentMessages ? conversationEvidence(parentMessages) : undefined
  // The launch captures the anchor before crossing into the assistant-authored
  // worker brief. A stale or compacted-away grant cannot establish authority.
  const anchor = worker?.anchor ?? peerParent?.reference.userMessageId
  const parent = anchor && parentEvidence?.some(record => record.id === anchor && record.origin === 'operator')
    ? parentEvidence : undefined
  const delegated = Boolean(context.agentId || peer || peerParent)
  const assignment: ContextualEvidence['assignment'] = delegated ? {
    actor, origin: worker ? 'worker-launch' : 'peer',
    ...(worker ? { text: worker.text, sender: worker.sender } : peer ? { text: peer.text } : {}),
    ...(parent && { parent }),
  } : undefined
  return {
    actor, delegated, assignment, conversation,
    verifiedSource: Boolean(parent || conversation.some(record => record.origin === 'operator' && record.id)),
    pendingOperatorInput: getCommandQueueSnapshot().some(command => command.mode === 'prompt' &&
      (command.agentId === undefined || command.agentId === context.agentId) && !command.isMeta &&
      (!command.origin || command.origin.kind === 'human')),
    stopped: context.abortController.signal.aborted || worker?.parentSignal.aborted === true ||
      stopped(messages) || Boolean(parentMessages && stopped(parentMessages)),
  }
}
