import { statSync } from 'node:fs'
import type { UUID } from 'node:crypto'
import { validateUuid } from '../uuid.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message, MessageOrigin } from '../../types/message.js'
import type { Attachment } from '../attachments.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { SYNTHETIC_MODEL } from '../messages.js'
import { getCommandQueueSnapshot } from '../messageQueueManager.js'
import { queuedCommandOrigin } from '../taskNotification.js'
import { isRelayedOrigin } from '../messageOrigin.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { askUserQuestionAnswerText, positionPermissionDecisionContexts } from './permissionDecisionContext.js'
import { parsePriorAssistantContext, readAssistantProposal } from './priorAssistantContext.js'
import type { ContextualEvidence } from './contextualReviewPrompt.js'

type Conversation = ContextualEvidence['conversation']
type ConversationEntry = Conversation[number]

function isOperatorOrigin(origin: MessageOrigin | undefined): boolean {
  return !origin || origin.kind === 'human' ||
    (origin.kind === 'question-reply' && !isRelayedOrigin(origin))
}

function isLiveAssistant(message: AssistantMessage): boolean {
  return !message.isApiErrorMessage && !message.isInternalNoResponseSentinel &&
    !message.discardedStreamMessageId && (message.codeMode
      ? message.isVirtual === true
      : !message.isVirtual && message.message.model !== SYNTHETIC_MODEL)
}

function conversationEvidence(
  messages: readonly Message[],
  worker?: Pick<ContextualWorkerAssignment, 'excluded' | 'history'>,
  includeWorkerRequests = false,
): ConversationEntry[] {
  const proposals = new Map<string, ReturnType<typeof readAssistantProposal>>()
  const askedQuestions = new Map<string, { assistantUuid: string; questions: unknown }>()
  const evidence: ConversationEntry[] = []
  const permissionHistory = positionPermissionDecisionContexts(messages)
  for (const message of messages) {
    if (worker?.excluded.has(message.uuid)) continue
    if (message.type === 'assistant') {
      if (!message.isVirtual && !message.codeMode) {
        const proposal = readAssistantProposal(message)
        proposals.set(message.uuid, proposals.has(message.uuid) ? null : proposal)
      }
      if (isLiveAssistant(message)) {
        // The first spoken response records the option the agent selected.
        // It can explain a delegated choice, but cannot grant permission.
        if (evidence.at(-1)?.proposal) {
          const response = proposals.get(message.uuid)
          if (response) evidence.push({ origin: 'assistant', id: message.uuid, text: response.text })
        }
        for (const block of message.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input
          if (!input || typeof input !== 'object') continue
          if (!message.codeMode && block.name === ASK_USER_QUESTION_TOOL_NAME && 'questions' in input) {
            askedQuestions.set(block.id, { assistantUuid: message.uuid, questions: input.questions })
          }
          if (includeWorkerRequests && (block.name === AGENT_TOOL_NAME || block.name === LEGACY_AGENT_TOOL_NAME) &&
              'prompt' in input && typeof input.prompt === 'string') {
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
    if (user && Array.isArray(user.message.content)) {
      for (const block of user.message.content) {
        if (block.type !== 'tool_result') continue
        const answer = askUserQuestionAnswerText(block, askedQuestions, user)
        if (answer) evidence.push({ origin: 'operator', id: message.uuid, text: answer })
      }
    }
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
    if (source?.kind === 'coordinator' && includeWorkerRequests) {
      evidence.push({ origin: 'assistant', id: message.uuid, actor: 'coordinator', text: content })
      continue
    }
    if (!isOperatorOrigin(source) || user?.isMeta ||
        (queued && ((queued.commandMode !== undefined && queued.commandMode !== 'prompt') ||
          ('isMeta' in queued && queued.isMeta)))) continue
    // Previous launch and resume briefs are stored as user-role messages.
    // Without a recorded author, that role does not establish operator authority.
    if (!source && worker?.history?.has(message.uuid)) {
      evidence.push({ origin: 'other', id: message.uuid, actor: 'worker history', text: content })
      continue
    }
    const reply = parsePriorAssistantContext(user?.priorAssistantContext ??
      (queued && 'priorAssistantContext' in queued ? queued.priorAssistantContext : undefined))
    const prior = reply ? proposals.get(reply.messageUuid) : undefined
    evidence.push({ origin: 'operator', id: message.uuid, text: content,
      ...(queued?.source_uuid && { submittedId: queued.source_uuid }),
      ...(prior && reply && prior.binding.textHash === reply.textHash &&
        { proposal: { id: reply.messageUuid, text: prior.text } }) })
  }
  return evidence
}

// Paired engine metadata describes dispatch without retaining tool output.
export function recentShellRuns(messages: readonly Message[], conversation: Conversation, excluded?: ReadonlySet<string>) {
  const operatorIds = new Set(conversation.filter(row => row.origin === 'operator').map(row => row.id))
  type Run = NonNullable<ContextualEvidence['recentShellRuns']>[number]
  const calls = new Map<string, { row: AssistantMessage; metadata: Omit<Run, 'outcome'> }>()
  const runs: Run[] = []
  let afterOperatorId: string | undefined
  for (const row of messages) {
    if (excluded?.has(row.uuid)) continue
    if (operatorIds.has(row.uuid)) afterOperatorId = row.uuid
    if (row.type === 'assistant' && isLiveAssistant(row)) {
      for (const block of row.message.content) {
        if (block.type !== 'tool_use' || block.name !== 'Bash') continue
        const input = block.input
        if (!input || typeof input !== 'object' || !('command' in input) || typeof input.command !== 'string') continue
        calls.set(block.id, { row, metadata: { attempt: block.id, afterOperatorId,
          ...(input.command.length <= 2048 && { proposedCommand: input.command }) } })
      }
    }
    if (row.type !== 'user' || row.origin || row.isMeta || row.isCompactSummary ||
        row.isVisibleInTranscriptOnly || !row.sourceToolAssistantUUID || !Array.isArray(row.message.content)) continue
    const result = row.toolUseResult
    const bashResult = result && typeof result === 'object' && 'interrupted' in result && typeof result.interrupted === 'boolean' &&
      'stdout' in result && typeof result.stdout === 'string' && 'stderr' in result && typeof result.stderr === 'string' ? result : undefined
    for (const block of row.message.content) {
      if (block.type !== 'tool_result') continue
      const call = calls.get(block.tool_use_id)
      if (!call || call.row.uuid !== row.sourceToolAssistantUUID ||
          Boolean(call.row.isVirtual) !== Boolean(row.isVirtual) ||
          call.row.codeMode?.cellId !== row.codeMode?.cellId ||
          call.row.codeMode?.generation !== row.codeMode?.generation) continue
      const evidence = row.toolExecutionEvidence
      const requested = evidence?.toolUseId === block.tool_use_id ? evidence.bashDispatch?.sandboxOverrideRequested : undefined
      const dispatched = typeof requested === 'boolean'
      // Older result rows have no dispatch marker. A typed Bash result still
      // supports the old receipt, including its outcome when marked interrupted.
      if (!dispatched && (!bashResult || (block.is_error && !bashResult.interrupted))) continue
      runs.push({ ...call.metadata,
        sandboxOverrideRequested: dispatched ? requested
          : bashResult && 'dangerouslyDisableSandbox' in bashResult && typeof bashResult.dangerouslyDisableSandbox === 'boolean'
            ? bashResult.dangerouslyDisableSandbox : undefined,
        outcome: bashResult?.interrupted ? 'interrupted'
          : bashResult && 'backgroundTaskId' in bashResult && bashResult.backgroundTaskId ? 'background'
          : block.is_error || !bashResult ? 'dispatched' : 'completed' })
      calls.delete(block.tool_use_id)
    }
  }
  return runs.slice(-8)
}

function stopped(messages: readonly Message[], evidence: Conversation): boolean {
  const lastOperator = evidence.findLast(record => record.origin === 'operator' && record.id)?.id
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type === 'user' && row.origin?.kind === 'interruption') return true
    if (row.uuid === lastOperator) return false
  }
  return false
}

export type ContextualWorkerAssignment = {
  text: string
  sender: string
  excluded: ReadonlySet<string>
  history?: ReadonlySet<string>
  parentWorker?: Pick<ContextualWorkerAssignment, 'excluded' | 'history'>
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
  pendingOperatorInput: boolean
  isCurrent: () => boolean
}

// Only a successful host receipt identifies the child. Identical brief text
// or a peer's display name alone can occur in unrelated launches.
function legacyLaunchAnchor(messages: readonly Message[], childId: string, openingBrief: string): string | undefined {
  const receipts = messages.filter(message => {
    if (message.type !== 'user') return false
    const result = message.toolUseResult
    return result && typeof result === 'object' && 'appSessionId' in result && result.appSessionId === childId
  })
  if (receipts.length !== 1) return undefined
  const receipt = receipts[0]!
  if (receipt.type !== 'user' || receipt.origin || receipt.isMeta || receipt.isCompactSummary ||
      receipt.isVisibleInTranscriptOnly || Boolean(receipt.isVirtual) !== Boolean(receipt.codeMode)) return undefined
  const result = receipt.toolUseResult as Record<string, unknown>
  if (result.ok !== true || 'failedStep' in result) return undefined
  const blocks = receipt.message.content
  const response = Array.isArray(blocks) && blocks.length === 1 ? blocks[0] : undefined
  if (response?.type !== 'tool_result' || response.is_error || !receipt.sourceToolAssistantUUID) return undefined
  const index = messages.findIndex(message => message.uuid === receipt.sourceToolAssistantUUID)
  const launch = messages[index]
  if (index >= messages.indexOf(receipt) || launch?.type !== 'assistant' || !isLiveAssistant(launch) ||
      launch.codeMode?.cellId !== receipt.codeMode?.cellId || launch.codeMode?.generation !== receipt.codeMode?.generation) return undefined
  const uses = launch.message.content.filter(block => block.type === 'tool_use' && block.id === response.tool_use_id)
  const call = uses[0]
  if (uses.length !== 1 || call?.type !== 'tool_use' || call.name !== 'CreatePeer' || !call.input ||
      typeof call.input !== 'object' || !('prompt' in call.input) || call.input.prompt !== openingBrief) return undefined
  if (messages.some(message => message !== receipt && message.type === 'user' &&
      message.sourceToolAssistantUUID === launch.uuid && Array.isArray(message.message.content) &&
      message.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === response.tool_use_id))) return undefined
  return conversationEvidence(messages.slice(0, index)).findLast(row => row.origin === 'operator' && row.id)?.id
}

export async function resolveContextualPeerParent(
  context: ToolUseContext,
  lookupLegacyCreator?: ToolUseContext['lookupLegacyPeerCreator'],
): Promise<PeerParentEvidence | undefined> {
  if (context.agentId) return undefined
  const current = context.getCurrentAutoModeMessages?.() ?? context.messages
  const origin = current.flatMap(message => {
    const attachment = message.type === 'attachment' ? message.attachment as Attachment : undefined
    const source = message.type === 'user' ? message.origin
      : queuedCommandOrigin(attachment)
    if (source?.kind !== 'peer' || !source.creationPrompt ||
        (message.type === 'user' && (message.isVirtual || message.isMeta || message.isCompactSummary ||
          message.isVisibleInTranscriptOnly || message.toolUseResult !== undefined || message.sourceToolAssistantUUID))) return []
    const input = message.type === 'user' ? message.message.content
      : attachment?.type === 'queued_command' ? attachment.prompt
      : undefined
    const onlyBlock = Array.isArray(input) && input.length === 1 ? input[0] : undefined
    const brief = typeof input === 'string' ? input : onlyBlock?.type === 'text' ? onlyBlock.text : undefined
    return [{ source, brief }]
  })
  if (origin.length !== 1) return undefined
  const { source, brief } = origin[0]!
  if (context.peerCreatorAppSessionId !== undefined && context.peerCreatorAppSessionId !== source.appSessionId) return undefined
  const linked = source.assignment
  try {
    const legacy = !linked && brief && validateUuid(source.appSessionId) ? await lookupLegacyCreator?.(source.appSessionId) : undefined
    const parentSessionId = linked?.parentSessionId ?? legacy?.parentSessionId
    if (!parentSessionId || !validateUuid(parentSessionId) || (legacy && !validateUuid(legacy.childAppSessionId))) return undefined
    const { getTranscriptPathForSession, loadTranscriptFile, selectActiveConversation, projectSessionQueueOperations } =
      await import('../sessionStorage.js')
    const path = getTranscriptPathForSession(parentSessionId)
    const fingerprint = () => {
      const file = statSync(path, { bigint: true })
      return [file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')
    }
    const before = fingerprint()
    const loaded = await loadTranscriptFile(path, { strict: true, keepAllLeaves: true })
    const transcript = selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
    const isCurrent = () => {
      try { return fingerprint() === before } catch { return false }
    }
    if (!isCurrent() || loaded.sourceTruncated || transcript.sessionId !== parentSessionId ||
        (loaded.activeConversationTip && transcript.tip?.uuid !== loaded.activeConversationTip.tipUuid) ||
        transcript.messages.some(row => row.sessionId !== parentSessionId || row.isSidechain ||
          (row.parentUuid && !loaded.messages.has(row.parentUuid)))) return undefined
    const userMessageId = linked?.userMessageId ?? (legacy && brief
      ? legacyLaunchAnchor(transcript.messages, legacy.childAppSessionId, brief)
      : undefined)
    if (!userMessageId || !validateUuid(userMessageId) ||
        !conversationEvidence(transcript.messages).some(row => row.id === userMessageId && row.origin === 'operator')) return undefined
    const { operations, messageUuids } = projectSessionQueueOperations(loaded)
    const pending = new Set<UUID>()
    for (const op of operations) {
      if (op.sessionId !== parentSessionId || !op.uuid) continue
      if (op.operation === 'enqueue' && op.mode === 'prompt' && !op.agentId && isOperatorOrigin(op.origin)) {
        pending.add(op.uuid)
      } else if (op.operation === 'popAll' ||
          (op.queueVersion === 2 && (op.operation === 'dequeue' || op.operation === 'remove'))) {
        pending.delete(op.uuid)
      }
    }
    return { reference: { parentSessionId, userMessageId }, messages: transcript.messages, isCurrent,
      pendingOperatorInput: [...pending].some(id => !messageUuids.has(id)) }
  } catch {
    return undefined
  }
}

export function workerAssignment(
  parent: ToolUseContext,
  initialMessages: readonly Message[],
  text: string,
  history?: ReadonlySet<string>,
): ContextualWorkerAssignment {
  const parentMessages = () => parent.getCurrentAutoModeMessages?.() ?? parent.messages
  const parentWorker = parent.contextualWorkerAssignment
  const evidence = conversationEvidence(parent.messages, parentWorker)
  const anchor = evidence.findLast(record => record.origin === 'operator' && record.id)?.id
  const sender = parent.agentId ?? (evidence.some(record => record.origin === 'peer') ? 'peer-session' : 'main')
  return { text, sender, excluded: new Set(initialMessages.map(message => message.uuid)),
    history, parentWorker, parentMessages, anchor, parentSignal: parent.abortController.signal }
}

export function readContextualAuthority(context: ToolUseContext, peerParent?: PeerParentEvidence) {
  const worker = context.contextualWorkerAssignment
  const messages = context.getCurrentAutoModeMessages?.() ?? context.messages
  const conversation = conversationEvidence(messages, worker, true)
  const peer = conversation.find(record => record.origin === 'peer')
  const peerSession = Boolean(context.peerCreatorAppSessionId || peer || peerParent ||
    messages.some(message => message.type === 'user' && message.summarizedRelayedInput === true))
  const actor = context.agentId ?? (peerSession ? 'peer-session' : 'main')
  for (const entry of conversation) {
    if (entry.origin === 'assistant' && !entry.actor) entry.actor = actor
  }
  const parentMessages = worker?.parentMessages() ?? (peerParent?.isCurrent() ? peerParent.messages : undefined)
  const parentEvidence = parentMessages ? conversationEvidence(parentMessages, worker?.parentWorker) : undefined
  // The launch captures the anchor before crossing into the assistant-authored
  // worker brief. A stale or compacted-away grant cannot establish authority.
  const anchor = worker?.anchor ?? peerParent?.reference.userMessageId
  const parent = anchor && parentEvidence?.some(record => record.id === anchor && record.origin === 'operator')
    ? parentEvidence : undefined
  const delegated = Boolean(context.agentId || peerSession)
  const assignment: ContextualEvidence['assignment'] = delegated ? {
    actor, origin: worker ? 'worker-launch' : 'peer',
    ...(worker ? { text: worker.text, sender: worker.sender } : peer ? { text: peer.text, sender: peer.actor } : {}),
    ...(parent && { parent, parentAnchor: anchor }),
  } : undefined
  // Keep the operator's actual follow-up available while the main query is
  // draining its queue. Unreadable inputs still fence the pending action.
  const pending = getCommandQueueSnapshot().filter(command => command.mode === 'prompt' &&
    (command.agentId === undefined || command.agentId === context.agentId) && !command.isMeta &&
    isOperatorOrigin(command.origin))
  const pendingConversation: ConversationEntry[] = []
  let unreadable = false
  for (const command of pending) {
    if (command.priority === 'now' || Object.keys(command.pastedContents ?? {}).length ||
        (Array.isArray(command.value) && command.value.some(block => block.type !== 'text'))) {
      unreadable = true
      continue
    }
    const text = typeof command.value === 'string' ? command.value :
      command.value.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (!text.trim()) unreadable = true
    else {
      const reply = parsePriorAssistantContext(command.priorAssistantContext)
      const matches = reply && messages.filter(row => row.uuid === reply.messageUuid &&
        row.type === 'assistant' && !row.isVirtual && !row.codeMode && !worker?.excluded.has(row.uuid))
      const prior = matches?.length === 1 ? readAssistantProposal(matches[0]!) : null
      pendingConversation.push({ origin: 'operator', id: command.uuid, text,
        ...(reply && prior?.binding.textHash === reply.textHash && { proposal: { id: reply.messageUuid, text: prior.text } }) })
    }
  }
  return {
    actor, delegated, assignment, conversation, pendingConversation,
    verifiedSource: Boolean(parent || conversation.some(record => record.origin === 'operator' && record.id)),
    pendingOperatorInput: Boolean(peerParent?.pendingOperatorInput) || unreadable,
    stopped: context.abortController.signal.aborted || worker?.parentSignal.aborted === true ||
      stopped(messages, conversation) || Boolean(parentMessages && parentEvidence && stopped(parentMessages, parentEvidence)),
  }
}
