/**
 * Field checks for the private main↔worker parse boundaries
 * (`accountsPoolWorker.ts`, `sessionsCatalogWorker.ts`). NOT a wire protocol and
 * not a general validation framework: just enough to state one untrusted record
 * shape as a table of per-field checks, so a field stops being spelled three
 * times (once in the key list, once in its `typeof` check, once in the
 * reconstructed return literal).
 *
 * The load-bearing property carried over from the hand-written parsers: the
 * value handed back is checked against the DECLARED type, with no `as` cast on
 * the untrusted child output at the call site. `narrowExact`/`narrowOpen` build a
 * fresh object typed from the spec, so a parser declared `): AccountStatus | null`
 * gets a tsc error when a field is missing from its spec or its check narrows to
 * the wrong type. One gap versus a hand-written return literal: a spec key the
 * target type does NOT have is not a tsc error. It cannot pass unnoticed either,
 * because `narrowExact` would then demand that key on the wire and reject every
 * real record.
 *
 * Accumulator note: both functions assign into a `{}` literal, which is safe
 * ONLY because the keys come from the spec, i.e. from source literals. A map
 * whose KEYS come from the untrusted record (`modelUsage`, `tokensByModel` in
 * `accountsPoolWorker.ts`) must still accumulate into `Object.create(null)` —
 * see the ruling recorded at that call site.
 */

/** One field's check. It narrows, so the spec also states the field's type. */
export type Check<T> = (value: unknown) => value is T

/**
 * A field the record may omit. An absent key passes and is omitted from the
 * result. So does a key PRESENT with the value `undefined`: that is exactly what
 * the hand-written `x !== undefined && !check(x)` idiom these replace did, and
 * an IPC structured clone (unlike JSON) can deliver such a key.
 */
export type OptionalCheck<T> = { readonly optional: Check<T> }

export function optional<T>(check: Check<T>): OptionalCheck<T> {
  return { optional: check }
}

function isOptional(
  field: Check<any> | OptionalCheck<any>,
): field is OptionalCheck<any> {
  return typeof field !== 'function'
}

type FieldSpec = Record<string, Check<any> | OptionalCheck<any>>

type FieldType<C> = C extends OptionalCheck<infer T>
  ? T
  : C extends Check<infer T>
    ? T
    : never

type RequiredKey<S> = {
  [K in keyof S]: S[K] extends OptionalCheck<any> ? never : K
}[keyof S]

type OptionalKey<S> = {
  [K in keyof S]: S[K] extends OptionalCheck<any> ? K : never
}[keyof S]

export type Narrowed<S extends FieldSpec> = {
  [K in RequiredKey<S>]: FieldType<S[K]>
} & {
  [K in OptionalKey<S>]?: FieldType<S[K]>
}

/**
 * Narrow a record against a spec, TOLERATING keys the spec does not name. Use
 * only where the shape's contract already tolerated them — an entry row written
 * by a worker build that has since gained a field must still read. Everything
 * with a closed vocabulary wants `narrowExact`.
 */
export function narrowOpen<S extends FieldSpec>(
  value: unknown,
  spec: S,
): Narrowed<S> | null {
  if (!isRecord(value)) return null
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) {
    const field = spec[key]!
    const raw = value[key]
    if (isOptional(field)) {
      if (raw === undefined) continue
      if (!field.optional(raw)) return null
    } else if (!field(raw)) {
      return null
    }
    out[key] = raw
  }
  return out as Narrowed<S>
}

/**
 * `narrowOpen` plus the closed-vocabulary gate: every key on the record must be
 * one the spec names, and every non-`optional` spec key must be present. An
 * extra key fails the WHOLE record — that gate is what makes a credential
 * structurally unrepresentable on these boundaries, before `secretGuard` runs.
 */
export function narrowExact<S extends FieldSpec>(
  value: unknown,
  spec: S,
): Narrowed<S> | null {
  if (!isRecord(value)) return null
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) return null
  }
  for (const [key, field] of Object.entries(spec)) {
    if (isOptional(field)) continue
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null
  }
  return narrowOpen(value, spec)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Element narrowing is the caller's job (it usually rebuilds each row). */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

export function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null
}

export function isNumberOrNull(value: unknown): value is number | null {
  return typeof value === 'number' || value === null
}

/**
 * Stricter than `isNumber` for fields a chart divides by: the record arrives as
 * JSON, where `NaN`/`Infinity` cannot survive `JSON.stringify` (they serialize to
 * `null`), so a non-finite number here is malformed output.
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Closed vocabulary. Pass the list `as const` so the spec states the exact type. */
export function oneOf<T extends readonly unknown[]>(allowed: T): Check<T[number]> {
  return (value): value is T[number] => allowed.includes(value)
}
