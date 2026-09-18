import {
  AUTO_MODE_DISPOSITIONS,
  AUTO_MODE_OBSERVATION_SCHEMA_VERSION,
  AUTO_MODE_ROUTES,
  MAX_AUTO_MODE_OBSERVATION_ID_BYTES,
  parseAutoModeObservationEvent,
  type AutoModeDisposition,
  type AutoModeObservationEvent,
  type AutoModePrimaryCategory,
  type AutoModeRoute,
  type AutoModeStage,
} from './permissions/autoModeObservation.js'
import { createHash } from 'node:crypto'
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
}>

export type AutoModeUsageSource = Readonly<{
  sourceScope: string
  allTools: CoverageState
  commands: CoverageState
}>

export type AutoModeUsageReductionInput = Readonly<{
  records: readonly RetainedAutoModeRecord[]
  sources: readonly AutoModeUsageSource[]
  rangeStart: string
  rangeEnd: string
  cutoff: string
}>

export type AutoModeCommandRate = Readonly<{
  numerator: number
  denominator: number
  rate: number | null
  state: 'confirmed' | 'provisional' | 'unavailable'
}>

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
  scope: string
  attemptId: string
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
}

const AUTO_MODE_DIAGNOSTIC_KIND = 'auto_mode_observation'
const OUTCOMES: readonly AutoModeUsageOutcome[] = [
  'allowed',
  'policy_blocked',
  'review_required',
  'operational_error',
  'cancelled',
  'unknown_outcome',
  'incomplete',
]

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

function cloneCoverage(coverage: AutoModeUsageCoverage): AutoModeUsageCoverage {
  return { ...coverage }
}

function sourceCoverage(sources: readonly AutoModeUsageSource[], population: 'allTools' | 'commands'): CoverageState {
  const states = sources.map(source => source[population])
  if (states.length === 0 || states.every(state => state === 'unavailable')) return 'unavailable'
  if (states.every(state => state === 'complete')) return 'complete'
  return 'partial'
}

function coverageFor(
  sources: readonly AutoModeUsageSource[],
  population: 'allTools' | 'commands',
): AutoModeUsageCoverage {
  return {
    state: sourceCoverage(sources, population),
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
    !AUTO_MODE_DISPOSITIONS.includes(payload.disposition as AutoModeDisposition)) {
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

/**
 * Reduces synthetic, metadata-only retained records. The caller supplies only
 * source coverage relevant to the requested range; transcript reading and
 * durable identity storage remain outside this pure reducer.
 */
export function reduceAutoModeUsage(input: AutoModeUsageReductionInput): AutoModeUsageSummary {
  const rangeStart = validTime(input.rangeStart)
  const rangeEnd = validTime(input.rangeEnd)
  const cutoff = validTime(input.cutoff)
  if (rangeStart === null || rangeEnd === null || cutoff === null || rangeStart > rangeEnd || rangeEnd > cutoff) {
    throw new Error('Invalid auto-mode usage reduction range')
  }

  const sourcesByScope = new Map<string, AutoModeUsageSource>()
  let sourceConflict = false
  for (const source of input.sources) {
    if (!boundedId(source.sourceScope) ||
      !['complete', 'partial', 'unavailable'].includes(source.allTools) ||
      !['complete', 'partial', 'unavailable'].includes(source.commands)) {
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
  const sources = [...sourcesByScope.values()]
  const allTools = population(coverageFor(sources, 'allTools'))
  const commands = population(coverageFor(sources, 'commands'))
  const buckets = new Map<string, AutoModeUsageBucket>()
  const routes = new Map<string, number>()
  const categories = new Map<string, { category: AutoModePrimaryCategory; count: number }>()
  let uncategorized = 0
  let sourceInvalidRecords = sourceConflict ? 1 : 0
  let sourceOrphanRecords = 0
  let sourceCoverageUnknown = false

  const recordHashes = new Map<string, string>()
  const starts = new Map<string, Attempt>()
  const markers = new Map<string, Marker[]>()
  for (const record of input.records) {
    const timestamp = validTime(record.observedAt)
    if (!boundedId(record.sourceScope) || !boundedId(record.recordId) || timestamp === null) {
      sourceInvalidRecords++
      continue
    }
    if (timestamp > cutoff) continue
    if (!sourcesByScope.has(record.sourceScope)) sourceCoverageUnknown = true
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
          scope: record.sourceScope,
          attemptId,
          timestamp,
          date: new Date(timestamp).toISOString().slice(0, 10),
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
        })
      } else if (
        previous.timestamp !== timestamp ||
        previous.toolKind !== parsed.tool_kind ||
        previous.start.tool_use_id !== parsed.tool_use_id ||
        previous.start.auto_mode !== parsed.auto_mode
      ) {
        previous.invalidRecords++
        previous.startConflict = true
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

    const bucket = buckets.get(attempt.date) ?? {
      date: attempt.date,
      allTools: population(cloneCoverage(allTools.coverage)),
      commands: population(cloneCoverage(commands.coverage)),
    }
    buckets.set(attempt.date, bucket)
    const outcome = resolvedOutcome(attempt)
    const route = resolvedRoute(attempt)
    incrementOutcome(allTools, outcome)
    incrementOutcome(bucket.allTools, outcome)
    if (attempt.toolKind === 'bash' || attempt.toolKind === 'powershell') {
      incrementOutcome(commands, outcome)
      incrementOutcome(bucket.commands, outcome)
    }
    routes.set(JSON.stringify([route, outcome]), (routes.get(JSON.stringify([route, outcome])) ?? 0) + 1)

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
          else categories.set(categoryIdentity, { category, count: 1 })
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

  allTools.coverage.invalidRecords += sourceInvalidRecords
  commands.coverage.invalidRecords += sourceInvalidRecords
  allTools.coverage.orphanRecords += sourceOrphanRecords
  commands.coverage.orphanRecords += sourceOrphanRecords
  if (sourceCoverageUnknown) {
    if (allTools.coverage.state === 'complete') allTools.coverage.state = 'partial'
    if (commands.coverage.state === 'complete') commands.coverage.state = 'partial'
  }
  finishCoverage(allTools.coverage)
  finishCoverage(commands.coverage)
  for (const bucket of buckets.values()) {
    if (sourceInvalidRecords > 0 || sourceOrphanRecords > 0 || sourceCoverageUnknown) {
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
    allTools,
    commands,
    buckets: [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date)),
    routes: [...routes.entries()]
      .map(([routeAndOutcome, count]) => {
        const [route, outcome] = JSON.parse(routeAndOutcome) as [AutoModeRoute, AutoModeUsageOutcome]
        return { route, outcome, count }
      })
      .sort((left, right) => left.route.localeCompare(right.route) || left.outcome.localeCompare(right.outcome)),
    categories: categorySummary,
  }
}

export function autoModeCommandRate(summary: AutoModeUsageSummary): AutoModeCommandRate {
  const numerator = summary.commands.outcomes.policy_blocked
  const denominator = OUTCOMES.reduce((total, outcome) => total + summary.commands.outcomes[outcome], 0)
  const coverage = summary.commands.coverage
  if (coverage.state !== 'complete' || denominator === 0) {
    return { numerator, denominator, rate: null, state: 'unavailable' }
  }
  const unresolved = summary.commands.outcomes.incomplete + summary.commands.outcomes.unknown_outcome
  return {
    numerator,
    denominator,
    rate: numerator / denominator,
    state: unresolved > 0 ? 'provisional' : 'confirmed',
  }
}
