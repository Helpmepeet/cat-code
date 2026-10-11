import {
  AUTO_MODE_DISPOSITIONS,
  AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
  AUTO_MODE_ROUTES,
  MAX_AUTO_MODE_OBSERVATION_ID_BYTES,
  isAutoModeRawDispositionValid,
  parseAutoModeObservationEvent,
  type AutoModeDisposition,
  type AutoModeObservationEvent,
  type AutoModePrimaryCategory,
  type AutoModeRawPermissionResult,
  type AutoModeRoute,
  type AutoModeStage,
} from './permissions/autoModeObservation.js'
import { createHash } from 'node:crypto'
import { addCalendarDays, localDateKey, localMidnight } from './usageWindow.js'
import type {
  AutoModeUsageBucket,
  AutoModeUsageCoverage,
  AutoModeUsageOutcome,
  AutoModeUsageOutcomeCounts,
  AutoModeUsagePopulation,
  AutoModeUsageSummary,
} from '../../app/shared/usageAutoMode.js'

type CoverageState = AutoModeUsageCoverage['state']

export type RetainedAutoModeRecord = Readonly<{
  sourceScope: string
  recordId: string
  observedAt: string
  diagnosticKind: string
  payload: unknown
  historical?: true
}>

export type AutoModeUsageSource = Readonly<{
  sourceScope: string
  allTools: CoverageState
  commands: CoverageState
  /** First retained Start that proves this source can emit prospective records. */
  supportedFrom?: string
  /** Bounded retained interval used to ignore sources outside a queried range. */
  observedFrom?: string
  observedThrough?: string
}>

export type AutoModeUsageReductionInput = Readonly<{
  records: readonly RetainedAutoModeRecord[]
  sources: readonly AutoModeUsageSource[]
  rangeStart: string
  rangeEnd: string
  cutoff: string
  timezone?: string
}>

export type ProjectedAutoModeDiagnosticPayload =
  | AutoModeObservationEvent
  | Readonly<{
      subtype: 'auto_permission_end'
      attempt_id: string
    }>
  | Readonly<{
      subtype: 'auto_permission_invalid'
    }>

export type HistoricalAutoModeOutcome =
  | 'policy_blocked'
  | 'operational_error'

const AUTO_MODE_POLICY_DENIAL_PREFIX =
  'Permission for this action has been denied. Reason: '
const AUTO_MODE_UNAVAILABLE_PREFIX = 'The auto mode classifier request using '
const AUTO_MODE_UNAVAILABLE_MARKER =
  ' is temporarily unavailable, so auto mode cannot determine the safety of '

/**
 * Recognizes only code-owned Auto mode result text that predates structured
 * permission observations. The returned enum is safe to index; raw result text
 * is never retained.
 */
export function classifyHistoricalAutoModeToolResult(
  content: unknown,
): HistoricalAutoModeOutcome | null {
  if (typeof content !== 'string') return null
  if (content.startsWith(AUTO_MODE_POLICY_DENIAL_PREFIX)) {
    return 'policy_blocked'
  }
  if (
    content.startsWith(AUTO_MODE_UNAVAILABLE_PREFIX) &&
    content.includes(AUTO_MODE_UNAVAILABLE_MARKER)
  ) {
    return 'operational_error'
  }
  return null
}

type Marker = {
  timestamp: number
  recordId: string
  kind: 'stage' | 'terminal' | 'invalid_terminal'
  stage?: Extract<AutoModeObservationEvent, { subtype: 'auto_permission_stage' }>
  terminal?: Terminal
}

type Terminal = {
  disposition: AutoModeDisposition
  route: AutoModeRoute
  category: AutoModePrimaryCategory | null
}

type Attempt = {
  timestamp: number
  date: string
  toolKind: 'bash' | 'powershell' | 'other'
  start: Extract<AutoModeObservationEvent, { subtype: 'auto_permission_start' }>
  invalidTerminal: boolean
  terminal: Terminal | null
  terminalConflict: boolean
  routeConflict: boolean
  categoryConflict: boolean
  stageConflict: boolean
  startConflict: boolean
  stages: AutoModeObservationEvent[]
  invalidRecords: number
  historical: boolean
}

const AUTO_MODE_DIAGNOSTIC_KIND = 'auto_mode_observation'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const AUTO_MODE_EVENT_FIELDS = [
  'schema_version',
  'subtype',
  'attempt_id',
  'tool_use_id',
  'tool_kind',
  'auto_mode',
  'initial',
  'stage',
  'phase',
  'should_block',
  'failure',
  'raw_result',
  'disposition',
  'route',
  'cause',
  'primary_category',
] as const
const SYSTEM_ENVELOPE_FIELDS = new Set([
  'type',
  'sessionId',
  'uuid',
  'timestamp',
  'cwd',
  'version',
  'isSidechain',
  'parentUuid',
])

export type ProjectedAutoModeCapability = Readonly<{
  subtype: 'auto_permission_capability'
  schema_version: typeof AUTO_MODE_OBSERVATION_SCHEMA_VERSION
}>

export function projectAutoModeCapability(
  value: unknown,
): ProjectedAutoModeCapability | null {
  if (
    !object(value) ||
    value.subtype !== 'auto_permission_capability' ||
    value.schema_version !== AUTO_MODE_OBSERVATION_SCHEMA_VERSION ||
    Object.keys(value).some(key =>
      !SYSTEM_ENVELOPE_FIELDS.has(key) &&
      key !== 'subtype' &&
      key !== 'schema_version')
  ) {
    return null
  }
  return {
    subtype: 'auto_permission_capability',
    schema_version: AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
  }
}

function rawEventPayload(value: Record<string, unknown>): Record<string, unknown> | null {
  if (
    Object.keys(value).some(
      key =>
        !SYSTEM_ENVELOPE_FIELDS.has(key) &&
        !(AUTO_MODE_EVENT_FIELDS as readonly string[]).includes(key),
    )
  ) {
    return null
  }
  return Object.fromEntries(
    AUTO_MODE_EVENT_FIELDS.flatMap(key =>
      Object.prototype.hasOwnProperty.call(value, key)
        ? [[key, value[key]]]
        : [],
    ),
  )
}

function minimalInvalidTerminal(value: Record<string, unknown>): ProjectedAutoModeDiagnosticPayload {
  return value.subtype === 'auto_permission_end' && boundedId(value.attempt_id)
    ? { subtype: 'auto_permission_end', attempt_id: value.attempt_id }
    : { subtype: 'auto_permission_invalid' }
}

/**
 * Removes all raw diagnostic content before it reaches the retained Usage
 * index. A malformed End retains only its trusted join identity so the reducer
 * can classify a matching Start as Unknown rather than Incomplete.
 */
export function projectAutoModeDiagnosticPayload(
  value: unknown,
): ProjectedAutoModeDiagnosticPayload | null {
  if (!object(value)) return null
  if (value.subtype === 'auto_mode_observation') {
    const payload = value.auto_mode
    if (!object(payload)) return { subtype: 'auto_permission_invalid' }
    const parsed = parseAutoModeObservationEvent(payload)
    if (parsed !== null) return parsed
    if (
      payload.subtype === 'auto_permission_invalid' &&
      Object.keys(payload).length === 1
    ) {
      return { subtype: 'auto_permission_invalid' }
    }
    return minimalInvalidTerminal(payload)
  }
  if (
    value.subtype !== 'auto_permission_start' &&
    value.subtype !== 'auto_permission_stage' &&
    value.subtype !== 'auto_permission_end'
  ) {
    return null
  }
  const payload = rawEventPayload(value)
  return (
    (payload === null ? null : parseAutoModeObservationEvent(payload)) ??
    minimalInvalidTerminal(value)
  )
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_AUTO_MODE_OBSERVATION_ID_BYTES
}

function validTime(value: string): number | null {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function emptyOutcomes(): AutoModeUsageOutcomeCounts {
  return {
    allowed: 0,
    policy_blocked: 0,
    review_required: 0,
    operational_error: 0,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  }
}

function sourceCoverage(
  sources: readonly AutoModeUsageSource[],
  population: 'allTools' | 'commands',
  rangeStart?: number,
  rangeEnd?: number,
): CoverageState {
  const states = sources.flatMap(source => {
    const observedFrom = source.observedFrom === undefined ? null : validTime(source.observedFrom)
    const observedThrough = source.observedThrough === undefined ? null : validTime(source.observedThrough)
    if (observedFrom !== null && observedThrough !== null && rangeStart !== undefined && rangeEnd !== undefined && (rangeEnd < observedFrom || rangeStart > observedThrough)) return []
    const state = source[population]
    if (state === 'unavailable' || source.supportedFrom === undefined) return [state]
    const supportedFrom = validTime(source.supportedFrom)
    if (supportedFrom === null || rangeStart === undefined || rangeEnd === undefined) return [state]
    if (rangeEnd < supportedFrom) return ['unavailable']
    const overlapStart = observedFrom === null
      ? rangeStart
      : Math.max(rangeStart, observedFrom)
    if (overlapStart < supportedFrom) return ['partial']
    return [state]
  })
  if (states.length === 0 || states.every(state => state === 'unavailable')) return 'unavailable'
  if (states.every(state => state === 'complete')) return 'complete'
  return 'partial'
}

function coverageFor(
  sources: readonly AutoModeUsageSource[],
  population: 'allTools' | 'commands',
  rangeStart?: number,
  rangeEnd?: number,
): AutoModeUsageCoverage {
  return {
    state: sourceCoverage(sources, population, rangeStart, rangeEnd),
    invalidRecords: 0,
    orphanRecords: 0,
  }
}

function population(coverage: AutoModeUsageCoverage): AutoModeUsagePopulation {
  return { outcomes: emptyOutcomes(), coverage }
}

function key(scope: string, attemptId: string): string {
  return JSON.stringify([scope, attemptId])
}

function categoryKey(category: AutoModePrimaryCategory): string {
  return `${category.kind}:${category.id}`
}

function parseTerminal(payload: unknown): Terminal | null {
  if (!object(payload) ||
    payload.schema_version !== AUTO_MODE_OBSERVATION_SCHEMA_VERSION ||
    payload.subtype !== 'auto_permission_end' ||
    !boundedId(payload.attempt_id) ||
    typeof payload.raw_result !== 'string' ||
    !['allow', 'deny', 'ask', 'throw'].includes(payload.raw_result) ||
    typeof payload.disposition !== 'string' ||
    !AUTO_MODE_DISPOSITIONS.includes(payload.disposition as AutoModeDisposition) ||
    !isAutoModeRawDispositionValid(
      payload.raw_result as AutoModeRawPermissionResult,
      payload.disposition as AutoModeDisposition,
    )) {
    return null
  }

  const permitted = new Set([
    'schema_version',
    'subtype',
    'attempt_id',
    'raw_result',
    'disposition',
    'route',
    'cause',
    'primary_category',
  ])
  if (Object.keys(payload).some(field => !permitted.has(field))) return null

  const route = typeof payload.route === 'string' &&
    AUTO_MODE_ROUTES.includes(payload.route as AutoModeRoute)
    ? payload.route as AutoModeRoute
    : 'unknown'
  const category = object(payload.primary_category) &&
    (payload.primary_category.kind === 'built_in' ||
      payload.primary_category.kind === 'custom' ||
      payload.primary_category.kind === 'permission_rule') &&
    boundedId(payload.primary_category.id) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(payload.primary_category.id) &&
    Object.keys(payload.primary_category).length === 2
    ? payload.primary_category as AutoModePrimaryCategory
    : null

  return { disposition: payload.disposition as AutoModeDisposition, route, category }
}

function stageRoute(stages: readonly AutoModeObservationEvent[]): AutoModeRoute {
  return stages.some(stage => stage.subtype === 'auto_permission_stage' && stage.stage === 'thinking')
    ? 'stage2'
    : stages.some(stage => stage.subtype === 'auto_permission_stage' && stage.stage === 'fast')
      ? 'stage1'
      : 'unknown'
}

function terminalEqual(left: Terminal, right: Terminal): boolean {
  return left.disposition === right.disposition
}

function categoryEqual(left: AutoModePrimaryCategory | null, right: AutoModePrimaryCategory | null): boolean {
  return left === null && right === null ||
    left !== null && right !== null && left.kind === right.kind && left.id === right.id
}

function validateStages(stages: readonly AutoModeObservationEvent[]): boolean {
  const state = new Map<AutoModeStage, 'entered' | 'resolved'>()
  for (const stage of stages) {
    if (stage.subtype !== 'auto_permission_stage') continue
    const previous = state.get(stage.stage)
    if (stage.phase === 'entered') {
      if (previous !== undefined) return false
      state.set(stage.stage, 'entered')
    } else {
      if (previous !== 'entered') return false
      state.set(stage.stage, 'resolved')
    }
  }
  return true
}

function markerOrder(marker: Marker): number {
  if (marker.kind !== 'stage' || !marker.stage) return 4
  if (marker.stage.stage === 'fast') return marker.stage.phase === 'entered' ? 0 : 1
  return marker.stage.phase === 'entered' ? 2 : 3
}

function resolvedOutcome(attempt: Attempt): AutoModeUsageOutcome {
  if (attempt.invalidTerminal || attempt.terminalConflict) return 'unknown_outcome'
  return attempt.terminal?.disposition ?? 'incomplete'
}

function resolvedRoute(attempt: Attempt): AutoModeRoute {
  if (attempt.routeConflict || attempt.stageConflict) return 'unknown'
  return attempt.terminal?.route ?? stageRoute(attempt.stages)
}

function finishCoverage(coverage: AutoModeUsageCoverage): void {
  if ((coverage.invalidRecords > 0 || coverage.orphanRecords > 0) && coverage.state === 'complete') {
    coverage.state = 'partial'
  }
}

function incrementOutcome(population: AutoModeUsagePopulation, outcome: AutoModeUsageOutcome): void {
  population.outcomes[outcome]++
}

export type AutoModeUsageAccumulatorOptions = Omit<AutoModeUsageReductionInput, 'records' | 'sources'> & Readonly<{
  /** Charge new long-lived entries before retention; throw to abort collection. */
  onRetain?: (entries: number, estimatedBytes: number) => void
}>

export type AutoModeUsageAccumulator = Readonly<{
  /** Add each complete source once, preserving its original record order. */
  addSource: (records: readonly RetainedAutoModeRecord[]) => void
  /** The optional lower bound refines coverage only, not the ingested population. */
  finish: (sources: readonly AutoModeUsageSource[], coverageRangeStart?: string) => AutoModeUsageSummary
}>

function validatedSources(input: readonly AutoModeUsageSource[]): {
  sourcesByScope: Map<string, AutoModeUsageSource>
  sourceConflict: boolean
} {
  const sourcesByScope = new Map<string, AutoModeUsageSource>()
  let sourceConflict = false
  for (const source of input) {
    if (!boundedId(source.sourceScope) ||
      !['complete', 'partial', 'unavailable'].includes(source.allTools) ||
      !['complete', 'partial', 'unavailable'].includes(source.commands) ||
      (source.supportedFrom !== undefined && validTime(source.supportedFrom) === null) ||
      (source.observedFrom !== undefined && validTime(source.observedFrom) === null) ||
      (source.observedThrough !== undefined && validTime(source.observedThrough) === null) ||
      (source.observedFrom !== undefined && source.observedThrough !== undefined &&
        Date.parse(source.observedFrom) > Date.parse(source.observedThrough)) ||
      (source.supportedFrom !== undefined && source.observedFrom !== undefined &&
        Date.parse(source.supportedFrom) < Date.parse(source.observedFrom)) ||
      (source.supportedFrom !== undefined && source.observedThrough !== undefined &&
        Date.parse(source.supportedFrom) > Date.parse(source.observedThrough))) {
      sourceConflict = true
      continue
    }
    const previous = sourcesByScope.get(source.sourceScope)
    if (previous && (previous.allTools !== source.allTools || previous.commands !== source.commands)) {
      sourceConflict = true
      continue
    }
    sourcesByScope.set(source.sourceScope, source)
  }
  return { sourcesByScope, sourceConflict }
}

/**
 * Keeps only ungrouped counts and coverage evidence between sources. Record
 * identities and attempt joins are scoped to one complete addSource call.
 */
export function createAutoModeUsageAccumulator(input: AutoModeUsageAccumulatorOptions): AutoModeUsageAccumulator {
  const onRetain = input.onRetain
  const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const parsedRangeStart = validTime(input.rangeStart)
  const parsedRangeEnd = validTime(input.rangeEnd)
  const parsedCutoff = validTime(input.cutoff)
  if (parsedRangeStart === null || parsedRangeEnd === null || parsedCutoff === null || parsedRangeStart > parsedRangeEnd || parsedRangeEnd > parsedCutoff) {
    throw new Error('Invalid auto-mode usage reduction range')
  }
  const rangeStart = parsedRangeStart
  const rangeEnd = parsedRangeEnd
  const cutoff = parsedCutoff
  // Until finalization, partial here records historical population evidence.
  const allTools = population({ state: 'complete', invalidRecords: 0, orphanRecords: 0 })
  const commands = population({ state: 'complete', invalidRecords: 0, orphanRecords: 0 })
  const buckets = new Map<string, AutoModeUsageBucket>()
  const routes = new Map<string, number>()
  const categories = new Map<string, { category: AutoModePrimaryCategory; count: number }>()
  const observedScopes = new Set<string>()
  let uncategorized = 0
  let sourceInvalidRecords = 0
  let sourceOrphanRecords = 0

  function addSource(records: readonly RetainedAutoModeRecord[]): void {
    if (records.some(record => record.sourceScope !== records[0]!.sourceScope)) {
      throw new Error('Auto-mode usage addSource requires one complete source')
    }
    const recordHashes = new Map<string, string>()
    const starts = new Map<string, Attempt>()
    const markers = new Map<string, Marker[]>()
    for (const record of records) {
      const timestamp = validTime(record.observedAt)
      if (!boundedId(record.sourceScope) || !boundedId(record.recordId) || timestamp === null) {
        sourceInvalidRecords++
        continue
      }
      if (timestamp > cutoff) continue
      if (!observedScopes.has(record.sourceScope)) {
        onRetain?.(1, 128 + 2 * Buffer.byteLength(record.sourceScope, 'utf8'))
        observedScopes.add(record.sourceScope)
      }
      const identity = JSON.stringify([record.sourceScope, record.recordId])
      const hash = createHash('sha256').update(JSON.stringify(record)).digest('hex')
      const previousHash = recordHashes.get(identity)
      if (previousHash === hash) continue
      if (previousHash !== undefined) {
        sourceInvalidRecords++
        continue
      }
      recordHashes.set(identity, hash)
      if (record.diagnosticKind !== AUTO_MODE_DIAGNOSTIC_KIND || !object(record.payload)) {
        if (timestamp >= rangeStart) sourceInvalidRecords++
        continue
      }
      const attemptId = record.payload.attempt_id
      if (!boundedId(attemptId)) {
        if (timestamp >= rangeStart) sourceInvalidRecords++
        continue
      }
      const joinKey = key(record.sourceScope, attemptId)
      const parsed = parseAutoModeObservationEvent(record.payload)

      if (parsed?.subtype === 'auto_permission_start') {
        const previous = starts.get(joinKey)
        if (!previous) {
          starts.set(joinKey, {
            timestamp,
            date: localDateKey(timestamp, timezone),
            toolKind: parsed.tool_kind,
            start: parsed,
            invalidTerminal: false,
            terminal: null,
            terminalConflict: false,
            routeConflict: false,
            categoryConflict: false,
            stageConflict: false,
            startConflict: false,
            stages: [],
            invalidRecords: 0,
            historical: record.historical === true,
          })
        } else {
          if (
            previous.timestamp !== timestamp ||
            previous.toolKind !== parsed.tool_kind ||
            previous.start.tool_use_id !== parsed.tool_use_id ||
            previous.start.auto_mode !== parsed.auto_mode
          ) {
            previous.invalidRecords++
            previous.startConflict = true
          }
          previous.historical ||= record.historical === true
        }
        continue
      }

      const terminal = record.payload.subtype === 'auto_permission_end'
        ? parseTerminal(record.payload)
        : null
      if (record.payload.subtype === 'auto_permission_end' && terminal === null) {
        markers.set(joinKey, [
          ...(markers.get(joinKey) ?? []),
          { timestamp, recordId: record.recordId, kind: 'invalid_terminal' },
        ])
        continue
      }
      if (parsed?.subtype === 'auto_permission_stage') {
        markers.set(joinKey, [
          ...(markers.get(joinKey) ?? []),
          { timestamp, recordId: record.recordId, kind: 'stage', stage: parsed },
        ])
        continue
      }
      if (terminal !== null) {
        markers.set(joinKey, [
          ...(markers.get(joinKey) ?? []),
          { timestamp, recordId: record.recordId, kind: 'terminal', terminal },
        ])
        continue
      }
      if (timestamp >= rangeStart) sourceInvalidRecords++
    }

    for (const [joinKey, records] of markers) {
      const attempt = starts.get(joinKey)
      if (!attempt) {
        if (records.some(record => record.timestamp >= rangeStart)) sourceOrphanRecords += records.length
        continue
      }
      for (const record of [...records].sort((left, right) =>
        left.timestamp - right.timestamp || markerOrder(left) - markerOrder(right) ||
        left.recordId.localeCompare(right.recordId))) {
        if (record.timestamp < attempt.timestamp) {
          attempt.invalidTerminal = true
          attempt.invalidRecords++
          continue
        }
        if (record.kind === 'stage' && record.stage) {
          attempt.stages.push(record.stage)
          continue
        }
        if (record.kind === 'invalid_terminal' || !record.terminal) {
          attempt.invalidTerminal = true
          attempt.invalidRecords++
          continue
        }
        const terminal = record.terminal
        if (attempt.terminal === null) {
          attempt.terminal = terminal
        } else if (!terminalEqual(attempt.terminal, terminal)) {
          attempt.terminalConflict = true
          attempt.invalidRecords++
        } else {
          if (attempt.terminal.route !== terminal.route) {
            attempt.routeConflict = true
            attempt.invalidRecords++
          }
          if (!categoryEqual(attempt.terminal.category, terminal.category)) {
            attempt.categoryConflict = true
            attempt.invalidRecords++
          }
        }
      }
      if (!validateStages(attempt.stages)) {
        attempt.stageConflict = true
        attempt.invalidRecords++
      }
    }

    for (const attempt of starts.values()) {
      if (attempt.timestamp < rangeStart || attempt.timestamp > rangeEnd || attempt.timestamp > cutoff) continue
      // Conflicting starts are unclassifiable population evidence, never a
      // timestamp chosen by traversal order.
      if (attempt.startConflict) {
        sourceInvalidRecords += attempt.invalidRecords
        continue
      }

      let bucket = buckets.get(attempt.date)
      if (!bucket) {
        onRetain?.(1, 512 + 2 * Buffer.byteLength(attempt.date, 'utf8'))
        bucket = {
          date: attempt.date,
          allTools: population({ state: 'complete', invalidRecords: 0, orphanRecords: 0 }),
          commands: population({ state: 'complete', invalidRecords: 0, orphanRecords: 0 }),
        }
        buckets.set(attempt.date, bucket)
      }
      const outcome = resolvedOutcome(attempt)
      const route = resolvedRoute(attempt)
      incrementOutcome(allTools, outcome)
      incrementOutcome(bucket.allTools, outcome)
      if (attempt.historical) {
        if (allTools.coverage.state === 'complete') allTools.coverage.state = 'partial'
        if (bucket.allTools.coverage.state === 'complete') bucket.allTools.coverage.state = 'partial'
      }
      if (attempt.toolKind === 'bash' || attempt.toolKind === 'powershell') {
        incrementOutcome(commands, outcome)
        incrementOutcome(bucket.commands, outcome)
        if (attempt.historical) {
          if (commands.coverage.state === 'complete') commands.coverage.state = 'partial'
          if (bucket.commands.coverage.state === 'complete') bucket.commands.coverage.state = 'partial'
        }
      }
      const routeKey = JSON.stringify([route, outcome])
      if (!routes.has(routeKey)) onRetain?.(1, 128 + 2 * Buffer.byteLength(routeKey, 'utf8'))
      routes.set(routeKey, (routes.get(routeKey) ?? 0) + 1)

      if (outcome === 'policy_blocked') {
        if (attempt.categoryConflict || attempt.terminal?.category === null) {
          uncategorized++
        } else {
          const category = attempt.terminal?.category
          if (category === null || category === undefined) {
            uncategorized++
          } else {
            const categoryIdentity = categoryKey(category)
            const existing = categories.get(categoryIdentity)
            if (existing) existing.count++
            else {
              onRetain?.(1, 256 + 3 * Buffer.byteLength(categoryIdentity, 'utf8'))
              categories.set(categoryIdentity, { category: { kind: category.kind, id: category.id }, count: 1 })
            }
          }
        }
      }
      allTools.coverage.invalidRecords += attempt.invalidRecords
      bucket.allTools.coverage.invalidRecords += attempt.invalidRecords
      if (attempt.toolKind === 'bash' || attempt.toolKind === 'powershell') {
        commands.coverage.invalidRecords += attempt.invalidRecords
        bucket.commands.coverage.invalidRecords += attempt.invalidRecords
      }
    }
  }

  function finish(globalSources: readonly AutoModeUsageSource[], coverageRangeStart?: string): AutoModeUsageSummary {
    const finalRangeStart = coverageRangeStart === undefined ? rangeStart : validTime(coverageRangeStart)
    if (finalRangeStart === null || finalRangeStart < rangeStart || finalRangeStart > rangeEnd) {
      throw new Error('Invalid auto-mode usage coverage range')
    }
    const { sourcesByScope, sourceConflict } = validatedSources(globalSources)
    const sources = [...sourcesByScope.values()]
    const sourceCoverageUnknown = [...observedScopes].some(scope => !sourcesByScope.has(scope))
    function finalizedPopulation(
      retained: AutoModeUsagePopulation,
      kind: 'allTools' | 'commands',
      start: number,
      end: number,
    ): AutoModeUsagePopulation {
      const coverage = coverageFor(sources, kind, start, end)
      coverage.invalidRecords = retained.coverage.invalidRecords
      if (retained.coverage.state === 'partial' && coverage.state === 'complete') coverage.state = 'partial'
      return { outcomes: { ...retained.outcomes }, coverage }
    }
    const finalAllTools = finalizedPopulation(allTools, 'allTools', finalRangeStart, rangeEnd)
    const finalCommands = finalizedPopulation(commands, 'commands', finalRangeStart, rangeEnd)
    const finalBuckets = [...buckets.values()].map(bucket => {
      const bucketStart = localMidnight(bucket.date, timezone)
      const bucketEnd = Math.min(localMidnight(addCalendarDays(bucket.date, 1), timezone) - 1, rangeEnd)
      return {
        date: bucket.date,
        allTools: finalizedPopulation(bucket.allTools, 'allTools', bucketStart, bucketEnd),
        commands: finalizedPopulation(bucket.commands, 'commands', bucketStart, bucketEnd),
      }
    })
    finalAllTools.coverage.invalidRecords += sourceInvalidRecords + (sourceConflict ? 1 : 0)
    finalCommands.coverage.invalidRecords += sourceInvalidRecords + (sourceConflict ? 1 : 0)
    finalAllTools.coverage.orphanRecords += sourceOrphanRecords
    finalCommands.coverage.orphanRecords += sourceOrphanRecords
    if (sourceCoverageUnknown) {
      if (finalAllTools.coverage.state === 'complete') finalAllTools.coverage.state = 'partial'
      if (finalCommands.coverage.state === 'complete') finalCommands.coverage.state = 'partial'
    }
    finishCoverage(finalAllTools.coverage)
    finishCoverage(finalCommands.coverage)
    for (const bucket of finalBuckets) {
      if (sourceConflict || sourceInvalidRecords > 0 || sourceOrphanRecords > 0 || sourceCoverageUnknown) {
        // These diagnostics have no trustworthy start bucket, so conservatively
        // suppress a claimed complete bucket without inventing one for them.
        if (bucket.allTools.coverage.state === 'complete') bucket.allTools.coverage.state = 'partial'
        if (bucket.commands.coverage.state === 'complete') bucket.commands.coverage.state = 'partial'
      }
      finishCoverage(bucket.allTools.coverage)
      finishCoverage(bucket.commands.coverage)
    }

    const namedCategories = [...categories.entries()]
      .sort(([leftKey, left], [rightKey, right]) => right.count - left.count || leftKey.localeCompare(rightKey))
    const categorySummary: AutoModeUsageSummary['categories'] = namedCategories.slice(0, 8).map(([categoryIdentity, entry]) => ({
      key: categoryIdentity,
      kind: 'named' as const,
      label: entry.category.id,
      count: entry.count,
    }))
    const otherCount = namedCategories.slice(8).reduce((total, [, entry]) => total + entry.count, 0)
    if (otherCount > 0) categorySummary.push({ key: 'other', kind: 'other', label: 'Other', count: otherCount })
    if (uncategorized > 0) {
      categorySummary.push({ key: 'uncategorized', kind: 'uncategorized', label: 'Uncategorized', count: uncategorized })
    }

    return {
      allTools: finalAllTools,
      commands: finalCommands,
      buckets: finalBuckets.sort((left, right) => left.date.localeCompare(right.date)),
      routes: [...routes.entries()]
        .map(([routeAndOutcome, count]) => {
          const [route, outcome] = JSON.parse(routeAndOutcome) as [AutoModeRoute, AutoModeUsageOutcome]
          return { route, outcome, count }
        })
        .sort((left, right) => left.route.localeCompare(right.route) || left.outcome.localeCompare(right.outcome)),
      categories: categorySummary,
    }
  }
  return { addSource, finish }
}

/**
 * Reduces synthetic, metadata-only retained records. Partitioning preserves
 * within-source order, including first-observed record identity conflicts.
 */
export function reduceAutoModeUsage(input: AutoModeUsageReductionInput): AutoModeUsageSummary {
  const accumulator = createAutoModeUsageAccumulator(input)
  const recordsByScope = new Map<string, RetainedAutoModeRecord[]>()
  for (const record of input.records) {
    const records = recordsByScope.get(record.sourceScope)
    if (records) records.push(record)
    else recordsByScope.set(record.sourceScope, [record])
  }
  for (const records of recordsByScope.values()) accumulator.addSource(records)
  return accumulator.finish(input.sources)
}
