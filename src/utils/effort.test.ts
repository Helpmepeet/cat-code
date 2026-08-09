import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveAppliedEffort, resolveSubagentEffort } from './effort.js'

describe('resolveSubagentEffort', () => {
  test('applies the effort the caller selected for this spawn', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: 'low',
        agentDefinitionEffort: undefined,
        parentEffortValue: 'max',
      }),
    ).toBe('low')
  })

  test('outranks the agent definition pin', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: 'low',
        agentDefinitionEffort: 'max',
        parentEffortValue: 'medium',
      }),
    ).toBe('low')
  })

  test('falls back to the definition pin when no override is given', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: undefined,
        agentDefinitionEffort: 'max',
        parentEffortValue: 'medium',
      }),
    ).toBe('max')
  })

  test('inherits the parent effort when neither is set', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: undefined,
        agentDefinitionEffort: undefined,
        parentEffortValue: 'medium',
      }),
    ).toBe('medium')
  })

  test('keeps a numeric definition pin intact when no override is given', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: undefined,
        agentDefinitionEffort: 8_000,
        parentEffortValue: 'medium',
      }),
    ).toBe(8_000)
  })

  // Effort is part of the billing prompt cache key, so a fork that exists to
  // reuse the parent's cached prefix must keep the parent's effort.
  test('drops the override on cache-identical runs', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: 'low',
        agentDefinitionEffort: undefined,
        parentEffortValue: 'medium',
        cacheIdenticalRun: true,
      }),
    ).toBe('medium')
  })

  test('leaves the definition pin alone on cache-identical runs', () => {
    expect(
      resolveSubagentEffort({
        requestedEffort: 'low',
        agentDefinitionEffort: 'max',
        parentEffortValue: 'medium',
        cacheIdenticalRun: true,
      }),
    ).toBe('max')
  })
})

describe('resolveSubagentEffort feeding resolveAppliedEffort', () => {
  // resolveAppliedEffort consults CLAUDE_CODE_EFFORT_LEVEL first, which would
  // mask the clamp being asserted here if the ambient env happens to set it.
  const priorEnvOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  })
  afterEach(() => {
    if (priorEnvOverride === undefined) {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    } else {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = priorEnvOverride
    }
  })

  // The override is not clamped at spawn time; the per-request clamp against
  // the subagent's own model is what handles a cross-model mismatch.
  test('clamps an override the subagent model cannot serve', () => {
    const resolved = resolveSubagentEffort({
      requestedEffort: 'ultra',
      agentDefinitionEffort: undefined,
      parentEffortValue: undefined,
    })
    expect(resolved).toBe('ultra')
    expect(resolveAppliedEffort('claude-sonnet-4-6', resolved)).toBe('high')
  })

  test('passes an override the subagent model supports through unchanged', () => {
    const resolved = resolveSubagentEffort({
      requestedEffort: 'low',
      agentDefinitionEffort: undefined,
      parentEffortValue: 'max',
    })
    expect(resolveAppliedEffort('claude-sonnet-4-6', resolved)).toBe('low')
  })
})
