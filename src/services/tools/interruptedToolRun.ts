import type { Message } from '../../types/message.js'
import { logError } from '../../utils/log.js'

type Update = { message?: Message }
type Sink = (message: Message, isCurrent: () => boolean) => Promise<void>

export const UNRESOLVED_TOOL_MESSAGE = 'Some tool actions have not finished. New work is blocked until their results are saved.'

/** One interrupted foreground tool batch per session. Never a completion receipt. */
export class InterruptedToolRun {
  constructor(private readonly sessionKey?: string) {}
  private pending = false
  private generation = 0
  private sink?: Sink
  private onSettled?: () => void
  private wake?: () => void
  private failed = false
  private cancel?: () => void
  private additional: { iterator: AsyncIterator<Update>; first: Promise<IteratorResult<Update>> }[] = []
  private publicationLane: Promise<void> = Promise.resolve()
  private readonly settled = new Set<() => void>()

  get blocked(): boolean {
    return this.pending || !!(this.sessionKey && [...sessions.entries()].some(
      ([key, run]) => run.pending && JSON.parse(key)[0] === JSON.parse(this.sessionKey!)[0],
    ))
  }
  get ownPending(): boolean { return this.pending }
  isAttachedToSession(sessionId: string): boolean {
    return !!this.sink && !!this.sessionKey && JSON.parse(this.sessionKey)[0] === sessionId
  }

  subscribe = (listener: () => void): (() => void) => {
    sessionListeners.add(listener)
    return () => { sessionListeners.delete(listener) }
  }
  getSnapshot = (): boolean => this.blocked
  whenSettled(): Promise<void> {
    return this.pending ? new Promise(resolve => this.settled.add(resolve)) : Promise.resolve()
  }

  attach(sink: Sink, onSettled?: () => void): { isCurrent: () => boolean; dispose: () => void } {
    const generation = ++this.generation
    this.sink = sink
    this.onSettled = onSettled
    this.wake?.()
    this.wake = undefined
    return {
      isCurrent: () => generation === this.generation,
      dispose: () => {
        if (generation !== this.generation) return
        this.generation++
        this.sink = undefined
        this.onSettled = undefined
      },
    }
  }

  retryDelivery(): void {
    this.wake?.(); this.wake = undefined
    if (!this.sessionKey) return
    const sessionId = JSON.parse(this.sessionKey)[0]
    for (const [key, run] of sessions) {
      if (JSON.parse(key)[0] !== sessionId) continue
      run.wake?.(); run.wake = undefined
    }
  }
  cancelPending(): void {
    this.cancel?.()
    if (!this.sessionKey) return
    const sessionId = JSON.parse(this.sessionKey)[0]
    for (const [key, run] of sessions) if (JSON.parse(key)[0] === sessionId) run.cancel?.()
  }

  /** Healthy detached publication uses the same durable sink without setting a fence. */
  publish(message: Message): Promise<void> {
    return this.writeReceipt(message, false)
  }

  private writeReceipt(message: Message, retained: boolean): Promise<void> {
    const generation = this.generation
    const sink = this.sink
    const operation = this.publicationLane.then(async () => {
      if (!retained && this.pending) throw new Error(UNRESOLVED_TOOL_MESSAGE)
      if (!sink) throw new Error('Tool receipt owner is unavailable')
      if (generation !== this.generation || sink !== this.sink) throw new Error('Tool receipt owner changed before delivery')
      await sink(message, () => generation === this.generation)
      if (generation !== this.generation) throw new Error('Tool receipt owner changed during delivery')
    })
    this.publicationLane = operation.then(() => {}, () => {})
    return operation
  }

  /** Aggregate independent cancelled/undelivered cells under the real owner. */
  retainAdditional(iterator: AsyncIterator<Update>, first: Promise<IteratorResult<Update>>, cancel?: () => void): void {
    if (!this.pending) { this.retain(iterator, first, cancel); return }
    this.additional.push({ iterator, first })
    const previousCancel = this.cancel
    this.cancel = () => { previousCancel?.(); cancel?.() }
  }

  retain(iterator: AsyncIterator<Update>, first: Promise<IteratorResult<Update>>, cancel?: () => void): void {
    if (this.pending) throw new Error(UNRESOLVED_TOOL_MESSAGE)
    this.pending = true
    this.cancel = cancel
    if (this.sessionKey) sessions.set(this.sessionKey, this)
    notifySessionListeners()
    void this.reconcile(iterator, first).catch(error => {
      // The execution outcome is unknown. Keep the ownership fence, not a fake result.
      this.failed = true
      logError(error)
    })
  }

  private async reconcile(iterator: AsyncIterator<Update>, first: Promise<IteratorResult<Update>>): Promise<void> {
    let currentIterator = iterator
    let next = await first
    while (true) {
    while (!next.done) {
      const message = next.value.message
      // Progress belongs to the foreground UI and has no transcript UUID on disk.
      // Waiting for it to become durable would strand the tool result behind it.
      if (message && message.type !== 'progress') {
        while (true) {
          const sink = this.sink
          const generation = this.generation
          if (sink) {
            try {
              await this.writeReceipt(message, true)
              if (generation === this.generation) break
            } catch (error) {
              // Storage/delivery failure retains both the receipt and admission fence.
              logError(error)
            }
          }
          if (generation !== this.generation) continue
          await new Promise<void>(resolve => { this.wake = resolve })
        }
      }
      next = await currentIterator.next()
    }
    const additional = this.additional.shift()
    if (!additional) break
    currentIterator = additional.iterator
    next = await additional.first
    }
    if (!this.failed) {
      this.pending = false
      this.cancel = undefined
      if (this.sessionKey && sessions.get(this.sessionKey) === this) sessions.delete(this.sessionKey)
      this.settled.forEach(resolve => resolve())
      this.settled.clear()
      notifySessionListeners()
      try { this.onSettled?.() } catch (error) { logError(error) }
    }
  }
}

// Only unresolved runs survive caller replacement. No eviction can imply completion.
const sessions = new Map<string, InterruptedToolRun>()
const sessionListeners = new Set<() => void>()
function notifySessionListeners(): void {
  for (const listener of sessionListeners) {
    try { listener() } catch (error) { logError(error) }
  }
}
const owners = new Map<string, WeakRef<InterruptedToolRun>>()
const expiredOwners = new FinalizationRegistry<string>(key => {
  if (!owners.get(key)?.deref()) owners.delete(key)
})
export function getInterruptedToolRun(sessionId: string, agentId?: string): InterruptedToolRun {
  const key = JSON.stringify([sessionId, agentId ?? null])
  const existing = sessions.get(key) ?? owners.get(key)?.deref()
  if (existing) return existing
  const owner = new InterruptedToolRun(key)
  owners.set(key, new WeakRef(owner))
  expiredOwners.register(owner, key)
  return owner
}

/** Transfer the original iterator only after a bounded foreground settlement wait. */
export async function* settleInterruptedTools(
  iterator: AsyncIterator<Update>, owner: InterruptedToolRun, signal: AbortSignal,
  cancel?: () => void,
): AsyncGenerator<Message, boolean> {
  const deadline = performance.now() + 250
  while (true) {
    const next = iterator.next()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const cut = new Promise<null>(resolve => {
      onAbort = () => resolve(null)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now()))
    })
    let result: IteratorResult<Update> | null
    try { result = await Promise.race([next, cut]) }
    finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
    if (!result) { owner.retain(iterator, next, cancel); return false }
    if (result.done) return true
    if (result.value.message) yield result.value.message
  }
}

/** Normal tool execution has no time limit; cancellation transfers its owner. */
export async function* toolUpdatesUntilAbort<T extends Update>(
  iterator: AsyncIterator<T>, owner: InterruptedToolRun, signal: AbortSignal,
  stopUnstarted: () => void,
): AsyncGenerator<T, boolean> {
  while (true) {
    const next = iterator.next()
    let onAbort: (() => void) | undefined
    const cancelled = new Promise<null>(resolve => {
      onAbort = () => { if (signal.reason !== 'terminal_handoff') resolve(null) }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    let result: IteratorResult<T> | null
    try { result = await Promise.race([next, cancelled]) }
    finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
    if (!result) {
      stopUnstarted()
      owner.retain(iterator, next)
      return false
    }
    if (result.done) return true
    yield result.value
  }
}
