import { constants as fsConstants } from 'node:fs'
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { lstat, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import z from 'zod/v4'
import type { Message } from '../types/message.js'
import { getClaudeConfigHomeDir } from './envUtils.js'

/**
 * Durable record of a turn that was cut off before it finished.
 *
 * Written at the interruption, read once at resume. It exists so a resumed
 * session can continue from the exact text the model had already produced
 * instead of the generic `Continue from where you left off.` prompt, and it is
 * bound to the transcript position it was captured at so it can never be
 * grafted onto a different branch of history.
 *
 * CRASH DURABILITY, stated honestly: this record is written by cooperative
 * interruption paths only. A SIGKILL, an OOM kill, or a power loss runs no
 * user code, so no record exists and resume falls back to the generic
 * continuation. The partial output that only ever lived in the streaming
 * accumulator is lost in those cases; nothing here recovers it.
 */
export type InterruptedTurnReason = 'user_abort' | 'aborted'

export type InterruptedTurnRecordV1 = {
  version: 1
  sessionId: string
  /**
   * Transcript leaf the interruption happened at: the uuid of the last
   * user/assistant message on the active chain. The match predicate.
   */
  leafUuid: string
  /**
   * Newest compact boundary on the chain at capture time, or null. Diagnostic
   * only, deliberately NOT part of the match predicate: a compaction that
   * preserves the recent suffix verbatim keeps `leafUuid` on the chain while
   * introducing a new boundary, and that case must still apply.
   */
  boundaryUuid?: string
  /** Assistant/tool message that was mid-flight, when it had reached the transcript. */
  interruptedMessageUuid?: string
  /** Provider message id of the interrupted assistant message, when known. */
  interruptedMessageId?: string
  /** Exact assistant text produced before the interruption. */
  partialOutput: string
  /** True when `partialOutput` holds only the tail of a longer output. */
  partialOutputTruncated: boolean
  reason: InterruptedTurnReason
  capturedAt: number
}

/**
 * Cap on the persisted partial output.
 *
 * The text is re-injected into model context on resume, so it is bounded well
 * below anything that could move the compaction threshold on its own. On
 * overflow the TAIL is kept: continuation happens at the end of the output, so
 * the last bytes are the ones that decide where the model picks up.
 */
export const MAX_PARTIAL_OUTPUT_BYTES = 32 * 1024

/**
 * Ceiling on a record read back from disk. A record this size cannot have been
 * written by `captureInterruptedTurn`, so anything larger is refused instead of
 * parsed.
 */
export const MAX_INTERRUPTED_TURN_RECORD_BYTES = 128 * 1024

/**
 * A record older than this is discarded unapplied even when its leaf still
 * matches. Partial output describes work in flight; a day later the files, the
 * tools, and the user's intent have moved, and continuing from stale text is
 * worse than the generic continuation it would replace.
 */
export const INTERRUPTED_TURN_MAX_AGE_MS = 24 * 60 * 60 * 1000

const uuidLike = z.string().min(1).max(200)

export const interruptedTurnRecordSchema = z
  .object({
    version: z.literal(1),
    sessionId: uuidLike,
    leafUuid: uuidLike,
    boundaryUuid: uuidLike.optional(),
    interruptedMessageUuid: uuidLike.optional(),
    interruptedMessageId: z.string().max(200).optional(),
    partialOutput: z.string().min(1).max(MAX_PARTIAL_OUTPUT_BYTES * 4),
    partialOutputTruncated: z.boolean(),
    reason: z.enum(['user_abort', 'aborted']),
    capturedAt: z.number().finite().nonnegative(),
  })
  .strict()

export function getInterruptedTurnDir(): string {
  return join(getClaudeConfigHomeDir(), 'interrupted-turns')
}

/**
 * Session ids address a file, so they are restricted to the characters a uuid
 * can contain. Anything else cannot name a record.
 */
function recordPath(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || sessionId.startsWith('.')) {
    throw new Error('Invalid session id for interrupted-turn record')
  }
  return join(getInterruptedTurnDir(), `${sessionId}.json`)
}

/**
 * The transcript position a record is bound to: the last user/assistant message
 * on the chain.
 *
 * user/assistant are the only message types guaranteed to reach the transcript
 * (attachments are dropped by `isLoggableMessage` for non-ant users, and
 * system/progress records are bookkeeping), so this is the one definition that
 * yields the same answer at capture time from in-memory messages and at resume
 * time from the loaded chain.
 */
export function computeTranscriptLeafUuid(
  messages: readonly Message[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.type === 'user' || message.type === 'assistant') {
      return message.uuid ? String(message.uuid) : null
    }
  }
  return null
}

/** Newest compact boundary on the chain, for diagnostics on the record. */
export function findLatestCompactBoundaryUuid(
  messages: readonly Message[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (
      message?.type === 'system' &&
      'subtype' in message &&
      message.subtype === 'compact_boundary'
    ) {
      return message.uuid ? String(message.uuid) : null
    }
  }
  return null
}

/** Keep the tail: continuation resumes at the end of the produced text. */
function boundPartialOutput(text: string): {
  partialOutput: string
  partialOutputTruncated: boolean
} {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= MAX_PARTIAL_OUTPUT_BYTES) {
    return { partialOutput: text, partialOutputTruncated: false }
  }
  const tail = bytes.subarray(bytes.byteLength - MAX_PARTIAL_OUTPUT_BYTES)
  // Drop a leading partial UTF-8 sequence created by slicing on a byte bound.
  return {
    partialOutput: new TextDecoder('utf8').decode(tail).replace(/^�+/, ''),
    partialOutputTruncated: true,
  }
}

function ensureStoreDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * Synchronous on purpose.
 *
 * The headless SIGINT handler aborts the in-flight query and then shuts the
 * process down (`src/cli/print.ts`), so capture races teardown and a write
 * queued behind the event loop is not guaranteed to land. The payload is a
 * single small JSON file, so blocking is cheap next to losing the record the
 * feature exists for.
 */
function writeRecordSync(path: string, record: InterruptedTurnRecordV1): void {
  const dir = getInterruptedTurnDir()
  ensureStoreDirSync(dir)
  const tempPath = join(dir, `.${process.pid}.${Date.now()}.tmp`)
  const fd = openSync(
    tempPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  )
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best effort: the rename failure is what matters.
    }
    throw error
  }
}

/**
 * Text the model actually produced this turn. Thinking blocks are excluded on
 * purpose: they are not output, and quoting them back as "what you produced"
 * would invite the model to treat reasoning as delivered work.
 */
export function extractAssistantOutputText(
  assistantMessages: readonly Message[],
): string {
  const parts: string[] = []
  for (const message of assistantMessages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('')
}

export type CaptureInterruptedTurnInput = {
  sessionId: string | undefined
  /**
   * The conversation as it will be persisted, ending with the interruption
   * marker the abort path just emitted. The leaf is derived from this with the
   * same function resume uses, so capture and resume can never disagree about
   * what the leaf is.
   */
  messages: readonly Message[]
  /** Assistant messages produced by the interrupted turn. */
  assistantMessages: readonly Message[]
  reason: InterruptedTurnReason
  now?: number
}

/**
 * Persist the interruption. Returns the record written, or null when there is
 * nothing worth persisting (no session, no transcript position, or no output to
 * carry across).
 *
 * Never throws: a failed capture must not turn an interruption into a crash.
 */
export function captureInterruptedTurn(
  input: CaptureInterruptedTurnInput,
): InterruptedTurnRecordV1 | null {
  const partial = extractAssistantOutputText(input.assistantMessages)
  if (!input.sessionId || partial.trim().length === 0) return null
  const leafUuid = computeTranscriptLeafUuid(input.messages)
  if (!leafUuid) return null

  const lastAssistant = input.assistantMessages.findLast(
    message => message.type === 'assistant',
  )
  const bounded = boundPartialOutput(partial)
  const record: InterruptedTurnRecordV1 = {
    version: 1,
    sessionId: input.sessionId,
    leafUuid,
    boundaryUuid: findLatestCompactBoundaryUuid(input.messages) ?? undefined,
    interruptedMessageUuid: lastAssistant?.uuid
      ? String(lastAssistant.uuid)
      : undefined,
    interruptedMessageId:
      lastAssistant?.type === 'assistant' &&
      typeof lastAssistant.message.id === 'string'
        ? lastAssistant.message.id
        : undefined,
    partialOutput: bounded.partialOutput,
    partialOutputTruncated: bounded.partialOutputTruncated,
    reason: input.reason,
    capturedAt: input.now ?? Date.now(),
  }

  try {
    const parsed = interruptedTurnRecordSchema.parse(record)
    writeRecordSync(recordPath(parsed.sessionId), parsed)
    // Self-limiting store: the only records that accumulate belong to sessions
    // that were interrupted and never resumed, and this is the only path that
    // creates them, so the sweep costs nothing on a machine that never
    // interrupts a turn.
    void pruneInterruptedTurnRecords().catch(() => {})
    return parsed
  } catch {
    return null
  }
}

/**
 * Read the record for a session without consuming a valid record.
 *
 * Invalid records are retired immediately because no adoption can ever apply
 * them. Valid records remain available until the caller adopts the resume.
 */
export async function readInterruptedTurnRecord(
  sessionId: string | undefined,
): Promise<InterruptedTurnRecordV1 | null> {
  if (!sessionId) return null
  let path: string
  try {
    path = recordPath(sessionId)
  } catch {
    return null
  }
  let raw: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_INTERRUPTED_TURN_RECORD_BYTES) {
      await unlink(path).catch(() => {})
      return null
    }
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  const parsed = interruptedTurnRecordSchema.safeParse(
    ((): unknown => {
      try {
        return JSON.parse(raw)
      } catch {
        return null
      }
    })(),
  )
  if (!parsed.success) {
    await unlink(path).catch(() => {})
    return null
  }
  return parsed.data
}

/**
 * Retire the record read for an adopted resume.
 *
 * The identity check avoids deleting a newer interruption that replaced the
 * record while the conversation was being loaded.
 */
export async function consumeInterruptedTurnRecord(
  sessionId: string | undefined,
  expected: InterruptedTurnRecordV1,
): Promise<void> {
  const current = await readInterruptedTurnRecord(sessionId)
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return
  try {
    await unlink(recordPath(current.sessionId))
  } catch {
    // Another process consumed or replaced it.
  }
}

/**
 * Read and consume the record for callers that adopt immediately.
 *
 * Consuming is unconditional: whether the record applies or is discarded on a
 * leaf mismatch, it describes one interruption and must not be reconsidered by
 * the next resume of the same session.
 */
export async function takeInterruptedTurnRecord(
  sessionId: string | undefined,
): Promise<InterruptedTurnRecordV1 | null> {
  const record = await readInterruptedTurnRecord(sessionId)
  if (record) await consumeInterruptedTurnRecord(sessionId, record)
  return record
}

export type InterruptedTurnMatch =
  | { status: 'apply'; record: InterruptedTurnRecordV1 }
  | { status: 'discard'; reason: 'leaf_mismatch' | 'expired' }

/**
 * Bind the record to the branch it was captured on.
 *
 * The leaf uuid is compared against the leaf of the conversation actually being
 * resumed. A mismatch means the transcript moved on after the interruption:
 * another turn ran, a fork diverged, or a compaction summarized the captured
 * leaf away. Applying the partial output there would attribute text the model
 * never produced on that branch, so it is discarded instead.
 *
 * A compaction that preserves the recent suffix verbatim keeps the captured
 * leaf as the chain leaf, so it still matches. That is why the boundary uuid on
 * the record is diagnostic and not compared.
 */
export function matchInterruptedTurnRecord(
  record: InterruptedTurnRecordV1 | null | undefined,
  messages: readonly Message[],
  now: number = Date.now(),
): InterruptedTurnMatch | null {
  if (!record) return null
  if (now - record.capturedAt > INTERRUPTED_TURN_MAX_AGE_MS) {
    return { status: 'discard', reason: 'expired' }
  }
  if (computeTranscriptLeafUuid(messages) !== record.leafUuid) {
    return { status: 'discard', reason: 'leaf_mismatch' }
  }
  return { status: 'apply', record }
}

const OUTPUT_OPEN_TAG = '<interrupted-output>'
const OUTPUT_CLOSE_TAG = '</interrupted-output>'

const REASON_CLAUSE: Record<InterruptedTurnReason, string> = {
  user_abort: 'the user interrupted it',
  aborted: 'the session was interrupted',
}

/**
 * The continuation prompt that replaces `Continue from where you left off.`
 * when a record applies. Meta message, so it is model context and not a user
 * surface.
 *
 * The payload is model-authored text being quoted back into a prompt, so the
 * closing fence is neutralized inside it. Without that, output that happened to
 * contain the literal close tag would end the quoted block early and the
 * remainder would read as instructions.
 */
export function formatInterruptedTurnContinuation(
  record: InterruptedTurnRecordV1,
): string {
  const truncationNote = record.partialOutputTruncated
    ? ' The earlier part of that output was dropped for length, so only its ending is shown.'
    : ''
  return [
    `Your previous turn stopped before it finished because ${REASON_CLAUSE[record.reason]}.`,
    `This is the exact output you had already produced.${truncationNote}`,
    OUTPUT_OPEN_TAG,
    record.partialOutput.replaceAll(OUTPUT_CLOSE_TAG, '[/interrupted-output]'),
    OUTPUT_CLOSE_TAG,
    'Continue from the end of that output. Do not repeat any of it, and do not start over.',
  ].join('\n')
}

/**
 * Age-based sweep of the store.
 *
 * Records are consumed when a loaded conversation is adopted, so the only ones
 * that accumulate belong to sessions that were interrupted and never resumed.
 * Cheap, bounded, and run from the capture path rather than a timer, so a
 * machine that never interrupts a turn never pays for it.
 */
export async function pruneInterruptedTurnRecords(
  now: number = Date.now(),
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(getInterruptedTurnDir())
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    // `.tmp` files are swept too: a rename that failed after the temp write
    // leaves one behind, and nothing else ever collects it.
    if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
    const path = join(getInterruptedTurnDir(), name)
    try {
      const info = await lstat(path)
      if (now - info.mtimeMs <= INTERRUPTED_TURN_MAX_AGE_MS) continue
      await unlink(path)
      removed++
    } catch {
      // Another process consumed it, or it is unreadable. Neither is ours to fix.
    }
  }
  return removed
}
