import { expect, test } from 'bun:test'
import {
  createSidecarWorkspaceTrustDomain,
  type WorkspaceTrustExecutor,
} from './workspaceTrustDomain.js'

/**
 * A fake trust executor — proves the accept round-trip (persist → re-read)
 * without writing the real global config (§10, mirrors accountsDomain's fake).
 * `onPersist` controls whether the persist actually flips the trusted read.
 */
function fakeExecutor(
  initialTrusted: boolean,
  onPersist: (flip: () => void) => void = flip => flip(),
  trustRoot: string | null = '/repo',
): { executor: WorkspaceTrustExecutor; persistCalls: () => number } {
  let trusted = initialTrusted
  let persistCalls = 0
  return {
    executor: {
      isTrusted: () => trusted,
      persistTrust: () => {
        persistCalls++
        onPersist(() => {
          trusted = true
        })
      },
      getTrustRoot: () => trustRoot,
    },
    persistCalls: () => persistCalls,
  }
}

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

/* ── trust ROOT: the scope an accept actually writes at ────────────────────── */

test('the snapshot carries the trust ROOT, not the session cwd, when they differ', async () => {
  // The honesty gap: trust is keyed at `getProjectPathForConfig()` (the canonical
  // git root, `src/utils/config.ts:1626`), never the session cwd, so accepting for
  // one package silently trusts every sibling under the repo. The snapshot must
  // carry that root or the gate cannot name what approving does.
  const fake = fakeExecutor(false, flip => flip(), '/Users/me/monorepo')
  const domain = await createSidecarWorkspaceTrustDomain(
    '/Users/me/monorepo/packages/foo',
    { executor: fake.executor },
  )
  expect(domain.getSnapshot()?.trustRoot).toBe('/Users/me/monorepo')
})

test('the real executor resolves trustRoot through the engine function that KEYS the write', async () => {
  // `saveCurrentProjectConfig` keys its write at `getProjectPathForConfig()`
  // (`src/utils/config.ts:1675`); the domain reads the trust root through that
  // same call, so the displayed scope cannot drift from the stored scope.
  const { getProjectPathForConfig } = await import('../../src/utils/config.js')
  const domain = await createSidecarWorkspaceTrustDomain(process.cwd())
  expect(domain.getSnapshot()?.trustRoot).toBe(getProjectPathForConfig())
})

test('a failed trust-root read degrades to null and NEVER opens the gate (P4-25 fail-closed)', async () => {
  // Same independence rule as `detectedRepo`: the cosmetic/scope read may fail,
  // but `trusted` is computed separately and must stay false.
  const executor: WorkspaceTrustExecutor = {
    isTrusted: () => false,
    persistTrust: () => {},
    getTrustRoot: () => {
      throw new Error('git blew up')
    },
  }
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', { executor })
  const snapshot = domain.getSnapshot()
  expect(snapshot).not.toBeNull()
  expect(snapshot?.trustRoot).toBeNull()
  expect(snapshot?.trusted).toBe(false)
})

test('a failed trust-root read does not discard a known trusted:true fact', async () => {
  const executor: WorkspaceTrustExecutor = {
    isTrusted: () => true,
    persistTrust: () => {},
    getTrustRoot: () => {
      throw new Error('git blew up')
    },
  }
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', { executor })
  expect(domain.getSnapshot()?.trusted).toBe(true)
  expect(domain.getSnapshot()?.trustRoot).toBeNull()
})

test('acceptTrust re-broadcasts the SAME trust root the gate displayed', async () => {
  // The re-broadcast must not silently report a different scope than the one the
  // user approved.
  const fake = fakeExecutor(false, flip => flip(), '/Users/me/monorepo')
  const domain = await createSidecarWorkspaceTrustDomain(
    '/Users/me/monorepo/packages/foo',
    { executor: fake.executor },
  )
  domain.acceptTrust()
  expect(domain.getSnapshot()?.trusted).toBe(true)
  expect(domain.getSnapshot()?.trustRoot).toBe('/Users/me/monorepo')
})

test('acceptTrust persists, re-reads trusted:true, updates the snapshot, and reports changed', async () => {
  const fake = fakeExecutor(false)
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', {
    executor: fake.executor,
  })
  expect(domain.getSnapshot()?.trusted).toBe(false)

  const result = domain.acceptTrust()
  expect(result).toEqual({ ok: true, message: 'Workspace trusted.', changed: true })
  expect(fake.persistCalls()).toBe(1)
  // The stored snapshot now reflects the write (so the sidecar re-broadcasts it).
  expect(domain.getSnapshot()?.trusted).toBe(true)
})

test('acceptTrust is idempotent — already trusted returns ok+unchanged and never persists', async () => {
  const fake = fakeExecutor(true)
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', {
    executor: fake.executor,
  })
  const result = domain.acceptTrust()
  expect(result.ok).toBe(true)
  expect(result.changed).toBe(false)
  expect(fake.persistCalls()).toBe(0)
})

test('acceptTrust reports ok:false+unchanged when the write did not take effect', async () => {
  // persist runs but does NOT flip the trusted read — the domain re-reads the
  // real store and refuses to claim success.
  const fake = fakeExecutor(false, () => {
    /* swallow the flip */
  })
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', {
    executor: fake.executor,
  })
  const result = domain.acceptTrust()
  expect(result.ok).toBe(false)
  expect(result.changed).toBe(false)
  expect(domain.getSnapshot()?.trusted).toBe(false)
})

test('acceptTrust re-broadcasts (changed:true, no redundant write) when trust was persisted out-of-band after spawn', async () => {
  // N-process, same cwd: this session read trusted:false at spawn, then a
  // concurrent session persisted trust. Clicking Trust must still clear the
  // stale-false gate — so `changed` reflects the false→true flip, and no
  // redundant persist runs.
  let trusted = false
  let persistCalls = 0
  const executor: WorkspaceTrustExecutor = {
    isTrusted: () => trusted,
    persistTrust: () => {
      persistCalls++
      trusted = true
    },
    getTrustRoot: () => '/repo',
  }
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', { executor })
  expect(domain.getSnapshot()?.trusted).toBe(false)

  trusted = true // out-of-band trust between spawn and accept
  const result = domain.acceptTrust()
  // The stored snapshot was false (gate showing) → the accept clears it:
  // changed:true (re-broadcast), no redundant persist. Message keys off the
  // stored (false) state, consistently with `changed`.
  expect(result).toEqual({ ok: true, message: 'Workspace trusted.', changed: true })
  expect(persistCalls).toBe(0)
  expect(domain.getSnapshot()?.trusted).toBe(true)
})

test('acceptTrust is throw-free — a persist error degrades to ok:false', async () => {
  const executor: WorkspaceTrustExecutor = {
    isTrusted: () => false,
    persistTrust: () => {
      throw new Error('disk full')
    },
    getTrustRoot: () => '/repo',
  }
  const domain = await createSidecarWorkspaceTrustDomain('/tmp', { executor })
  const result = domain.acceptTrust()
  expect(result.ok).toBe(false)
  expect(result.changed).toBe(false)
  expect(result.message).toContain('disk full')
})
