import { activeDeadline } from './activeDeadline'
import { DEFAULT_LIMITS, RuntimeRequestError, boundRuntimeError, encode, type PersistentRuntime, type RuntimeCell, type RuntimeLimits, type RuntimeOptions, type RuntimeOutcome } from './protocol'
export type * from './protocol'

/** One instance per session/worker. Runs serialize; independent instances may run concurrently.
 * Cancellation destroys the context, including retained values. Create a new instance to reset.
 */
export function createRuntime(options: RuntimeOptions = {}): PersistentRuntime {
  const limits: RuntimeLimits = { ...DEFAULT_LIMITS, ...options.limits }
  for (const [key, value] of Object.entries(limits)) {
    const ceiling = key === 'wallTimeMs' ? 2 * 60 * 60_000 : DEFAULT_LIMITS[key as keyof RuntimeLimits] * 8
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`Invalid runtime limit: ${key}`)
  }
  // The CLI and sidecar compile the Worker entry as worker.js beside the host
  // at the root of Bun's embedded filesystem.
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url).href)
  let dead = false
  const usedCells = new Set<string>()
  let active: {
    cell: RuntimeCell
    finish: (outcome: RuntimeOutcome) => void
    controller: AbortController
    calls: number
    pending: number
    output: number
    waitRevision: number
    waiting: boolean
    requestedWait: boolean
    deadline: ReturnType<typeof activeDeadline>
  } | undefined
  let readyResolve: () => void
  let readyReject: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  void ready.catch(() => {})
  const startup = setTimeout(() => stop('limit', 'Runtime startup timed out'), Math.min(10_000, limits.wallTimeMs))
  function stop(status: RuntimeOutcome['status'], error?: string) {
    if (dead) return
    dead = true
    clearTimeout(startup)
    worker.terminate()
    readyReject(new Error(error ?? 'Runtime disposed'))
    active?.controller.abort()
    active?.finish({ cellId: active.cell.cellId, status, error })
    active = undefined
  }
  worker.onerror = event => { event.preventDefault(); stop('error', 'Isolated runtime failed to load or execute') }
  worker.onmessage = async ({ data }) => {
    if (dead) return
    if (data.type === 'ready') { clearTimeout(startup); readyResolve(); return }
    if (data.type === 'fatal') { stop('limit', String(data.error).slice(0, 2048)); return }
    const owner = active
    if (!owner || data.cellId !== owner.cell.cellId) { stop('error', 'Stale runtime message'); return }
    try {
      if (data.type === 'human-wait') {
        if (owner.requestedWait && data.revision === owner.waitRevision && !owner.waiting) {
          if (!owner.deadline.pause()) return
          owner.waiting = true
          owner.cell.onHumanWaitChange?.(true)
        }
      } else if (data.type === 'done') {
        if (owner.pending) throw new Error('Runtime completed with pending requests')
        owner.controller.abort()
        owner.finish({ cellId: owner.cell.cellId, status: data.error ? 'error' : 'ok', ...(data.error ? { error: boundRuntimeError(String(data.error)) } : {}) })
        active = undefined
      } else if (data.type === 'output' || data.type === 'request') {
        if (typeof data.text !== 'string' || new TextEncoder().encode(data.text).length > limits.messageBytes) throw new Error('Message byte limit')
        const payload = JSON.parse(data.text)
        encode(payload, limits.messageBytes)
        const line = Number.isSafeInteger(data.line) && data.line > 0 ? data.line : undefined
        const sourceCellId = typeof data.sourceCellId === 'string' && usedCells.has(data.sourceCellId) ? data.sourceCellId : undefined
        if (data.type === 'output') {
          owner.output += Math.max(64, new TextEncoder().encode(data.text).length)
          if (owner.output > limits.outputBytes) throw new Error('Output byte limit')
          owner.cell.onOutput?.({ cellId: owner.cell.cellId, kind: data.kind, value: payload, line, sourceCellId })
        } else {
          if (++owner.calls > limits.totalRequests || ++owner.pending > limits.pendingRequests) throw new Error('Request limit')
          let response: { text?: string; error?: string }
          try {
            const value = await owner.cell.dispatch({ cellId: owner.cell.cellId, kind: data.kind, payload, line, sourceCellId }, owner.controller.signal)
            response = { text: encode(value, limits.messageBytes) }
          } catch (error) {
            response = { error: error instanceof RuntimeRequestError ? boundRuntimeError(error.message) : 'Host request failed' }
          }
          owner.pending--
          if (!dead && active === owner && !owner.controller.signal.aborted) worker.postMessage({ type: 'response', id: data.id, ...response })
        }
      } else throw new Error('Unknown runtime message')
    } catch (e) { stop('limit', String(e).slice(0, 2048)) }
  }
  worker.postMessage({ type: 'init', limits })
  return {
    async run(cell) {
      if (dead) return { cellId: cell.cellId, status: 'disposed' }
      if (active) return { cellId: cell.cellId, status: 'error', error: 'Runtime is busy' }
      if (usedCells.has(cell.cellId)) return { cellId: cell.cellId, status: 'error', error: 'Cell ID already used' }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(cell.cellId) || new TextEncoder().encode(cell.source).length > limits.sourceBytes) return { cellId: cell.cellId, status: 'limit', error: 'Invalid cell ID or source byte limit' }
      if (cell.signal.aborted) return { cellId: cell.cellId, status: 'cancelled' }
      if (usedCells.size >= 10_000) { stop('limit', 'Runtime cell count limit'); return { cellId: cell.cellId, status: 'limit', error: 'Runtime cell count limit' } }
      usedCells.add(cell.cellId)
      return new Promise<RuntimeOutcome>(resolve => {
        const deadline = activeDeadline(limits.wallTimeMs, () => stop('limit', 'Cell wall time limit'))
        const abort = () => stop('cancelled', 'Cell cancelled')
        const owner = {
          cell, controller: new AbortController(), calls: 0, pending: 0, output: 0,
          waitRevision: 0, waiting: false, requestedWait: false, deadline,
          finish(outcome: RuntimeOutcome) { deadline.dispose(); cell.signal.removeEventListener('abort', abort); resolve(outcome) },
        }
        active = owner
        deadline.resume()
        cell.signal.addEventListener('abort', abort, { once: true })
        void ready.then(() => {
          if (!dead && active === owner) worker.postMessage({ type: 'run', cellId: cell.cellId, source: cell.source, hasBash: cell.hasBash === true })
        }).catch(() => stop('error', 'Runtime unavailable'))
      })
    },
    setHumanWait(cellId, waiting) {
      const owner = active
      if (dead || !owner || owner.cell.cellId !== cellId || owner.requestedWait === waiting) return
      owner.requestedWait = waiting
      worker.postMessage({ type: 'set-human-wait', cellId, waiting, revision: ++owner.waitRevision })
      if (!waiting && owner.waiting) {
        owner.waiting = false
        owner.deadline.resume()
        owner.cell.onHumanWaitChange?.(false)
      }
    },
    dispose() { stop('disposed') },
  }
}
