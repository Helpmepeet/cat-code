/**
 * Metadata-only records for prospective auto-mode Usage accounting.
 *
 * The writer supplies the trusted system-record envelope. These payloads must
 * not carry timestamps, session identity, build provenance, paths, or content.
 */
export const AUTO_MODE_OBSERVATION_SCHEMA_VERSION = 1 as const
export const MAX_AUTO_MODE_OBSERVATION_ID_BYTES = 160

export const AUTO_MODE_DISPOSITIONS = [
  'allowed',
  'policy_blocked',
  'review_required',
  'operational_error',
  'cancelled',
  'unknown_outcome',
] as const
export type AutoModeDisposition = (typeof AUTO_MODE_DISPOSITIONS)[number]

export const AUTO_MODE_ROUTES = [
  'base',
  'forced',
  'guard',
  'accept_edits',
  'allowlist',
  'stage1',
  'stage2',
  'unknown',
] as const
export type AutoModeRoute = (typeof AUTO_MODE_ROUTES)[number]

export const AUTO_MODE_TOOL_KINDS = ['bash', 'powershell', 'other'] as const
export type AutoModeToolKind = (typeof AUTO_MODE_TOOL_KINDS)[number]

export const AUTO_MODE_STAGES = ['fast', 'thinking'] as const
export type AutoModeStage = (typeof AUTO_MODE_STAGES)[number]

export const AUTO_MODE_FAILURES = [
  'unavailable',
  'invalid_response',
  'context_limit',
  'interrupted',
  'internal_error',
  'unknown',
] as const
export type AutoModeFailure = (typeof AUTO_MODE_FAILURES)[number]

export type AutoModePrimaryCategory = {
  kind: 'built_in' | 'custom' | 'permission_rule'
  id: string
}

type AutoModeObservationBase = {
  schema_version: typeof AUTO_MODE_OBSERVATION_SCHEMA_VERSION
  attempt_id: string
}

export type AutoModeObservationEvent =
  | (AutoModeObservationBase & {
      subtype: 'auto_permission_start'
      tool_use_id: string
      tool_kind: AutoModeToolKind
      auto_mode: 'auto' | 'plan_auto'
      initial: true
    })
  | (AutoModeObservationBase & {
      subtype: 'auto_permission_stage'
      stage: AutoModeStage
      phase: 'entered'
    })
  | (AutoModeObservationBase & {
      subtype: 'auto_permission_stage'
      stage: AutoModeStage
      phase: 'resolved'
      should_block: boolean
    })
  | (AutoModeObservationBase & {
      subtype: 'auto_permission_stage'
      stage: AutoModeStage
      phase: 'resolved'
      failure: AutoModeFailure
    })
  | (AutoModeObservationBase & {
      subtype: 'auto_permission_end'
      raw_result: 'allow' | 'deny' | 'ask' | 'throw'
      disposition: AutoModeDisposition
      route: AutoModeRoute
      cause?: AutoModeFailure
      primary_category?: AutoModePrimaryCategory
    })

const RESERVED_ENVELOPE_KEYS = new Set([
  'type',
  'sessionId',
  'uuid',
  'timestamp',
  'cwd',
  'version',
])
const CATEGORY_KINDS = new Set<AutoModePrimaryCategory['kind']>([
  'built_in',
  'custom',
  'permission_rule',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function enumValue<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === 'string' && values.includes(value)
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_AUTO_MODE_OBSERVATION_ID_BYTES
  )
}

function category(value: unknown): value is AutoModePrimaryCategory {
  return (
    record(value) &&
    hasOnlyKeys(value, ['kind', 'id']) &&
    CATEGORY_KINDS.has(value.kind as AutoModePrimaryCategory['kind']) &&
    boundedId(value.id) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id)
  )
}

function hasReservedEnvelopeKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(key => RESERVED_ENVELOPE_KEYS.has(key))
}

/**
 * Parses one payload before it reaches the transcript diagnostic writer.
 * The trusted writer owns the system envelope, so envelope-shaped input fails
 * rather than allowing a caller to overwrite its session or timestamp.
 */
export function parseAutoModeObservationEvent(
  value: unknown,
): AutoModeObservationEvent | null {
  if (
    !record(value) ||
    hasReservedEnvelopeKey(value) ||
    value.schema_version !== AUTO_MODE_OBSERVATION_SCHEMA_VERSION ||
    !boundedId(value.attempt_id)
  ) {
    return null
  }

  if (value.subtype === 'auto_permission_start') {
    return hasOnlyKeys(value, [
      'subtype',
      'schema_version',
      'attempt_id',
      'tool_use_id',
      'tool_kind',
      'auto_mode',
      'initial',
    ]) &&
      boundedId(value.tool_use_id) &&
      enumValue(AUTO_MODE_TOOL_KINDS, value.tool_kind) &&
      (value.auto_mode === 'auto' || value.auto_mode === 'plan_auto') &&
      value.initial === true
      ? value as AutoModeObservationEvent
      : null
  }

  if (value.subtype === 'auto_permission_stage') {
    if (!enumValue(AUTO_MODE_STAGES, value.stage) || value.phase !== 'entered' && value.phase !== 'resolved') {
      return null
    }
    if (value.phase === 'entered') {
      return hasOnlyKeys(value, [
        'subtype',
        'schema_version',
        'attempt_id',
        'stage',
        'phase',
      ])
        ? value as AutoModeObservationEvent
        : null
    }
    const hasVerdict = typeof value.should_block === 'boolean'
    const hasFailure = enumValue(AUTO_MODE_FAILURES, value.failure)
    if (hasVerdict === hasFailure) return null
    return hasOnlyKeys(
      value,
      hasVerdict
        ? ['subtype', 'schema_version', 'attempt_id', 'stage', 'phase', 'should_block']
        : ['subtype', 'schema_version', 'attempt_id', 'stage', 'phase', 'failure'],
    )
      ? value as AutoModeObservationEvent
      : null
  }

  if (value.subtype === 'auto_permission_end') {
    if (
      !enumValue(['allow', 'deny', 'ask', 'throw'] as const, value.raw_result) ||
      !enumValue(AUTO_MODE_DISPOSITIONS, value.disposition) ||
      !enumValue(AUTO_MODE_ROUTES, value.route) ||
      (value.cause !== undefined && !enumValue(AUTO_MODE_FAILURES, value.cause)) ||
      (value.primary_category !== undefined && !category(value.primary_category))
    ) {
      return null
    }
    const keys = [
      'subtype',
      'schema_version',
      'attempt_id',
      'raw_result',
      'disposition',
      'route',
    ]
    if (value.cause !== undefined) keys.push('cause')
    if (value.primary_category !== undefined) keys.push('primary_category')
    return hasOnlyKeys(value, keys)
      ? value as AutoModeObservationEvent
      : null
  }

  return null
}
