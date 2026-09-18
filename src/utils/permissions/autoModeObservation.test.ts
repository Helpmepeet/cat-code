import { expect, test } from 'bun:test'
import {
  MAX_AUTO_MODE_OBSERVATION_ID_BYTES,
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
