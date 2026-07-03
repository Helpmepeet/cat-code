/**
 * JSON-safety guard for the raw-forwarding serializer (TRANSPORT-DECISION.md §2
 * note, §4.1 — "Landmine 1").
 *
 * The controller seam types event payloads as `unknown` (sessionEvents.ts), so
 * the schema would ACCEPT a value that `JSON.stringify → JSON.parse` silently
 * corrupts (Buffer → object, Date/Map → lossy, sparse array) or throws on
 * (bigint, cycle). No current engine producer emits such a value — every real
 * SDKMessage is a POJO, and image blocks arrive as base64 *strings*. But the
 * raw-forwarding sidecar must not trust that: it asserts each outbound payload
 * is JSON-safe at the boundary and rejects/logs a violator rather than let it
 * corrupt the wire.
 *
 * This is a structural walk, not `JSON.stringify` in a try/catch: stringify
 * would *silently* coerce a Date to an ISO string and a Buffer to a `{data:[]}`
 * object without throwing, so a catch-only check would pass a corrupted frame.
 */

export type JsonSafeResult =
  | { ok: true }
  | { ok: false; reason: string; path: string }

const MAX_DEPTH = 64

/**
 * Returns whether `value` round-trips through JSON losslessly. On failure,
 * reports the offending path and reason so the sidecar can log a debuggable
 * rejection (params + reason, per the debugging rule).
 */
export function checkJsonSafe(value: unknown): JsonSafeResult {
  const seen = new Set<object>()
  return walk(value, '$', seen, 0)
}

/**
 * Canonicalize optional object properties for the JSON wire. Runtime SDK
 * objects commonly materialize optional fields as `key: undefined`; JSON
 * represents those exactly like an absent property. Arrays are intentionally
 * untouched so present `undefined` entries still fail `checkJsonSafe`.
 *
 * Mutates only the caller-owned serialization clone, never the engine event.
 */
export function omitUndefinedObjectProperties<T>(value: T): T {
  const seen = new Set<object>()

  const visit = (current: unknown): void => {
    if (current === null || typeof current !== 'object') return
    if (seen.has(current)) return
    seen.add(current)

    if (Array.isArray(current)) {
      for (const item of current) visit(item)
      return
    }

    const object = current as Record<string, unknown>
    for (const key of Object.keys(object)) {
      if (object[key] === undefined) {
        delete object[key]
      } else {
        visit(object[key])
      }
    }
  }

  visit(value)
  return value
}

function walk(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): JsonSafeResult {
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: `exceeds max depth ${MAX_DEPTH}`, path }
  }

  const t = typeof value

  if (value === null || t === 'string' || t === 'boolean') {
    return { ok: true }
  }

  if (t === 'number') {
    // NaN / ±Infinity serialize to `null`, silently corrupting the value.
    if (!Number.isFinite(value as number)) {
      return { ok: false, reason: `non-finite number (${String(value)})`, path }
    }
    // F15 — negative zero round-trips through JSON to positive zero.
    if (Object.is(value, -0)) {
      return { ok: false, reason: 'negative zero (round-trips to +0)', path }
    }
    return { ok: true }
  }

  if (t === 'bigint') {
    return { ok: false, reason: 'bigint cannot be JSON-serialized', path }
  }

  if (t === 'undefined') {
    // `undefined` is dropped by JSON.stringify inside objects and becomes
    // `null` inside arrays — either way it is not preserved. It is allowed only
    // as an absent optional property, which never reaches this walk (missing
    // keys are simply not visited). A *present* undefined is a corruption risk.
    return { ok: false, reason: 'undefined is not JSON-safe', path }
  }

  if (t === 'function' || t === 'symbol') {
    return { ok: false, reason: `${t} cannot be JSON-serialized`, path }
  }

  // Objects and arrays.
  const obj = value as object

  if (seen.has(obj)) {
    return { ok: false, reason: 'cyclic reference', path }
  }

  // Reject exotic object types that JSON.stringify mangles instead of rejecting.
  if (Array.isArray(obj)) {
    if (hasHoles(obj)) {
      return { ok: false, reason: 'sparse array (holes become null)', path }
    }
    seen.add(obj)
    for (let i = 0; i < obj.length; i++) {
      const result = walk((obj as unknown[])[i], `${path}[${i}]`, seen, depth + 1)
      if (!result.ok) return result
    }
    seen.delete(obj)
    return { ok: true }
  }

  const tag = Object.prototype.toString.call(obj)
  if (tag !== '[object Object]') {
    // Buffer, Uint8Array, Date, Map, Set, RegExp, Error, etc. — all lossy or
    // wrong under JSON. Named explicitly so the log is debuggable.
    return { ok: false, reason: `non-plain object ${tag}`, path }
  }

  // F15 — symbol-keyed properties are silently dropped by JSON.stringify.
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    return { ok: false, reason: 'symbol-keyed property (dropped by JSON)', path }
  }

  seen.add(obj)
  for (const key of Object.keys(obj)) {
    const result = walk(
      (obj as Record<string, unknown>)[key],
      `${path}.${key}`,
      seen,
      depth + 1,
    )
    if (!result.ok) return result
  }
  seen.delete(obj)
  return { ok: true }
}

function hasHoles(arr: unknown[]): boolean {
  for (let i = 0; i < arr.length; i++) {
    if (!(i in arr)) return true
  }
  return false
}
