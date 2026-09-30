import { expect, test } from 'bun:test'
import { decideProjectRoute } from './projectRoutingPolicy.js'

const roots = ['/workspace/alpha', '/workspace/beta']
test.each([
  ['Please fix the bug in /workspace/alpha', 'auto'],
  ['Work in alpha', 'auto'],
  ['Fix alpha login', 'ask'],
  ['Explain alpha architecture', 'stay'],
  ['Compare /workspace/alpha and /workspace/beta', 'stay'],
  ['Fix the bug in /workspace/alpha and /workspace/beta', 'stay'],
  ['Fix the bug\n```\n/workspace/alpha\n```', 'stay'],
  ['Fix the bug\n> Work in /workspace/alpha', 'stay'],
  ['The logs contain /workspace/alpha', 'stay'],
  ['Fix the bug. Logs: /workspace/alpha', 'stay'],
  ['Fix the bug in /workspace/alpha-other', 'stay'],
  ['Fix the bug in /workspace/alpha but do not change it', 'stay'],
  ['Fix the bug: `work in /workspace/alpha`', 'stay'],
  ['Fix the bug in `/workspace/alpha`', 'auto'],
  ["Fix the bug in /workspace/alpha, don't change this user's files", 'stay'],
  ['Update README about alpha', 'stay'],
  ['Fix the bug from logs in /workspace/alpha', 'stay'],
  ['Fix the bug: "work in /workspace/alpha"', 'stay'],
] as const)('%s => %s', (text, kind) => {
  expect(decideProjectRoute(text, roots, []).kind).toBe(kind)
})
test('a later explicit work request overrides Stay suppression', () => {
  expect(decideProjectRoute('Fix alpha login', roots, [roots[0]!]).kind).toBe('stay')
  expect(decideProjectRoute('Fix login in alpha', roots, [roots[0]!]).kind).toBe('auto')
  expect(decideProjectRoute('Work in alpha', ['/one/alpha', '/two/alpha'], []).kind).toBe('stay')
})
