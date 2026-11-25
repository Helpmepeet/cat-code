import type { ToolUseContext } from '../../Tool.js'
import { CROSS_SESSION_MESSAGE_TAG } from '../../constants/xml.js'
import type { AssistantMessage, Message, MessageOrigin } from '../../types/message.js'
import type { Attachment } from '../attachments.js'
import { SYNTHETIC_MODEL } from '../messages.js'
import { getCommandQueueSnapshot } from '../messageQueueManager.js'
import { wasTurnStopped } from '../abortController.js'
import { queuedCommandOrigin } from '../taskNotification.js'
import { isRelayedOrigin } from '../messageOrigin.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { askUserQuestionAnswerText, positionPermissionDecisionContexts } from './permissionDecisionContext.js'
import { parsePriorAssistantContext, readAssistantProposal } from './priorAssistantContext.js'
import type { ContextualEvidence } from './contextualReviewPrompt.js'

type Conversation = ContextualEvidence['conversation']
type ConversationEntry = Conversation[number]

const PEER_ENVELOPE = new RegExp(`^<${CROSS_SESSION_MESSAGE_TAG} from="[^"]*">\\n([\\s\\S]*)\\n</${CROSS_SESSION_MESSAGE_TAG}>$`, 'u')

function isOperatorOrigin(origin: MessageOrigin | undefined): boolean {
  return !origin || origin.kind === 'human' || origin.kind === 'peer' ||
    (origin.kind === 'question-reply' && !isRelayedOrigin(origin))
}

function operatorText(text: string, origin: MessageOrigin | undefined): string {
  // Provenance comes from the receiving host. The envelope is model-facing text.
  return origin?.kind === 'peer' && !origin.creationPrompt ? PEER_ENVELOPE.exec(text)?.[1] ?? text : text
}

function isOperatorQueueMode(mode: string | undefined, origin: MessageOrigin | undefined): boolean {
  return mode === undefined || mode === 'prompt' ||
    (mode === 'task-notification' && origin?.kind === 'peer')
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
  includeCoordinator = false,
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
    if (source?.kind === 'teammate') {
      evidence.push({ origin: 'peer', id: message.uuid, text: content })
      continue
    }
    if (source?.kind === 'coordinator' && includeCoordinator) {
      evidence.push({ origin: 'assistant', id: message.uuid, actor: 'coordinator', text: content })
      continue
    }
    if (!isOperatorOrigin(source) || user?.isMeta ||
        (queued && (queued.isMeta || !isOperatorQueueMode(queued.commandMode, source)))) continue
    // Previous launch and resume briefs are stored as user-role messages.
    // Without a recorded author, that role does not establish operator authority.
    if (!source && worker?.history?.has(message.uuid)) {
      evidence.push({ origin: 'other', id: message.uuid, actor: 'worker history', text: content })
      continue
    }
    const reply = parsePriorAssistantContext(user?.priorAssistantContext ??
      (queued && 'priorAssistantContext' in queued ? queued.priorAssistantContext : undefined))
    const prior = reply ? proposals.get(reply.messageUuid) : undefined
    evidence.push({ origin: 'operator', id: message.uuid, text: operatorText(content, source),
      ...(source?.kind === 'peer' && { actor: source.name }),
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
  // A stop belongs to this chat. A peer delivery cannot resume stopped work.
  const lastLocalOperator = evidence.findLast(record =>
    record.origin === 'operator' && record.actor === undefined && record.id)?.id
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type === 'user' && row.origin?.kind === 'interruption') return true
    if (row.uuid === lastLocalOperator) return false
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

export type ContextualWorkerParentBinding = Pick<ContextualWorkerAssignment, 'anchor' | 'sender'>

export function findContextualAssignmentMessage(context: ToolUseContext): { id: string; text: string } | undefined {
  if (context.agentId !== undefined) return undefined
  const evidence = conversationEvidence(context.messages)
  const entry = evidence.findLast(record => record.origin === 'operator' && record.id)
  return entry?.id ? { id: entry.id, text: entry.text } : undefined
}

export function captureContextualWorkerParent(parent: ToolUseContext): ContextualWorkerParentBinding {
  const evidence = conversationEvidence(parent.messages, parent.contextualWorkerAssignment)
  const anchor = evidence.findLast(record => record.origin === 'operator' && record.id)?.id
  const sender = parent.agentId ?? (parent.peerCreatorAppSessionId ? 'peer-session' : 'main')
  return { anchor, sender }
}

export function workerAssignment(
  parent: ToolUseContext,
  initialMessages: readonly Message[],
  text: string,
  history?: ReadonlySet<string>,
  parentBinding = captureContextualWorkerParent(parent),
): ContextualWorkerAssignment {
  const parentMessages = () => parent.getCurrentAutoModeMessages?.() ?? parent.messages
  const parentWorker = parent.contextualWorkerAssignment
  return { text, ...parentBinding, excluded: new Set(initialMessages.map(message => message.uuid)),
    history, parentWorker, parentMessages,
    parentSignal: parent.launchingTurnSignal ?? parent.abortController.signal }
}

export function readContextualAuthority(context: ToolUseContext) {
  const worker = context.contextualWorkerAssignment
  const messages = context.getCurrentAutoModeMessages?.() ?? context.messages
  const conversation = conversationEvidence(messages, worker, true)
  const actor = context.agentId ?? (context.peerCreatorAppSessionId ? 'peer-session' : 'main')
  for (const entry of conversation) {
    if (entry.origin === 'assistant' && !entry.actor) entry.actor = actor
  }
  const parentMessages = worker?.parentMessages()
  const parentEvidence = parentMessages ? conversationEvidence(parentMessages, worker?.parentWorker) : undefined
  // The launch captures the anchor before crossing into the assistant-authored
  // worker brief. A stale or compacted-away grant cannot establish authority.
  const anchor = worker?.anchor
  const parent = anchor && parentEvidence?.some(record => record.id === anchor && record.origin === 'operator')
    ? parentEvidence : undefined
  const delegated = Boolean(context.agentId)
  const assignment: ContextualEvidence['assignment'] = delegated ? {
    actor, origin: 'worker-launch',
    ...(worker && { text: worker.text, sender: worker.sender }),
    ...(parent && { parent, parentAnchor: anchor }),
  } : undefined
  // Keep the operator's actual follow-up available while the main query is
  // draining its queue. Unreadable inputs still fence the pending action.
  const pending = getCommandQueueSnapshot().filter(command => isOperatorQueueMode(command.mode, command.origin) &&
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
      pendingConversation.push({ origin: 'operator', id: command.uuid, text: operatorText(text, command.origin),
        ...(command.origin?.kind === 'peer' && { actor: command.origin.name }),
        ...(reply && prior?.binding.textHash === reply.textHash && { proposal: { id: reply.messageUuid, text: prior.text } }) })
    }
  }
  return {
    actor, delegated, assignment, conversation, pendingConversation,
    verifiedSource: Boolean(parent || conversation.some(record => record.origin === 'operator' && record.id)),
    pendingOperatorInput: unreadable,
    stopped: context.abortController.signal.aborted ||
      Boolean(worker && wasTurnStopped(worker.parentSignal)) ||
      stopped(messages, conversation),
  }
}
