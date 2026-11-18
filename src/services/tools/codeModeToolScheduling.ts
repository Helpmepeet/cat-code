import type { ToolUseContext } from '../../Tool.js'

type Lane = { backgrounds: number; pending: number; tail: Promise<void> }
const lanes = new WeakMap<object, Lane>()
const owner = (context: ToolUseContext): object => context.interruptedToolRun ?? context.readFileState

/** Ordinary direct scheduling is unchanged unless detached code can overlap it.
 * During overlap, serialize full tool pipelines, including approvals and hooks.
 * The REPL wrapper must never acquire this lane: its children acquire it instead.
 */
export function ownBackgroundToolLane(context: ToolUseContext): () => void {
  const key = owner(context)
  const lane = lanes.get(key) ?? { backgrounds: 0, pending: 0, tail: Promise.resolve() }
  lanes.set(key, lane)
  lane.backgrounds++
  let released = false
  return () => {
    if (released) return
    released = true
    lane.backgrounds--
    if (!lane.backgrounds && !lane.pending) lanes.delete(key)
  }
}

export async function acquireCodeModeToolLane(context: ToolUseContext): Promise<(() => void) | undefined> {
  const signal = context.abortController.signal
  if (signal.aborted) return undefined
  const key = owner(context)
  const lane = lanes.get(key)
  if (!lane) return () => {}
  const previous = lane.tail
  let finish!: () => void
  const slot = new Promise<void>(resolve => { finish = resolve })
  // A cancelled waiter can leave immediately, but its successor still waits
  // for the owner ahead of it to finish.
  lane.tail = previous.then(() => slot)
  lane.pending++
  let released = false
  const release = () => {
    if (released) return
    released = true
    lane.pending--
    finish()
    if (!lane.backgrounds && !lane.pending) lanes.delete(key)
  }
  const cancelled = Promise.withResolvers<void>()
  const onAbort = () => cancelled.resolve()
  signal.addEventListener('abort', onAbort, { once: true })
  try { await Promise.race([previous, cancelled.promise]) }
  finally { signal.removeEventListener('abort', onAbort) }
  if (signal.aborted) { release(); return undefined }
  return release
}
