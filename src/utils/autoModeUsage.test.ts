import { expect, test } from 'bun:test'
import {
  autoModeCommandRate,
  classifyHistoricalAutoModeToolResult,
  projectAutoModeDiagnosticPayload,
  reduceAutoModeUsage,
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
  return reduceAutoModeUsage({
    records,
    sources,
    rangeStart: '2026-09-10T00:00:00.000Z',
    rangeEnd: '2026-09-10T23:59:59.999Z',
    cutoff: '2026-09-11T00:00:00.000Z',
  })
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

test('reconciles the deterministic 100-attempt fixture and command-only rate', () => {
  const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture())

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
  expect(autoModeCommandRate(summary)).toEqual({
    numerator: 4,
    denominator: 40,
    rate: 0.1,
    state: 'confirmed',
  })
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

test('suppresses the primary command rate for mixed source coverage', () => {
  const summary = reduce(
    [start('covered'), end('covered', 'policy_blocked')],
    [
      source,
      { sourceScope: 'unsupported-source', allTools: 'unavailable', commands: 'unavailable' },
    ],
  )

  expect(summary.commands.outcomes.policy_blocked).toBe(1)
  expect(summary.commands.coverage.state).toBe('partial')
  expect(autoModeCommandRate(summary)).toMatchObject({ numerator: 1, denominator: 1, rate: null, state: 'unavailable' })
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
  })

  expect(autoModeCommandRate(summary)).toEqual({
    numerator: 2,
    denominator: 100,
    rate: 0.02,
    state: 'confirmed',
  })
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

test('attributes a later eligible terminal to its start UTC bucket and ignores post-cutoff records', () => {
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
