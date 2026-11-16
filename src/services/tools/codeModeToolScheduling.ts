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

export async function acquireCodeModeToolLane(context: ToolUseContext): Promise<() => void> {
  const key = owner(context)
  const lane = lanes.get(key)
  if (!lane) return () => {}
  const previous = lane.tail
  let finish!: () => void
  lane.tail = new Promise<void>(resolve => { finish = resolve })
  lane.pending++
  await previous
  let released = false
  return () => {
    if (released) return
    released = true
    lane.pending--
    finish()
    if (!lane.backgrounds && !lane.pending) lanes.delete(key)
  }
}
