import { expect, test } from 'bun:test'
import { createSidecarWorkspaceTrustDomain } from './workspaceTrustDomain.js'

test('the domain reads once at spawn — getSnapshot returns a stable reference', async () => {
  // Real read against this repo's own cwd: trust/repo state varies by machine,
  // so this only proves the read-at-spawn discipline (settingsDomain.test.ts's
  // "stable reference" contract), not a specific trusted/repo value.
  const domain = await createSidecarWorkspaceTrustDomain(process.cwd())
  const first = domain.getSnapshot()
  const second = domain.getSnapshot()
  expect(first).toBe(second)
})

test('a real cwd produces a boolean trusted flag and a repo string or null', async () => {
  const domain = await createSidecarWorkspaceTrustDomain(process.cwd())
  const snapshot = domain.getSnapshot()
  expect(snapshot).not.toBeNull()
  expect(typeof snapshot?.trusted).toBe('boolean')
  expect(
    snapshot?.detectedRepo === null || typeof snapshot?.detectedRepo === 'string',
  ).toBe(true)
})

test('a directory outside the config.projects trust store reports trusted:false', async () => {
  // isPathTrusted(dir) is EXPLICIT-dir (config.ts:790), unlike git remote
  // detection which reads the sidecar's own process cwd (P3-1) — /tmp exercises
  // the explicit-dir half without depending on this test runner's own repo state.
  const domain = await createSidecarWorkspaceTrustDomain('/tmp')
  const snapshot = domain.getSnapshot()
  expect(snapshot?.trusted).toBe(false)
})
