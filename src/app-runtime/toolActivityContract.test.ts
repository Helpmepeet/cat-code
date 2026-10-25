import { expect, test } from 'bun:test'
import { isToolActivity } from './toolActivityContract.js'

test('activity v1 admits bounded phase and output facts and rejects malformed or extra input', () => {
  const review = { type: 'tool.activity', toolUseId: 'command', phase: 'reviewing', startedAt: 10000 }
  const execution = { ...review, phase: 'executing', output: 'raw output', totalLines: 100, timeoutMs: 120000 }
  expect(isToolActivity(review)).toBe(true)
  expect(isToolActivity(execution)).toBe(true)
  for (const invalid of [
    null, [], { ...review, toolUseId: '' }, { ...review, phase: 'running' }, { ...review, startedAt: -1 },
    { ...review, startedAt: Infinity }, { ...review, output: '' }, { ...execution, output: '😺'.repeat(1000) },
    { ...execution, totalLines: 0.5 }, { ...execution, timeoutMs: '120000' }, { ...review, extra: 'injected' },
  ]) expect(isToolActivity(invalid)).toBe(false)
})
