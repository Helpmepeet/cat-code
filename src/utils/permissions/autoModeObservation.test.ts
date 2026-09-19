import { expect, test } from 'bun:test'
import {
  MAX_AUTO_MODE_OBSERVATION_ID_BYTES,
  createAutoModePermissionObservationContext,
  createAutoModePermissionObserver,
  mapAutoModeDisposition,
  parseAutoModeObservationEvent,
  resolveInitialPermissionOccurrence,
} from './autoModeObservation.js'

const start = {
  subtype: 'auto_permission_start',
  schema_version: 1,
  attempt_id: 'attempt-1',
  tool_use_id: 'tool-1',
  tool_kind: 'bash',
  auto_mode: 'auto',
  initial: true,
}

test('accepts bounded metadata-only auto-mode observation records', () => {
  expect(parseAutoModeObservationEvent(start)).toEqual(start)
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_stage',
      schema_version: 1,
      attempt_id: 'attempt-1',
      stage: 'fast',
      phase: 'resolved',
      should_block: false,
    }),
  ).not.toBeNull()
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_end',
      schema_version: 1,
      attempt_id: 'attempt-1',
      raw_result: 'deny',
      disposition: 'policy_blocked',
      route: 'stage2',
      primary_category: { kind: 'built_in', id: 'filesystem' },
    }),
  ).not.toBeNull()
})

test('rejects unknown kinds, invalid enums, and conflicting stage resolutions', () => {
  expect(parseAutoModeObservationEvent({ ...start, subtype: 'unknown' })).toBeNull()
  expect(parseAutoModeObservationEvent({ ...start, tool_kind: 'shell' })).toBeNull()
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_stage',
      schema_version: 1,
      attempt_id: 'attempt-1',
      stage: 'fast',
      phase: 'resolved',
      should_block: true,
      failure: 'unavailable',
    }),
  ).toBeNull()
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_stage',
      schema_version: 1,
      attempt_id: 'attempt-1',
      stage: 'fast',
      phase: 'resolved',
    }),
  ).toBeNull()
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_end',
      schema_version: 1,
      attempt_id: 'attempt-1',
      raw_result: 'deny',
      disposition: 'allowed',
      route: 'base',
    }),
  ).toBeNull()
})

test('rejects oversized identifiers, unsafe category labels, and writer envelope fields', () => {
  expect(
    parseAutoModeObservationEvent({
      ...start,
      attempt_id: 'a'.repeat(MAX_AUTO_MODE_OBSERVATION_ID_BYTES + 1),
    }),
  ).toBeNull()
  expect(
    parseAutoModeObservationEvent({
      subtype: 'auto_permission_end',
      schema_version: 1,
      attempt_id: 'attempt-1',
      raw_result: 'deny',
      disposition: 'policy_blocked',
      route: 'stage2',
      primary_category: { kind: 'custom', id: 'untrusted label' },
    }),
  ).toBeNull()
  expect(
    parseAutoModeObservationEvent({ ...start, timestamp: '2026-09-18T00:00:00.000Z' }),
  ).toBeNull()
})

test('maps initial permission results from structured evidence without mutation', () => {
  const cases = [
    ['allow', {}, { disposition: 'allowed' }],
    ['ask', { policy: 'classifier_policy' }, { disposition: 'review_required' }],
    ['deny', { failure: 'unavailable' }, { disposition: 'operational_error', cause: 'unavailable' }],
    ['deny', { failure: 'invalid_response' }, { disposition: 'operational_error', cause: 'invalid_response' }],
    ['deny', { failure: 'context_limit' }, { disposition: 'operational_error', cause: 'context_limit' }],
    ['deny', { failure: 'internal_error' }, { disposition: 'operational_error', cause: 'internal_error' }],
    ['deny', { failure: 'interrupted' }, { disposition: 'cancelled', cause: 'interrupted' }],
    ['deny', { policy: 'base_rule' }, { disposition: 'policy_blocked' }],
    ['deny', { policy: 'safety_policy' }, { disposition: 'policy_blocked' }],
    ['deny', { policy: 'classifier_policy' }, { disposition: 'policy_blocked' }],
    ['deny', {}, { disposition: 'unknown_outcome' }],
    ['throw', { failure: 'context_limit' }, { disposition: 'operational_error', cause: 'context_limit' }],
    ['throw', { failure: 'unavailable' }, { disposition: 'operational_error', cause: 'unavailable' }],
    ['throw', { failure: 'interrupted' }, { disposition: 'cancelled', cause: 'interrupted' }],
    ['throw', {}, { disposition: 'unknown_outcome' }],
  ] as const

  for (const [result, evidence, expected] of cases) {
    const frozenEvidence = Object.freeze({ ...evidence })
    expect(mapAutoModeDisposition(result, frozenEvidence)).toEqual(expected)
    expect(frozenEvidence).toEqual(evidence)
  }
})

test('preserves review-required when a Stage 2 block or unavailable classifier hands off', () => {
  expect(
    mapAutoModeDisposition('ask', { policy: 'classifier_policy' }),
  ).toEqual({ disposition: 'review_required' })
  expect(
    mapAutoModeDisposition('ask', { failure: 'unavailable' }),
  ).toEqual({ disposition: 'review_required', cause: 'unavailable' })
})

test('keeps context-limit evidence when a later abort is observed', () => {
  const events: unknown[] = []
  const observation = createAutoModePermissionObservationContext({
    writer: event => events.push(event),
    toolUseId: 'tool-1',
    toolKind: 'bash',
    effectiveAutoMode: 'auto',
    createAttemptId: () => 'attempt-1',
  })

  observation?.markFailure('context_limit')
  observation?.markFailure('interrupted')
  observation?.observer.finish(observation.finishError())

  expect(events.at(-1)).toMatchObject({
    subtype: 'auto_permission_end',
    disposition: 'operational_error',
    cause: 'context_limit',
  })
})

test('records one initial occurrence and only its first finish', () => {
  const events: unknown[] = []
  expect(
    createAutoModePermissionObserver({
      writer: event => events.push(event),
      toolUseId: 'tool-1',
      toolKind: 'bash',
      effectiveAutoMode: null,
      createAttemptId: () => 'unused-attempt',
    }),
  ).toBeNull()
  expect(events).toEqual([])

  const observer = createAutoModePermissionObserver({
    writer: event => events.push(event),
    toolUseId: 'tool-1',
    toolKind: 'bash',
    effectiveAutoMode: 'auto',
    createAttemptId: () => 'attempt-1',
  })

  observer?.enterStage('fast')
  // A provider fallback remains one stage, even if it needed internal retries.
  observer?.resolveStage('fast', { should_block: false })
  observer?.finish({
    raw_result: 'allow',
    route: 'stage1',
  })
  observer?.finish({
    raw_result: 'deny',
    route: 'stage2',
    evidence: { policy: 'classifier_policy' },
  })

  expect(events).toEqual([
    start,
    {
      subtype: 'auto_permission_stage',
      schema_version: 1,
      attempt_id: 'attempt-1',
      stage: 'fast',
      phase: 'entered',
    },
    {
      subtype: 'auto_permission_stage',
      schema_version: 1,
      attempt_id: 'attempt-1',
      stage: 'fast',
      phase: 'resolved',
      should_block: false,
    },
    {
      subtype: 'auto_permission_end',
      schema_version: 1,
      attempt_id: 'attempt-1',
      raw_result: 'allow',
      disposition: 'allowed',
      route: 'stage1',
    },
  ])
})

test('uses no observer for rechecks and creates a fresh attempt per occurrence', async () => {
  const events: unknown[] = []
  const attemptIds = ['attempt-1', 'attempt-2']
  const createObserver = () =>
    createAutoModePermissionObserver({
      writer: event => events.push(event),
      toolUseId: 'tool-1',
      toolKind: 'bash',
      effectiveAutoMode: 'plan_auto',
      createAttemptId: () => attemptIds.shift()!,
    })

  const initial = createObserver()
  const initialDecision = { behavior: 'allow' }
  expect(
    await resolveInitialPermissionOccurrence({
      observer: initial,
      forceDecision: initialDecision,
      getPermissionResult: async () => {
        throw new Error('forced decisions do not call the checker')
      },
      finishResult: () => ({ raw_result: 'allow', route: 'forced' }),
      finishError: () => ({ raw_result: 'throw', route: 'forced' }),
    }),
  ).toBe(initialDecision)

  const recheckDecision = { behavior: 'ask' }
  expect(
    await resolveInitialPermissionOccurrence({
      observer: null,
      getPermissionResult: async () => recheckDecision,
      finishResult: () => {
        throw new Error('rechecks do not map an observation')
      },
      finishError: () => {
        throw new Error('rechecks do not map an observation')
      },
    }),
  ).toBe(recheckDecision)

  const nextOccurrence = createObserver()
  nextOccurrence?.finish({ raw_result: 'ask', route: 'unknown' })

  expect(events.filter(event => (event as { subtype: string }).subtype === 'auto_permission_start')).toEqual([
    {
      ...start,
      attempt_id: 'attempt-1',
      auto_mode: 'plan_auto',
    },
    {
      ...start,
      attempt_id: 'attempt-2',
      auto_mode: 'plan_auto',
    },
  ])
})

test('records a forced deny without calling the checker', async () => {
  const events: unknown[] = []
  const observer = createAutoModePermissionObserver({
    writer: event => events.push(event),
    toolUseId: 'tool-1',
    toolKind: 'bash',
    effectiveAutoMode: 'auto',
    createAttemptId: () => 'attempt-1',
  })
  const decision = { behavior: 'deny' }

  await expect(
    resolveInitialPermissionOccurrence({
      observer,
      forceDecision: decision,
      getPermissionResult: async () => {
        throw new Error('forced decisions do not call the checker')
      },
      finishResult: result => {
        expect(result).toBe(decision)
        return { raw_result: 'deny', route: 'forced' }
      },
      finishError: () => ({ raw_result: 'throw', route: 'forced' }),
    }),
  ).resolves.toBe(decision)
  expect(events.at(-1)).toMatchObject({
    subtype: 'auto_permission_end',
    raw_result: 'deny',
    route: 'forced',
  })
})

test('preserves the original thrown error identity', async () => {
  const events: unknown[] = []
  const observer = createAutoModePermissionObserver({
    writer: event => events.push(event),
    toolUseId: 'tool-1',
    toolKind: 'other',
    effectiveAutoMode: 'auto',
    createAttemptId: () => 'attempt-1',
  })
  const failure = new Error('existing permission failure')

  await expect(
    resolveInitialPermissionOccurrence({
      observer,
      getPermissionResult: async () => {
        throw failure
      },
      finishResult: () => ({ raw_result: 'allow', route: 'unknown' }),
      finishError: error => {
        expect(error).toBe(failure)
        return {
          raw_result: 'throw',
          route: 'unknown',
          evidence: { failure: 'internal_error' },
        }
      },
    }),
  ).rejects.toBe(failure)
  expect(events.at(-1)).toMatchObject({
    subtype: 'auto_permission_end',
    raw_result: 'throw',
    disposition: 'operational_error',
  })
})
