import { randomUUID } from 'crypto'

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

export type AutoModeRawPermissionResult = 'allow' | 'deny' | 'ask' | 'throw'

export type AutoModePolicyEvidence =
  | 'base_rule'
  | 'safety_policy'
  | 'classifier_policy'

export type AutoModeDispositionEvidence = {
  /**
   * A typed observed failure wins over a classifier's fail-closed verdict.
   * This avoids interpreting unavailable/invalid responses as policy blocks.
   */
  failure?: AutoModeFailure
  policy?: AutoModePolicyEvidence
}

export type AutoModeDispositionMetadata = {
  disposition: AutoModeDisposition
  cause?: AutoModeFailure
}

export function isAutoModeRawDispositionValid(
  rawResult: AutoModeRawPermissionResult,
  disposition: AutoModeDisposition,
): boolean {
  switch (rawResult) {
    case 'allow':
      return disposition === 'allowed'
    case 'ask':
      return disposition === 'review_required'
    case 'deny':
      return disposition === 'policy_blocked' ||
        disposition === 'operational_error' ||
        disposition === 'cancelled' ||
        disposition === 'unknown_outcome'
    case 'throw':
      return disposition === 'operational_error' ||
        disposition === 'cancelled' ||
        disposition === 'unknown_outcome'
  }
}

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

const OPERATIONAL_FAILURES = new Set<AutoModeFailure>([
  'unavailable',
  'invalid_response',
  'context_limit',
  'internal_error',
])

/**
 * Maps the initial permission pipeline result using only structured evidence.
 * It observes a decision without changing its behavior or inspecting messages.
 */
export function mapAutoModeDisposition(
  result: AutoModeRawPermissionResult,
  evidence: Readonly<AutoModeDispositionEvidence> = {},
): AutoModeDispositionMetadata {
  if (result === 'allow') return { disposition: 'allowed' }
  if (result === 'ask') {
    return {
      disposition: 'review_required',
      ...(evidence.failure ? { cause: evidence.failure } : {}),
    }
  }
  if (result === 'deny') {
    if (evidence.failure && OPERATIONAL_FAILURES.has(evidence.failure)) {
      return { disposition: 'operational_error', cause: evidence.failure }
    }
    if (evidence.failure === 'interrupted') {
      return { disposition: 'cancelled', cause: evidence.failure }
    }
    if (evidence.policy) return { disposition: 'policy_blocked' }
    return {
      disposition: 'unknown_outcome',
      ...(evidence.failure ? { cause: evidence.failure } : {}),
    }
  }
  if (evidence.failure && OPERATIONAL_FAILURES.has(evidence.failure)) {
    return { disposition: 'operational_error', cause: evidence.failure }
  }
  if (evidence.failure === 'interrupted') {
    return { disposition: 'cancelled', cause: evidence.failure }
  }
  return {
    disposition: 'unknown_outcome',
    ...(evidence.failure ? { cause: evidence.failure } : {}),
  }
}

export type AutoModeObservationWriter = (
  event: AutoModeObservationEvent,
) => void

export type AutoModePermissionObserver = {
  enterStage(stage: AutoModeStage): void
  resolveStage(
    stage: AutoModeStage,
    resolution:
      | { should_block: boolean }
      | { failure: AutoModeFailure },
  ): void
  finish(input: {
    raw_result: AutoModeRawPermissionResult
    route: AutoModeRoute
    evidence?: Readonly<AutoModeDispositionEvidence>
    primary_category?: AutoModePrimaryCategory
  }): void
}

export type CreateAutoModePermissionObserverOptions = {
  writer: AutoModeObservationWriter
  toolUseId: string
  toolKind: AutoModeToolKind
  effectiveAutoMode: 'auto' | 'plan_auto' | null
  createAttemptId?: () => string
}

export type AutoModePermissionObservationContext = {
  readonly observer: AutoModePermissionObserver
  markRoute(route: AutoModeRoute): void
  markFailure(failure: AutoModeFailure): void
  markPolicy(policy: AutoModePolicyEvidence): void
  markCategory(category: AutoModePrimaryCategory | undefined): void
  enterStage(stage: AutoModeStage): void
  resolveStage(
    stage: AutoModeStage,
    resolution: Parameters<AutoModePermissionObserver['resolveStage']>[1],
  ): void
  finishResult(result: AutoModeRawPermissionResult): Parameters<AutoModePermissionObserver['finish']>[0]
  finishError(): Parameters<AutoModePermissionObserver['finish']>[0]
}

/**
 * Creates the observer for one initial logical permission occurrence.
 *
 * A recheck deliberately supplies no observer. The occurrence owner keeps this
 * short-lived object rather than using process-global tool-use ID state.
 */
export function createAutoModePermissionObserver(
  options: CreateAutoModePermissionObserverOptions,
): AutoModePermissionObserver | null {
  if (options.effectiveAutoMode === null) return null

  const attemptId = (options.createAttemptId ?? randomUUID)()
  const start = parseAutoModeObservationEvent({
    subtype: 'auto_permission_start',
    schema_version: AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
    attempt_id: attemptId,
    tool_use_id: options.toolUseId,
    tool_kind: options.toolKind,
    auto_mode: options.effectiveAutoMode,
    initial: true,
  })
  if (start === null) return null

  options.writer(start)
  let finished = false

  function emit(event: unknown): void {
    const parsed = parseAutoModeObservationEvent(event)
    if (parsed !== null) options.writer(parsed)
  }

  return {
    enterStage(stage) {
      if (finished) return
      emit({
        subtype: 'auto_permission_stage',
        schema_version: AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
        attempt_id: attemptId,
        stage,
        phase: 'entered',
      })
    },
    resolveStage(stage, resolution) {
      if (finished) return
      emit({
        subtype: 'auto_permission_stage',
        schema_version: AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
        attempt_id: attemptId,
        stage,
        phase: 'resolved',
        ...resolution,
      })
    },
    finish({ raw_result, route, evidence, primary_category }) {
      if (finished) return
      finished = true
      const disposition = mapAutoModeDisposition(raw_result, evidence)
      emit({
        subtype: 'auto_permission_end',
        schema_version: AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
        attempt_id: attemptId,
        raw_result,
        route,
        ...disposition,
        ...(primary_category ? { primary_category } : {}),
      })
    },
  }
}

export function createAutoModePermissionObservationContext(
  options: CreateAutoModePermissionObserverOptions,
): AutoModePermissionObservationContext | null {
  const observer = createAutoModePermissionObserver(options)
  if (observer === null) return null
  let route: AutoModeRoute = 'unknown'
  let evidence: AutoModeDispositionEvidence = {}
  let category: AutoModePrimaryCategory | undefined
  return {
    observer,
    markRoute(next) {
      route = next
    },
    markFailure(failure) {
      if (
        evidence.failure === 'context_limit' ||
        evidence.failure === 'internal_error'
      ) {
        return
      }
      evidence = { ...evidence, failure }
    },
    markPolicy(policy) {
      evidence = { ...evidence, policy }
    },
    markCategory(next) {
      category = next
    },
    enterStage(stage) {
      observer.enterStage(stage)
    },
    resolveStage(stage, resolution) {
      observer.resolveStage(stage, resolution)
    },
    finishResult(result) {
      return {
        raw_result: result,
        route,
        evidence,
        ...(category ? { primary_category: category } : {}),
      }
    },
    finishError() {
      return { raw_result: 'throw', route, evidence }
    },
  }
}

/**
 * The outer logical-occurrence seam. It selects an initial forced decision
 * before the ordinary checker, records only through the supplied observer, and
 * preserves the exact result or thrown error from the existing permission path.
 */
export async function resolveInitialPermissionOccurrence<T>(options: {
  observer: AutoModePermissionObserver | null
  forceDecision?: T
  getPermissionResult: () => Promise<T>
  finishResult: (result: T) => Parameters<AutoModePermissionObserver['finish']>[0]
  finishError: (error: unknown) => Parameters<AutoModePermissionObserver['finish']>[0]
}): Promise<T> {
  try {
    const result =
      options.forceDecision === undefined
        ? await options.getPermissionResult()
        : options.forceDecision
    if (options.observer) {
      options.observer.finish(options.finishResult(result))
    }
    return result
  } catch (error) {
    if (options.observer) {
      options.observer.finish(options.finishError(error))
    }
    throw error
  }
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
      !isAutoModeRawDispositionValid(value.raw_result, value.disposition) ||
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
