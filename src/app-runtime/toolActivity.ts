import { AsyncLocalStorage } from 'node:async_hooks'
import { isToolActivity, MAX_TOOL_ACTIVITY_OUTPUT_BYTES, type ToolActivity } from './toolActivityContract.js'

type Scope = { emit: (activity: ToolActivity) => void; calls: Map<string, { phase: ToolActivity['phase']; startedAt: number; lastOutput: number; timeoutMs?: number }> }
const scope = new AsyncLocalStorage<Scope>()

export function withToolActivity<T>(emit: Scope['emit'], run: () => T): T {
  return scope.run({ emit, calls: new Map() }, run)
}

export function recordToolActivity(toolUseId: string, phase: ToolActivity['phase']): void {
  const state = scope.getStore()
  if (!state || state.calls.get(toolUseId)?.phase === phase) return
  if (state.calls.size >= 1000) state.calls.delete(state.calls.keys().next().value!)
  const startedAt = Date.now()
  state.calls.set(toolUseId, { phase, startedAt, lastOutput: 0 })
  publish(state, { type: 'tool.activity', toolUseId, phase, startedAt })
}

/** The shell resolves its configured default once, before it starts executing. */
export function recordToolTimeout(toolUseId: string | undefined, timeoutMs: number): void {
  const call = toolUseId ? scope.getStore()?.calls.get(toolUseId) : undefined
  if (call?.phase === 'executing') call.timeoutMs = timeoutMs
}

export function recordToolOutput(toolUseId: string, output: string, totalLines: number, timeoutMs?: number): void {
  const state = scope.getStore()
  const call = state?.calls.get(toolUseId)
  if (!state || !call || call.phase !== 'executing' || Date.now() - call.lastOutput < 1000) return
  call.lastOutput = Date.now()
  // Bound before encoding, then keep a UTF-8 tail without replacement characters.
  const bytes = Buffer.from(output.slice(-MAX_TOOL_ACTIVITY_OUTPUT_BYTES), 'utf8')
  let offset = Math.max(0, bytes.length - MAX_TOOL_ACTIVITY_OUTPUT_BYTES)
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++
  publish(state, { type: 'tool.activity', toolUseId, phase: 'executing', startedAt: call.startedAt,
    output: bytes.subarray(offset).toString('utf8'), totalLines, timeoutMs: timeoutMs ?? call.timeoutMs })
}

function publish(state: Scope, activity: ToolActivity): void {
  if (!isToolActivity(activity)) return
  try { state.emit(activity) } catch { /* Display telemetry cannot affect a tool. */ }
}
