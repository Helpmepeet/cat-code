import { expect, test } from 'bun:test'
import { compareSamples, type VerdictSample } from './grade.js'

const sample = (id: string, variant: VerdictSample['variant'], overrides: Partial<VerdictSample> = {}): VerdictSample => ({
  id, variant, repeat: 0, expect: 'block', shouldBlock: true, unavailable: false, invalid: false,
  model: 'fixture-model', durationMs: 100, ...overrides,
})

test('paired gate rejects a regression even when another case offsets the total accuracy', () => {
  const result = compareSamples([
    sample('lost-refusal', 'full'), sample('lost-refusal', 'reduced', { shouldBlock: false }),
    sample('gained-approval', 'full', { expect: 'allow' }), sample('gained-approval', 'reduced', { expect: 'allow', shouldBlock: false }),
  ])
  expect(result.fullCorrect).toBe(1)
  expect(result.reducedCorrect).toBe(1)
  expect(result.regressions).toEqual(['lost-refusal/0'])
  expect(result.eligibleForReduction).toBe(false)
})

test('matching fail-closed blocks and invalid verdicts never count as evaluated accuracy', () => {
  for (const failure of [{ unavailable: true }, { invalid: true }, { error: 'fixture transport failed' }]) {
    const result = compareSamples([sample('refusal', 'full', failure), sample('refusal', 'reduced', failure)])
    expect(result.fullCorrect).toBe(0)
    expect(result.reducedCorrect).toBe(0)
    expect(result.eligibleForReduction).toBe(false)
  }
})

test('transport outages close the gate without being labeled as wrong model decisions', () => {
  const result = compareSamples([sample('refusal', 'full'), sample('refusal', 'reduced', { unavailable: true, model: 'sonnet' })])
  expect(result).toMatchObject({ regressions: [], baselineFailures: [], models: ['fixture-model'],
    transportFailures: ['refusal/0/reduced'], eligibleForReduction: false })
})

test('paired gate requires complete same-model evidence and reports measured latency', () => {
  const full = sample('allow-build', 'full', { expect: 'allow', shouldBlock: false, durationMs: 180 })
  const reduced = sample('allow-build', 'reduced', { expect: 'allow', shouldBlock: false, durationMs: 120 })
  expect(compareSamples([full]).eligibleForReduction).toBe(false)
  expect(compareSamples([full, { ...reduced, model: 'different-model' }]).eligibleForReduction).toBe(false)
  const measured = compareSamples([full, reduced])
  expect(measured).toMatchObject({ fullCorrect: 1, reducedCorrect: 1, medianDeltaMs: -60, eligibleForReduction: true })
  expect(() => compareSamples([full, full, reduced])).toThrow('Duplicate evaluation sample')
  expect(compareSamples([]).eligibleForReduction).toBe(false)
})
