import type { UUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentId } from './ids.js'

/**
 * Restored 2026-08-17. This module is imported by `src/types/logs.ts`,
 * `src/utils/messageQueueManager.ts` and `src/utils/sessionStorage.ts` but had
 * NO history in this repo — it never survived the fork snapshot. Because
 * `QueueOperationMessage` is a member of the `Entry` union in `logs.ts`, the
 * missing module made `Entry` itself resolve to `any`, and `any` in a union
 * swallows the union: every `Entry`-typed surface in `sessionStorage.ts` was
 * unchecked, including `appendEntry` and the whole `entry.type === …` dispatch.
 * That is how `popAllEditable` passed a plain string where a `QueuedCommand`
 * belongs, writing retraction records with no uuid, which in turn resurrected
 * recalled messages on every restore.
 *
 * The shapes below are reconstructed from the two ends that survived: what
 * `logOperation` writes (`messageQueueManager.ts`) and what `loadTranscriptFile`
 * reads back into `SessionQueueOperation` (`sessionStorage.ts`). Keep the two in
 * step — this is the write side, `SessionQueueOperation` is the read side.
 */

/**
 * Anything other than `enqueue` is a retraction: the command left the queue.
 * Readers must test for `enqueue` rather than enumerate the retractions, so
 * adding a member here does not silently change how an old reader classifies it.
 */
export type QueueOperation = 'enqueue' | 'dequeue' | 'remove' | 'popAll'

/** One durable record per queue mutation, as written to the session JSONL. */
export type QueueOperationMessage = {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  /**
   * The command this operation acted on. Absent only in records written before
   * the retraction fix, which a reader cannot subtract and must ignore.
   */
  uuid?: UUID
  /**
   * Agent this notification was addressed to; undefined = main thread. Carried
   * on every operation (enqueue and retraction alike), like `uuid`, so a reader
   * doesn't have to cross-reference the original enqueue to see who a dequeue
   * or remove belonged to.
   */
  agentId?: AgentId
  /** Recorded on `enqueue` only: it is how a reader tells a prompt from a task notification. */
  mode?: string
  /**
   * Recorded on `enqueue` only. A prompt carrying images is a
   * `ContentBlockParam[]`, so this is not a string in every session.
   */
  content?: string | ContentBlockParam[]
}
