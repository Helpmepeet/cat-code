export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface RuntimeLimits {
  memoryBytes: number
  stackBytes: number
  wallTimeMs: number
  sourceBytes: number
  messageBytes: number
  outputBytes: number
  pendingRequests: number
  totalRequests: number
}
export const DEFAULT_LIMITS: RuntimeLimits = {
  memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024,
  wallTimeMs: 10 * 60_000, sourceBytes: 128 * 1024, messageBytes: 256 * 1024,
  outputBytes: 256 * 1024, pendingRequests: 16, totalRequests: 256,
}
export interface RuntimeRequest { cellId: string; kind: 'tool' | 'discover'; payload: JsonValue; line?: number; sourceCellId?: string }
export interface RuntimeOutput { cellId: string; kind: 'console' | 'selected'; value: JsonValue; line?: number; sourceCellId?: string }
export interface RuntimeOutcome { cellId: string; status: 'ok' | 'error' | 'cancelled' | 'limit' | 'disposed'; error?: string }
export interface RuntimeCell {
  cellId: string
  source: string
  signal: AbortSignal
  dispatch: (request: RuntimeRequest, signal: AbortSignal) => Promise<JsonValue>
  onOutput?: (output: RuntimeOutput) => void
}
// Host scheduling owns background receipts and worker/session identity. A runtime
// admits only one active cell, requires unique IDs, and drains unawaited host calls.
// Callers must honor dispatch AbortSignal; termination cannot undo host effects.
// Unresolved guest continuations fence/dispose the runtime, discarding all retained
// state. Drained cells preserve state. Dynamic compilation and async iteration
// are unsupported so every async assimilation point can be tracked.
// wallTimeMs defaults to 10 minutes; background owners may select up to 2 hours.
export interface RuntimeOptions { limits?: Partial<RuntimeLimits> }
export interface PersistentRuntime { run(cell: RuntimeCell): Promise<RuntimeOutcome>; dispose(): void }

// Validate descriptors before serialization: do not invoke getters or toJSON in host data.
export function encode(value: unknown, cap: number): string {
  const seen = new Set<object>()
  let budget = cap
  function visit(v: unknown, depth: number): void {
    if (--budget < 0 || depth > 64) throw new Error('JSON data limit')
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v === 'string') { budget -= v.length; return }
    if (typeof v !== 'object' || !v) throw new Error('Non-JSON data')
    if (seen.has(v)) throw new Error('Cyclic data')
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null && !Array.isArray(v)) throw new Error('Non-plain data')
    seen.add(v)
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe JSON key')
      const d = Object.getOwnPropertyDescriptor(v, key)!
      if (!('value' in d) || !d.enumerable) throw new Error('Non-data property')
      budget -= key.length
      visit(d.value, depth + 1)
    }
    seen.delete(v)
  }
  visit(value, 0)
  const text = JSON.stringify(value)
  if (new TextEncoder().encode(text).length > cap) throw new Error('JSON byte limit')
  return text
}
