import { expect, test } from 'bun:test'
import { parseWorkspaceTrustWorkerRequest, parseWorkspaceTrustWorkerResult } from './workspaceTrustWorker.js'

test('trust requests admit only inspect or accept with the main-owned expected root', () => {
  expect(parseWorkspaceTrustWorkerRequest({ type: 'workspace.inspect', version: 1 })).not.toBeNull()
  expect(parseWorkspaceTrustWorkerRequest({ type: 'workspace.trust', version: 1, expectedTrustRoot: '/repo' })).not.toBeNull()
  for (const value of [null, {}, { type: 'workspace.inspect', version: 1, cwd: '/other' }, { type: 'workspace.trust', version: 1 }, { type: 'workspace.trust', version: 1, expectedTrustRoot: '' }, { type: 'workspace.trust', version: 2, expectedTrustRoot: '/repo' }, { type: 'workspace.trust', version: 1, expectedTrustRoot: '/repo', cwd: '/other' }]) {
    expect(parseWorkspaceTrustWorkerRequest(value)).toBeNull()
  }
})

test('trust result is closed and bounded', () => {
  const result = { type: 'workspace-trust-result', version: 1, trustRoot: '/repo', trusted: true } as const
  expect(parseWorkspaceTrustWorkerResult(result)).toEqual(result)
  for (const value of [{ ...result, extra: true }, { ...result, trusted: 'true' }, { ...result, trustRoot: '' }, { ...result, trustRoot: 'a'.repeat(4097) }]) expect(parseWorkspaceTrustWorkerResult(value)).toBeNull()
})
