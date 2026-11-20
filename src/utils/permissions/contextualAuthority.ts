import { statSync } from 'node:fs'
import { validateUuid } from '../uuid.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from '../attachments.js'
import { getCommandQueueSnapshot } from '../messageQueueManager.js'
import { queuedCommandOrigin } from '../taskNotification.js'
import { positionPermissionDecisionContexts } from './permissionDecisionContext.js'
import { parsePriorAssistantContext, readAssistantProposal } from './priorAssistantContext.js'
import type { ContextualEvidence } from './contextualReviewPrompt.js'

type Conversation = ContextualEvidence['conversation']
type ConversationEntry = Conversation[number]

function conversationEvidence(messages: readonly Message[], excluded?: ReadonlySet<string>): ConversationEntry[] {
  const proposals = new Map<string, ReturnType<typeof readAssistantProposal>>()
  const evidence: ConversationEntry[] = []
  const permissionHistory = positionPermissionDecisionContexts(messages)
  for (const message of messages) {
    if (excluded?.has(message.uuid)) continue
    if (message.type === 'assistant') {
      if (message.isVirtual || message.codeMode) continue
      const proposal = readAssistantProposal(message)
      proposals.set(message.uuid, proposals.has(message.uuid) ? null : proposal)
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

export async function resolveContextualPeerParent(context: ToolUseContext): Promise<PeerParentEvidence | undefined> {
  if (context.agentId) return undefined
  const current = context.getCurrentAutoModeMessages?.() ?? context.messages
  const origin = current.flatMap(message => {
    const source = message.type === 'user' ? message.origin
      : message.type === 'attachment' ? queuedCommandOrigin(message.attachment) : undefined
    return source?.kind === 'peer' && source.creationPrompt && source.assignment ? [source.assignment] : []
  })
  if (origin.length !== 1) return undefined
  const reference = origin[0]!
  if (!validateUuid(reference.parentSessionId) || !validateUuid(reference.userMessageId)) return undefined
  try {
    const { getTranscriptPathForSession, loadTranscriptFromFile } = await import('../sessionStorage.js')
    const path = getTranscriptPathForSession(reference.parentSessionId)
    const fingerprint = () => {
      const file = statSync(path, { bigint: true })
      return [file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')
    }
    const before = fingerprint()
    const transcript = await loadTranscriptFromFile(path)
    const isCurrent = () => {
      try { return fingerprint() === before } catch { return false }
    }
    if (!isCurrent() || transcript.sessionId !== reference.parentSessionId ||
        !conversationEvidence(transcript.messages).some(row => row.id === reference.userMessageId && row.origin === 'operator')) return undefined
    return { reference, messages: transcript.messages, isCurrent }
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
  const anchor = conversationEvidence(parent.messages, parent.contextualWorkerAssignment?.excluded)
    .findLast(record => record.origin === 'operator' && record.id)?.id
  return { text, excluded: new Set(initialMessages.map(message => message.uuid)),
    parentMessages, anchor, parentSignal: parent.abortController.signal }
}

export function readContextualAuthority(context: ToolUseContext, peerParent?: PeerParentEvidence) {
  const worker = context.contextualWorkerAssignment
  const messages = context.getCurrentAutoModeMessages?.() ?? context.messages
  const conversation = conversationEvidence(messages, worker?.excluded)
  const peer = conversation.find(record => record.origin === 'peer')
  const actor = context.agentId ?? (peer ? 'peer-session' : 'main')
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
    ...(worker ? { text: worker.text } : peer ? { text: peer.text } : {}),
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
