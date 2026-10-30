import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import type { Message, MessageOrigin } from '../types/message.js'
import { enqueue, getCommandQueue, removeByFilter } from './messageQueueManager.js'
import { PendingQuestionRegistry, type QuestionJournalEntry, type QuestionReplyDelivery } from './pendingQuestions.js'
import { buildDisplayConversationChain, flushCurrentTranscriptDurably, flushSessionStorage, getTranscriptPathForSession, loadTranscriptFile, recordQuestionLifecycle, selectActiveConversation } from './sessionStorage.js'

export function questionReplyOrigin(delivery: QuestionReplyDelivery, engineSessionId = getSessionId()): MessageOrigin {
  return { kind: 'question-reply', batchId: delivery.batchId, questions: delivery.questions, engineSessionId }
}
export function questionReplyPrompt(delivery: QuestionReplyDelivery): string | ContentBlockParam[] {
  return delivery.images?.length ? [{ type: 'text', text: delivery.content }, ...delivery.images] : delivery.content
}
export function acceptedQuestionReplyUuids(messages: readonly Message[]): Set<string> {
  const accepted = new Set<string>()
  for (const message of messages) {
    if (message.type === 'user' && message.origin?.kind === 'question-reply') accepted.add(message.uuid)
    if (message.type === 'attachment' && message.attachment && typeof message.attachment === 'object') {
      const attachment = message.attachment as { type?: string; origin?: MessageOrigin; source_uuid?: string }
      if (attachment.type === 'queued_command' && attachment.origin?.kind === 'question-reply' && typeof attachment.source_uuid === 'string') accepted.add(attachment.source_uuid)
    }
  }
  return accepted
}
function activeQuestionCalls(messages: readonly Message[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) if (block.type === 'tool_use' && block.name === 'AskUserQuestion') ids.set(block.id, message.uuid)
  }
  return ids
}

/** One owner per engine, including a trusted outbox distinct from recovered composer drafts. */
export class PendingQuestionRuntime {
  readonly registry: PendingQuestionRegistry
  private readonly journal: QuestionJournalEntry[] = []
  private accepted = new Set<string>()
  private enqueued = new Set<string>()
  private initialized = false
  private initialization: Promise<void> | null = null
  private sessionId = getSessionId()
  private resetSession = false
  constructor(private readonly messages: () => readonly Message[]) {
    this.registry = new PendingQuestionRegistry(async entry => {
      if (!isSessionPersistenceDisabled()) await recordQuestionLifecycle(entry)
      this.journal.push(structuredClone(entry))
    })
  }
  initialize(): Promise<void> {
    const sessionChanged = this.sessionId !== getSessionId()
    const recoveringWrite = !sessionChanged && this.registry.needsRecovery()
    if (sessionChanged) { this.sessionId = getSessionId(); this.resetSession = true }
    if (recoveringWrite || sessionChanged) { this.initialized = false; this.initialization = null }
    if (this.initialized) return Promise.resolve()
    return this.initialization ??= this.restore(recoveringWrite).then(() => { this.initialized = true })
  }
  async restore(preserveTurn = false): Promise<void> {
    await this.registry.waitForWrites()
    if (this.resetSession) {
      const old = new Set(this.enqueued)
      removeByFilter(command => command.origin?.kind === 'question-reply' && !!command.uuid && old.has(command.uuid))
      this.journal.length = 0
      this.enqueued.clear()
      this.accepted.clear()
      this.resetSession = false
    }
    let messages = this.messages()
    let accepted = acceptedQuestionReplyUuids(messages)
    if (!isSessionPersistenceDisabled()) {
      try {
        await flushSessionStorage()
        if (this.registry.needsRecovery()) await flushCurrentTranscriptDurably()
        const path = getTranscriptPathForSession(getSessionId())
        const { size } = await stat(path)
        if (!size) {
          messages = []
          accepted.clear()
          this.journal.length = 0
        } else {
          const loaded = await loadTranscriptFile(path, { prefixBytes: size, keepAllLeaves: true, keepCompactedHistory: true, strict: true })
          if (loaded.sourceTruncated) throw new Error('Question history was truncated')
          const active = selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
          const receipts = acceptedQuestionReplyUuids([...loaded.messages.values()] as Message[])
          accepted = new Set(receipts)
          // A reservation is not delivery. Explicit cancellation is a later
          // user decision and must not be undone by outbox recovery.
          for (const operation of loaded.queueOperations) {
            if (!operation.uuid) continue
            if (operation.operation === 'enqueue') accepted.delete(operation.uuid)
            else if (operation.operation === 'popAll' || operation.queueVersion === 2 &&
              (operation.operation === 'remove' || operation.operation === 'dequeue')) accepted.add(operation.uuid)
          }
          for (const uuid of receipts) accepted.add(uuid)
          const full = active.tip ? buildDisplayConversationChain(loaded.messages, active.tip) : []
          messages = full as Message[]
          this.journal.splice(0, this.journal.length, ...loaded.questionLifecycles)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.accepted = accepted
    const active = activeQuestionCalls(messages)
    this.registry.restore(this.journal, new Set(active.keys()), preserveTurn, active)
    const eligible = new Set(this.registry.undelivered(this.accepted).map(delivery => delivery.uuid))
    for (const command of removeByFilter(command => command.origin?.kind === 'question-reply' && !!command.uuid && !eligible.has(command.uuid))) {
      if (command.uuid) this.enqueued.delete(command.uuid)
    }
  }
  deliver(): void {
    if (this.sessionId !== getSessionId()) return
    const accepted = new Set([...this.accepted, ...acceptedQuestionReplyUuids(this.messages())])
    for (const delivery of this.registry.undelivered(accepted)) {
      if (this.enqueued.has(delivery.uuid) || getCommandQueue().some(command => command.uuid === delivery.uuid)) continue
      this.enqueued.add(delivery.uuid)
      enqueue({ mode: 'prompt', value: questionReplyPrompt(delivery), uuid: delivery.uuid as UUID, origin: questionReplyOrigin(delivery, this.sessionId), priority: 'next' })
    }
  }
}
