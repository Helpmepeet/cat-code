import { expect, test } from 'bun:test'
import {
  MAX_AUTO_MODE_OBSERVATION_ID_BYTES,
  mapAutoModeDisposition,
  parseAutoModeObservationEvent,
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
