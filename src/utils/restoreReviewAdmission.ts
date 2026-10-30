import type { Message, UserMessage } from '../types/message.js'
import { getSessionId, isSessionPersistenceDisabled } from '../bootstrap/state.js'
import { recordTranscript, flushCurrentTranscriptDurably, markActiveConversationTip, verifyActiveTranscriptTipDurably, getTranscriptPathForSession } from './sessionStorage.js'
import { acceptTailRecoveryReview, readTailRecoveryState } from './transcriptTailRecovery.js'
import { runDeferredResumeHooks } from './deferredResumeHooks.js'
import { selectableUserMessagesFilter } from '../components/MessageSelector.js'

export function isGenuineReviewInput(message: Message): message is UserMessage {
  return selectableUserMessagesFilter(message) && !message.origin && !message.isVirtual &&
    !message.sourceToolAssistantUUID && message.toolUseResult === undefined &&
    !(Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'tool_result'))
}

/** Freshness comes from the consuming caller's new-message list, not message text. */
export class RestoreReviewAdmission {
  private held: boolean
  constructor(required: boolean) {
    this.held = required || (readTailRecoveryState(getTranscriptPathForSession(getSessionId()), getSessionId())?.reviewRequired ?? false)
  }
  get required(): boolean { return this.held }
  canStartAutomaticTurn(): boolean { return !this.held }
  canProcessCommand(command: { mode: string; isMeta?: boolean; origin?: unknown }, automatic = false): boolean {
    return !this.held || (!automatic && command.mode === 'prompt' && !command.isMeta && !command.origin)
  }
  /** Headless uses the real QueryEngine callback, after its input fsync. */
  inputPersisted(): void { this.held = false }
  inputAdmittedEphemerally(): void {
    if (!isSessionPersistenceDisabled() || readTailRecoveryState(getTranscriptPathForSession(getSessionId()), getSessionId())?.reviewRequired) {
      throw new Error('Recovery input requires durable admission')
    }
    this.held = false
  }
  async admitTerminalInput(history: Message[], fresh: Message[]): Promise<Message[]> {
    if (!this.held) return []
    const input = fresh.find(message => isGenuineReviewInput(message) &&
      history.filter(row => row.uuid === message.uuid).length === 1)
    if (!input) throw new Error('Saved progress needs a new user message before continuing')
    const path = getTranscriptPathForSession(getSessionId())
    const tail = readTailRecoveryState(path, getSessionId())
    if (isSessionPersistenceDisabled()) {
      if (tail?.reviewRequired) throw new Error('Recovered history cannot continue without durable user input')
      // Explicit ephemeral sessions can review intact interrupted history, but
      // publish no durable acceptance and will be held again on another restore.
      const context = await runDeferredResumeHooks()
      this.held = false
      return context
    }
    const tip = await recordTranscript(history)
    if (!tip) throw new Error('Recovery input was not persisted')
    await flushCurrentTranscriptDurably(input.uuid)
    await markActiveConversationTip(tip)
    await verifyActiveTranscriptTipDurably(tip, input.uuid)
    const context = await runDeferredResumeHooks()
    if (context.length) {
      await recordTranscript([...history, ...context])
      await flushCurrentTranscriptDurably(input.uuid)
    }
    if (tail?.reviewRequired) acceptTailRecoveryReview(path, getSessionId(), input.uuid)
    this.held = false
    return context
  }
}
