import type { AutoModeUsageReductionInput, RetainedAutoModeRecord } from './autoModeUsage.js'
import type { AutoModeDisposition } from './permissions/autoModeObservation.js'

const scope = 'fixture-source'
const start = '2026-09-10T00:00:00.000Z'
const end = '2026-09-10T23:59:59.999Z'

function record(
  recordId: string,
  observedAt: string,
  payload: Record<string, unknown>,
): RetainedAutoModeRecord {
  return {
    sourceScope: scope,
    recordId,
    observedAt,
    diagnosticKind: 'auto_mode_observation',
    payload,
  }
}

function attempt(
  id: string,
  index: number,
  disposition: AutoModeDisposition,
  command: boolean,
  route: 'base' | 'stage1' | 'stage2',
): RetainedAutoModeRecord[] {
  const observedAt = `2026-09-10T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`
  const toolKind = command ? 'bash' : 'other'
  const records = [
    record(`start-${id}`, observedAt, {
      schema_version: 1,
      subtype: 'auto_permission_start',
      attempt_id: id,
      tool_use_id: `tool-${id}`,
      tool_kind: toolKind,
      auto_mode: 'auto',
      initial: true,
    }),
  ]
  if (route !== 'base') {
    records.push(record(`fast-entered-${id}`, observedAt, {
      schema_version: 1,
      subtype: 'auto_permission_stage',
      attempt_id: id,
      stage: 'fast',
      phase: 'entered',
    }))
    records.push(record(`fast-resolved-${id}`, observedAt, {
      schema_version: 1,
      subtype: 'auto_permission_stage',
      attempt_id: id,
      stage: 'fast',
      phase: 'resolved',
      should_block: route === 'stage2',
    }))
  }
  if (route === 'stage2') {
    records.push(record(`thinking-entered-${id}`, observedAt, {
      schema_version: 1,
      subtype: 'auto_permission_stage',
      attempt_id: id,
      stage: 'thinking',
      phase: 'entered',
    }))
    records.push(record(`thinking-resolved-${id}`, observedAt, {
      schema_version: 1,
      subtype: 'auto_permission_stage',
      attempt_id: id,
      stage: 'thinking',
      phase: 'resolved',
      should_block: disposition === 'policy_blocked',
    }))
  }
  records.push(record(`end-${id}`, observedAt, {
    schema_version: 1,
    subtype: 'auto_permission_end',
    attempt_id: id,
    raw_result: disposition === 'allowed' ? 'allow' : disposition === 'review_required' ? 'ask' : 'deny',
    disposition,
    route,
    ...(disposition === 'policy_blocked'
      ? { primary_category: { kind: 'built_in', id: `category-${index % 3}` } }
      : {}),
  }))
  return records
}

export function hundredAttemptAutoModeFixture(): AutoModeUsageReductionInput {
  const definitions: Array<readonly [AutoModeDisposition, boolean, 'base' | 'stage1' | 'stage2']> = [
    ...Array.from({ length: 50 }, (_, index) => ['allowed', index < 13, 'base'] as const),
    ...Array.from({ length: 5 }, (_, index) => ['policy_blocked', index < 2, 'base'] as const),
    ...Array.from({ length: 3 }, () => ['review_required', false, 'base'] as const),
    ...Array.from({ length: 2 }, () => ['operational_error', false, 'base'] as const),
    ...Array.from({ length: 20 }, (_, index) => ['allowed', index < 10, 'stage1'] as const),
    ...Array.from({ length: 12 }, (_, index) => ['allowed', index < 10, 'stage1'] as const),
    ['operational_error', false, 'stage1'],
    ...Array.from({ length: 3 }, () => ['allowed', true, 'stage2'] as const),
    ...Array.from({ length: 2 }, () => ['policy_blocked', true, 'stage2'] as const),
    ['review_required', false, 'stage2'],
    ['operational_error', false, 'stage2'],
  ]
  return {
    records: definitions.flatMap(([disposition, command, route], index) =>
      attempt(`attempt-${index + 1}`, index, disposition, command, route)),
    sources: [{ sourceScope: scope, allTools: 'complete', commands: 'complete' }],
    rangeStart: start,
    rangeEnd: end,
    cutoff: '2026-09-11T00:00:00.000Z',
  }
}
