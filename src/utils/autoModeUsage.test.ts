import { expect, test } from 'bun:test'
import {
  classifyHistoricalAutoModeToolResult,
  createAutoModeUsageAccumulator,
  projectAutoModeCapability,
  projectAutoModeDiagnosticPayload,
  reduceAutoModeUsage,
  type AutoModeUsageReductionInput,
  type AutoModeUsageSource,
  type RetainedAutoModeRecord,
} from './autoModeUsage.js'
import { hundredAttemptAutoModeFixture } from './autoModeUsage.fixture.js'

test('classifies only code-owned historical Auto mode result text', () => {
  expect(classifyHistoricalAutoModeToolResult(
    'Permission for this action has been denied. Reason: policy rule',
  )).toBe('policy_blocked')
  expect(classifyHistoricalAutoModeToolResult(
    'The auto mode classifier request using model is temporarily unavailable, so auto mode cannot determine the safety of Bash right now.',
  )).toBe('operational_error')
  expect(classifyHistoricalAutoModeToolResult(
    'Tool output quoted: Permission for this action has been denied. Reason: policy rule',
  )).toBeNull()
  expect(classifyHistoricalAutoModeToolResult({ content: 'not text' })).toBeNull()
})

test('accepts only the bounded auto-mode capability marker', () => {
  expect(projectAutoModeCapability({
    type: 'system',
    subtype: 'auto_permission_capability',
    schema_version: 1,
    uuid: 'capability',
    timestamp: '2026-09-19T00:00:00.000Z',
    version: 'test',
  })).toEqual({
    subtype: 'auto_permission_capability',
    schema_version: 1,
  })
  expect(projectAutoModeCapability({
    subtype: 'auto_permission_capability',
    schema_version: 1,
    raw: 'not allowed',
  })).toBeNull()
})

const source: AutoModeUsageSource = {
  sourceScope: 'source',
  allTools: 'complete',
  commands: 'complete',
}

function row(
  recordId: string,
  observedAt: string,
  payload: Record<string, unknown>,
  sourceScope = source.sourceScope,
): RetainedAutoModeRecord {
  return { sourceScope, recordId, observedAt, diagnosticKind: 'auto_mode_observation', payload }
}

function start(id: string, observedAt = '2026-09-10T12:00:00.000Z', toolKind = 'bash'): RetainedAutoModeRecord {
  return row(`start-${id}`, observedAt, {
    schema_version: 1,
    subtype: 'auto_permission_start',
    attempt_id: id,
    tool_use_id: `tool-${id}`,
    tool_kind: toolKind,
    auto_mode: 'auto',
    initial: true,
  })
}

function end(
  id: string,
  disposition: string,
  observedAt = '2026-09-10T12:01:00.000Z',
  detail: Record<string, unknown> = {},
): RetainedAutoModeRecord {
  return row(`end-${id}`, observedAt, {
    schema_version: 1,
    subtype: 'auto_permission_end',
    attempt_id: id,
    raw_result: disposition === 'allowed' ? 'allow' : 'deny',
    disposition,
    route: 'base',
    ...detail,
  })
}

function reduce(records: readonly RetainedAutoModeRecord[], sources: readonly AutoModeUsageSource[] = [source]) {
  const input = {
    records,
    sources,
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-10T23:59:59.999Z',
    cutoff: '2026-09-11T00:00:00.000Z',
  }
  const summary = reduceAutoModeUsage(input)
  expect(accumulated(input)).toEqual(summary)
  expect(accumulated(input, true)).toEqual(summary)
  return summary
}

function accumulated(input: AutoModeUsageReductionInput, reverseSources = false) {
  const accumulator = createAutoModeUsageAccumulator(input)
  const scopes = [...new Set(input.records.map(record => record.sourceScope))]
  if (reverseSources) scopes.reverse()
  for (const scope of scopes) accumulator.addSource(input.records.filter(record => record.sourceScope === scope))
  return accumulator.finish(input.sources)
}

test('projects only validated events or minimal data-quality markers', () => {
  const valid = projectAutoModeDiagnosticPayload({
    type: 'system',
    subtype: 'auto_permission_start',
    schema_version: 1,
    attempt_id: 'attempt-1',
    tool_use_id: 'tool-1',
    tool_kind: 'bash',
    auto_mode: 'auto',
    initial: true,
  })
  const malformedEnd = projectAutoModeDiagnosticPayload({
    type: 'system',
    subtype: 'auto_permission_end',
    attempt_id: 'attempt-1',
    raw_result: 'deny',
    disposition: 'not-valid',
    route: 'base',
    command: 'DO NOT RETAIN',
  })
  const untrustedEnd = projectAutoModeDiagnosticPayload({
    type: 'system',
    subtype: 'auto_permission_end',
    attempt_id: '',
    command: 'DO NOT RETAIN',
  })

  expect(valid).toEqual({
    subtype: 'auto_permission_start',
    schema_version: 1,
    attempt_id: 'attempt-1',
    tool_use_id: 'tool-1',
    tool_kind: 'bash',
    auto_mode: 'auto',
    initial: true,
  })
  expect(malformedEnd).toEqual({
    subtype: 'auto_permission_end',
    attempt_id: 'attempt-1',
  })
  expect(untrustedEnd).toEqual({ subtype: 'auto_permission_invalid' })
})

test('reconciles the deterministic 100-attempt fixture and command population', () => {
  const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())
  expect(accumulated(hundredAttemptAutoModeFixture())).toEqual(summary)

  expect(summary.allTools.outcomes).toEqual({
    allowed: 85,
    policy_blocked: 7,
    review_required: 4,
    operational_error: 4,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  })
  expect(summary.commands.outcomes.policy_blocked).toBe(4)
  expect(Object.values(summary.commands.outcomes).reduce((total, count) => total + count, 0)).toBe(40)
  expect(summary.categories.reduce((total, category) => total + category.count, 0)).toBe(7)
})

test('is independent of record order and exact duplicate records', () => {
  const fixture = hundredAttemptAutoModeFixture()
  const expected = reduceAutoModeUsage(fixture)
  const duplicatedAndReversed = {
    ...fixture,
    records: [...fixture.records, fixture.records[0]!, fixture.records.at(-1)!].reverse(),
  }
  expect(reduceAutoModeUsage(duplicatedAndReversed)).toEqual(expected)
  expect(accumulated(duplicatedAndReversed)).toEqual(expected)
})

test('excludes invalid starts and orphan records from every denominator', () => {
  const invalidStart = row('bad-start', '2026-09-10T12:00:00.000Z', {
    schema_version: 1,
    subtype: 'auto_permission_start',
    attempt_id: 'bad',
    tool_use_id: 'tool-bad',
    tool_kind: 'bash',
    auto_mode: 'auto',
    initial: false,
  })
  const summary = reduce([
    invalidStart,
    end('bad', 'policy_blocked'),
    end('orphan', 'policy_blocked'),
  ])

  expect(summary.allTools.outcomes).toEqual({
    allowed: 0,
    policy_blocked: 0,
    review_required: 0,
    operational_error: 0,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  })
  expect(summary.commands.outcomes.policy_blocked).toBe(0)
  expect(summary.allTools.coverage).toMatchObject({ state: 'partial', invalidRecords: 1, orphanRecords: 2 })
})

test('marks command coverage partial for mixed source evidence', () => {
  const summary = reduce(
    [start('covered'), end('covered', 'policy_blocked')],
    [
      source,
      { sourceScope: 'unsupported-source', allTools: 'unavailable', commands: 'unavailable' },
    ],
  )

  expect(summary.commands.outcomes.policy_blocked).toBe(1)
  expect(summary.commands.coverage.state).toBe('partial')
})

test('sums unequal command denominators instead of averaging daily rates', () => {
  const records: RetainedAutoModeRecord[] = []
  for (let index = 0; index < 100; index++) {
    const id = `rate-${index}`
    const date = index < 10 ? '2026-09-10' : '2026-09-11'
    records.push(start(id, `${date}T12:00:00.000Z`))
    records.push(end(id, index === 0 || index === 10 ? 'policy_blocked' : 'allowed', `${date}T12:01:00.000Z`))
  }
  const summary = reduceAutoModeUsage({
    records,
    sources: [source],
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-11T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
    timezone: 'UTC',
  })

  expect(summary.commands.outcomes).toEqual({
    allowed: 98,
    policy_blocked: 2,
    review_required: 0,
    operational_error: 0,
    cancelled: 0,
    unknown_outcome: 0,
    incomplete: 0,
  })
  expect(summary.commands.coverage.state).toBe('complete')
  const dailyCommandCounts = summary.buckets.map(bucket => ({
    date: bucket.date,
    denominator: Object.values(bucket.commands.outcomes).reduce((total, count) => total + count, 0),
    policyBlocked: bucket.commands.outcomes.policy_blocked,
  }))
  expect(dailyCommandCounts).toEqual([
    { date: '2026-09-10', denominator: 10, policyBlocked: 1 },
    { date: '2026-09-11', denominator: 90, policyBlocked: 1 },
  ])
})

test('salvages a malformed correlated End as one Unknown instead of Incomplete', () => {
  const malformed = row('malformed-end', '2026-09-10T12:01:00.000Z', {
    schema_version: 1,
    subtype: 'auto_permission_end',
    attempt_id: 'salvage',
    raw_result: 'deny',
    disposition: 'not-a-disposition',
    route: 'base',
  })
  const summary = reduce([start('salvage'), malformed])

  expect(summary.allTools.outcomes.unknown_outcome).toBe(1)
  expect(summary.allTools.outcomes.incomplete).toBe(0)
  expect(summary.allTools.coverage.invalidRecords).toBe(1)
})

test('degrades contradictory raw-result and disposition evidence to Unknown', () => {
  const contradictory = row('contradictory-end', '2026-09-10T12:01:00.000Z', {
    schema_version: 1,
    subtype: 'auto_permission_end',
    attempt_id: 'contradictory',
    raw_result: 'deny',
    disposition: 'allowed',
    route: 'base',
  })
  const summary = reduce([start('contradictory'), contradictory])

  expect(summary.allTools.outcomes.unknown_outcome).toBe(1)
  expect(summary.allTools.outcomes.allowed).toBe(0)
  expect(summary.allTools.coverage).toMatchObject({
    state: 'partial',
    invalidRecords: 1,
  })
})

test('does not create an attempt from a terminal with an untrusted identity', () => {
  const summary = reduce([row('invalid-identity', '2026-09-10T12:01:00.000Z', {
    schema_version: 1,
    subtype: 'auto_permission_end',
    attempt_id: '',
    raw_result: 'deny',
    disposition: 'policy_blocked',
    route: 'base',
  })])

  expect(Object.values(summary.allTools.outcomes).reduce((total, count) => total + count, 0)).toBe(0)
  expect(summary.allTools.coverage).toMatchObject({ state: 'partial', invalidRecords: 1, orphanRecords: 0 })
})

test('keeps joins within source scope and excludes contradictory starts', () => {
  const conflictingStart = row('start-same-conflict', '2026-09-10T12:00:01.000Z', {
    schema_version: 1,
    subtype: 'auto_permission_start',
    attempt_id: 'same',
    tool_use_id: 'different-tool',
    tool_kind: 'bash',
    auto_mode: 'auto',
    initial: true,
  })
  const summary = reduce(
    [
      start('same'),
      conflictingStart,
      { ...end('same', 'policy_blocked'), sourceScope: 'other-source' },
    ],
    [source, { sourceScope: 'other-source', allTools: 'complete', commands: 'complete' }],
  )

  expect(Object.values(summary.allTools.outcomes).reduce((total, count) => total + count, 0)).toBe(0)
  expect(summary.allTools.coverage).toMatchObject({ state: 'partial', invalidRecords: 1, orphanRecords: 1 })
})

test('attributes a later eligible terminal to its start local-day bucket and ignores post-cutoff records', () => {
  const summary = reduceAutoModeUsage({
    records: [
      start('cross-midnight', '2026-09-10T23:59:00.000Z'),
      end('cross-midnight', 'allowed', '2026-09-11T00:01:00.000Z'),
      start('post-cutoff'),
      end('post-cutoff', 'policy_blocked', '2026-09-12T00:01:00.000Z'),
    ],
    sources: [source],
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-10T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
  })

  expect(summary.buckets).toHaveLength(1)
  expect(summary.buckets[0]!.date).toBe('2026-09-10')
  expect(summary.allTools.outcomes).toMatchObject({ allowed: 1, incomplete: 1, policy_blocked: 0 })
})

test('ranks categories range-wide and namespaces equal IDs by category kind', () => {
  const records: RetainedAutoModeRecord[] = []
  const add = (id: string, kind: 'built_in' | 'custom', category: string, sourceScope = source.sourceScope) => {
    records.push({ ...start(id, '2026-09-10T12:00:00.000Z', 'other'), sourceScope })
    records.push({ ...end(id, 'policy_blocked', '2026-09-10T12:01:00.000Z', {
      primary_category: { kind, id: category },
    }), sourceScope })
  }
  for (const sourceScope of ['source-a', 'source-b']) {
    for (let index = 0; index < 8; index++) {
      add(`${sourceScope}-${index}-a`, 'custom', `${sourceScope}-${index}`, sourceScope)
      add(`${sourceScope}-${index}-b`, 'custom', `${sourceScope}-${index}`, sourceScope)
    }
    // This is ninth within each source, but its exact range-wide total belongs
    // in the global top eight after stable key tie-breaking.
    add(`${sourceScope}-combined`, 'built_in', 'combined', sourceScope)
  }
  for (let index = 0; index < 3; index++) {
    add(`same-built-in-${index}`, 'built_in', 'shared')
    add(`same-custom-${index}`, 'custom', 'shared')
  }
  const summary = reduce(records, [
    source,
    { sourceScope: 'source-a', allTools: 'complete', commands: 'complete' },
    { sourceScope: 'source-b', allTools: 'complete', commands: 'complete' },
  ])

  expect(summary.categories.filter(category => category.kind === 'named').map(category => category.key))
    .toContain('built_in:combined')
  expect(summary.categories).toContainEqual(expect.objectContaining({ key: 'built_in:shared', count: 3 }))
  expect(summary.categories).toContainEqual(expect.objectContaining({ key: 'custom:shared', count: 3 }))
})

test('keeps known dispositions when only route or category detail is invalid', () => {
  const summary = reduce([
    start('missing-route'),
    end('missing-route', 'allowed', '2026-09-10T12:01:00.000Z', { route: 'bad-route' }),
    start('missing-category', '2026-09-10T12:02:00.000Z'),
    end('missing-category', 'policy_blocked', '2026-09-10T12:03:00.000Z', {
      primary_category: { kind: 'custom', id: 'not valid' },
    }),
  ])

  expect(summary.allTools.outcomes.allowed).toBe(1)
  expect(summary.allTools.outcomes.policy_blocked).toBe(1)
  expect(summary.allTools.outcomes.unknown_outcome).toBe(0)
  expect(summary.routes).toContainEqual({ route: 'unknown', outcome: 'allowed', count: 1 })
  expect(summary.categories).toContainEqual({
    key: 'uncategorized',
    kind: 'uncategorized',
    label: 'Uncategorized',
    count: 1,
  })
})

test('does not treat pre-capability intervals as measured zero', () => {
  const summary = reduceAutoModeUsage({
    records: [start('prospective', '2026-09-11T12:00:00.000Z')],
    sources: [{
      ...source,
      supportedFrom: '2026-09-11T12:00:00.000Z',
    }],
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-11T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
  })

  expect(summary.allTools.coverage.state).toBe('partial')
  expect(summary.buckets[0]!.allTools.coverage.state).toBe('partial')
})

test('treats a source-first capability marker as complete for its overlap', () => {
  const summary = reduceAutoModeUsage({
    records: [start('capable', '2026-09-11T12:01:00.000Z')],
    sources: [{
      ...source,
      supportedFrom: '2026-09-11T12:00:00.000Z',
      observedFrom: '2026-09-11T12:00:00.000Z',
      observedThrough: '2026-09-11T23:59:59.999Z',
    }],
    rangeStart: '2026-09-11T00:00:00.000Z',
    rangeEnd: '2026-09-11T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
  })

  expect(summary.allTools.coverage.state).toBe('complete')
  expect(summary.buckets[0]!.allTools.coverage.state).toBe('complete')
})

test('ignores non-overlapping sources but retains overlapping unavailable evidence', () => {
  const records = [start('current', '2026-09-11T12:00:00.000Z')]
  const base = {
    records,
    rangeStart: '2026-09-11T00:00:00.000Z',
    rangeEnd: '2026-09-11T23:59:59.999Z',
    cutoff: '2026-09-12T00:00:00.000Z',
  }
  expect(reduceAutoModeUsage({
    ...base,
    sources: [
      { ...source, supportedFrom: '2026-09-11T12:00:00.000Z', observedFrom: '2026-09-11T00:00:00.000Z', observedThrough: '2026-09-11T23:59:59.999Z' },
      { sourceScope: 'old', allTools: 'unavailable', commands: 'unavailable', observedFrom: '2020-01-01T00:00:00.000Z', observedThrough: '2020-01-02T00:00:00.000Z' },
      { sourceScope: 'future', allTools: 'unavailable', commands: 'unavailable', observedFrom: '2026-09-13T00:00:00.000Z', observedThrough: '2026-09-14T00:00:00.000Z' },
    ],
  }).allTools.coverage.state).toBe('partial')
  expect(reduceAutoModeUsage({
    ...base,
    sources: [
      { ...source, supportedFrom: '2026-09-11T00:00:00.000Z', observedFrom: '2026-09-11T00:00:00.000Z', observedThrough: '2026-09-11T23:59:59.999Z' },
      { sourceScope: 'overlap', allTools: 'unavailable', commands: 'unavailable', observedFrom: '2026-09-11T00:00:00.000Z', observedThrough: '2026-09-11T23:59:59.999Z' },
    ],
  }).allTools.coverage.state).toBe('partial')
})

test('an orphan-only source degrades another source bucket globally without inventing a bucket', () => {
  const orphan = { ...end('orphan', 'allowed'), sourceScope: 'orphan-source' }
  const input: AutoModeUsageReductionInput = {
    ...hundredAttemptAutoModeFixture(),
    records: [start('measured'), orphan, end('measured', 'allowed')],
    sources: [source, { ...source, sourceScope: 'orphan-source' }],
  }
  const summary = accumulated(input, true)
  expect(summary).toEqual(reduceAutoModeUsage(input))
  expect(summary.allTools.coverage).toEqual({ state: 'partial', invalidRecords: 0, orphanRecords: 1 })
  expect(summary.buckets).toHaveLength(1)
  expect(summary.buckets[0]!.commands.coverage).toEqual({ state: 'partial', invalidRecords: 0, orphanRecords: 0 })
  expect(summary.allTools.outcomes.allowed).toBe(1)
})

test('finalizes zero-attempt source overlap and capability coverage after all sources arrive', () => {
  const input: AutoModeUsageReductionInput = {
    ...hundredAttemptAutoModeFixture(),
    records: [start('measured'), end('measured', 'allowed')],
    sources: [source],
    timezone: 'UTC',
  }
  const accumulator = createAutoModeUsageAccumulator(input)
  accumulator.addSource(input.records)
  accumulator.addSource([])
  const preCapability: AutoModeUsageSource = {
    ...source,
    sourceScope: 'empty',
    observedFrom: input.rangeStart,
    observedThrough: input.rangeEnd,
    supportedFrom: '2026-09-10T18:00:00.000Z',
  }
  const summary = accumulator.finish([source, preCapability])
  expect(summary).toEqual(reduceAutoModeUsage({ ...input, sources: [source, preCapability] }))
  expect(summary.allTools.coverage.state).toBe('partial')
  expect(summary.buckets[0]!.allTools.coverage.state).toBe('partial')
  const nonOverlapping: AutoModeUsageSource = {
    ...preCapability,
    observedFrom: '2020-01-01T00:00:00.000Z',
    observedThrough: '2020-01-02T00:00:00.000Z',
    supportedFrom: '2020-01-02T00:00:00.000Z',
    allTools: 'unavailable',
    commands: 'unavailable',
  }
  expect(accumulator.finish([source, nonOverlapping]).allTools.coverage.state).toBe('complete')
  // Returned summaries do not alias retained counts or coverage.
  summary.allTools.outcomes.allowed = 999
  summary.buckets[0]!.commands.coverage.invalidRecords = 999
  expect(accumulator.finish([source])).toEqual(reduceAutoModeUsage(input))
})

test('preserves interleaved source joins and post-range terminals in shuffled source order', () => {
  const other = (record: RetainedAutoModeRecord) => ({ ...record, sourceScope: 'other' })
  const input: AutoModeUsageReductionInput = {
    ...hundredAttemptAutoModeFixture(),
    records: [
      start('same', '2026-09-10T23:59:00.000Z'),
      other(end('same', 'policy_blocked', '2026-09-11T00:02:00.000Z')),
      end('same', 'allowed', '2026-09-11T00:01:00.000Z'),
      other(start('same')),
      other(start('same')),
      end('same', 'policy_blocked', '2026-09-12T00:01:00.000Z'),
    ],
    sources: [source, { ...source, sourceScope: 'other' }],
    cutoff: '2026-09-12T00:00:00.000Z',
    timezone: 'UTC',
  }
  const summary = accumulated(input, true)
  expect(summary).toEqual(reduceAutoModeUsage(input))
  expect(summary.allTools.outcomes).toMatchObject({ allowed: 1, policy_blocked: 1, incomplete: 0 })
  expect(summary.buckets).toHaveLength(1)
  expect(accumulated({ ...input, records: [...input.records].reverse() })).toEqual(summary)
})

test('keeps replay and identity conflicts local while finalizing invalid and unknown-source evidence globally', () => {
  const valid = end('identity', 'allowed')
  const conflictingIdentity = { ...end('identity', 'policy_blocked'), recordId: valid.recordId }
  const invalid = { ...start('invalid'), recordId: '' }
  const terminalConflict = { ...end('terminal', 'policy_blocked'), recordId: 'second-terminal' }
  const startConflict = { ...start('start-conflict'), recordId: 'second-start', observedAt: '2026-09-10T12:01:00.000Z' }
  const input: AutoModeUsageReductionInput = {
    ...hundredAttemptAutoModeFixture(),
    records: [
      start('identity'), valid, valid, conflictingIdentity, valid,
      invalid,
      start('terminal'), end('terminal', 'allowed'), terminalConflict,
      start('start-conflict'), startConflict,
      { ...start('unknown'), sourceScope: 'unknown-source' },
      { ...end('unknown', 'allowed'), sourceScope: 'unknown-source' },
    ],
    sources: [
      source,
      source,
      { ...source, commands: 'partial' },
      { ...source, sourceScope: 'bad-interval', observedFrom: '2026-09-11T00:00:00Z', observedThrough: '2026-09-10T00:00:00Z' },
    ],
  }
  const summary = accumulated(input, true)
  expect(summary).toEqual(reduceAutoModeUsage(input))
  expect(summary.allTools.outcomes).toMatchObject({ allowed: 2, unknown_outcome: 1, policy_blocked: 0 })
  expect(summary.allTools.coverage).toEqual({ state: 'partial', invalidRecords: 5, orphanRecords: 0 })
  expect(summary.buckets[0]!.allTools.coverage).toEqual({ state: 'partial', invalidRecords: 1, orphanRecords: 0 })
  const reversedConflict = { ...input, records: [start('identity'), conflictingIdentity, valid, valid] }
  expect(accumulated(reversedConflict).allTools.outcomes.policy_blocked).toBe(1)
  expect(accumulated(reversedConflict)).toEqual(reduceAutoModeUsage(reversedConflict))
})

test('uses a fixed year-zero ingest bound while refining final all-history coverage', () => {
  const recent = [start('recent'), end('recent', 'allowed')]
  const old = [
    { ...start('old', '2020-01-01T12:00:00.000Z'), sourceScope: 'old-source', historical: true as const },
    { ...end('old', 'policy_blocked', '2020-01-01T12:01:00.000Z'), sourceScope: 'old-source' },
  ]
  const input: AutoModeUsageReductionInput = {
    records: [...recent, ...old],
    sources: [source, { ...source, sourceScope: 'old-source' }],
    rangeStart: '0000-01-01T00:00:00Z',
    rangeEnd: '2026-09-10T23:59:59.999Z',
    cutoff: '2026-09-11T00:00:00.000Z',
    timezone: 'UTC',
  }
  const accumulator = createAutoModeUsageAccumulator(input)
  accumulator.addSource(recent)
  accumulator.addSource(old)
  const actualStart = '2020-01-01T00:00:00.000Z'
  expect(accumulator.finish(input.sources, actualStart)).toEqual(reduceAutoModeUsage({ ...input, rangeStart: actualStart }))
  expect(accumulated(input, true)).toEqual(reduceAutoModeUsage(input))
  expect(accumulator.finish(input.sources).buckets.map(bucket => bucket.date)).toEqual(['2020-01-01', '2026-09-10'])

  const capable = createAutoModeUsageAccumulator(input)
  capable.addSource(recent)
  const sources = [{ ...source, supportedFrom: '2026-09-10T00:00:00.000Z' }]
  expect(capable.finish(sources).allTools.coverage.state).toBe('partial')
  expect(capable.finish(sources, '2026-09-10T00:00:00.000Z').allTools.coverage.state).toBe('complete')
})

test('keeps last accepted source intervals and first accepted coverage states on metadata conflicts', () => {
  const input: AutoModeUsageReductionInput = {
    ...hundredAttemptAutoModeFixture(),
    records: [start('measured'), end('measured', 'allowed')],
    sources: [],
    timezone: 'UTC',
  }
  const accumulator = createAutoModeUsageAccumulator(input)
  accumulator.addSource(input.records)
  const laterCapability = { ...source, supportedFrom: '2026-09-10T18:00:00.000Z' }
  const earlierCapability = { ...source, supportedFrom: input.rangeStart }
  expect(accumulator.finish([laterCapability]).allTools.coverage.state).toBe('partial')
  const accepted = [laterCapability, earlierCapability, earlierCapability]
  expect(accumulator.finish(accepted)).toEqual(reduceAutoModeUsage({ ...input, sources: accepted }))
  expect(accumulator.finish(accepted).allTools.coverage.state).toBe('complete')
  const conflicting = [...accepted, { ...laterCapability, commands: 'partial' as const }]
  const summary = accumulator.finish(conflicting)
  expect(summary).toEqual(reduceAutoModeUsage({ ...input, sources: conflicting }))
  expect(summary.allTools.coverage).toEqual({ state: 'partial', invalidRecords: 1, orphanRecords: 0 })
  expect(summary.buckets[0]!.commands.coverage).toEqual({ state: 'partial', invalidRecords: 0, orphanRecords: 0 })
})

test('charges only newly retained global entries and propagates aggregate budget failures', () => {
  const charges: Array<readonly [number, number]> = []
  const input = {
    ...hundredAttemptAutoModeFixture(),
    records: [start('first'), end('first', 'policy_blocked', undefined, { primary_category: { kind: 'custom', id: 'category' } })],
    sources: [source],
    onRetain: (entries: number, bytes: number) => { charges.push([entries, bytes]) },
  }
  const accumulator = createAutoModeUsageAccumulator(input)
  accumulator.addSource(input.records)
  expect(charges).toHaveLength(4) // scope, day, route/outcome, exact category
  accumulator.addSource(input.records.map(record => ({ ...record, sourceScope: 'second' })))
  expect(charges).toHaveLength(5) // only the new scope; counts merge exactly
  expect(charges.every(([entries, bytes]) => entries === 1 && bytes >= 128)).toBe(true)
  expect(accumulator.finish([source, { ...source, sourceScope: 'second' }]).categories[0]!.count).toBe(2)
  expect(charges).toHaveLength(5)

  const guarded = createAutoModeUsageAccumulator({
    ...input,
    onRetain: () => { throw new Error('aggregate budget exceeded') },
  })
  expect(() => guarded.addSource(input.records)).toThrow('aggregate budget exceeded')
  expect(() => accumulator.addSource([start('mixed'), { ...end('mixed', 'allowed'), sourceScope: 'other' }]))
    .toThrow('one complete source')
  expect(() => accumulator.finish([source], 'not-a-date')).toThrow('Invalid auto-mode usage coverage range')
})
