/**
 * F6 — outbound secret-key guard (SECURITY-MINIMUM §4 "No token field crosses
 * IPC"). `scanForSecrets` is the serializer-level assertion that a token key
 * never leaves the sidecar. It is DISTINCT from the JSON-safe check: a
 * `{accessToken:"..."}` object is structurally valid JSON, so it must be caught
 * here, not there.
 */

import { expect, test } from 'bun:test'

import { scanForSecrets } from './secretGuard.js'

test('accepts a secret-free payload', () => {
  const r = scanForSecrets({ type: 'message', message: { content: 'hi' }, nested: [1, 2, { ok: true }] })
  expect(r.ok).toBe(true)
})

test.each([
  'accessToken',
  'refreshToken',
  'apiKey',
  'apiKeys',
  'vaultFilePath',
  'idToken',
  'clientSecret',
  'privateKey',
  'password',
  'authorization',
])('rejects a top-level %s key', key => {
  const r = scanForSecrets({ [key]: 'sk-secret' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toBe(key)
})

test('rejects a secret nested inside the payload and reports its path', () => {
  const r = scanForSecrets({ account: { profile: { accessToken: 'sk-secret' } } })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.key).toBe('accessToken')
    expect(r.path).toBe('$.account.profile.accessToken')
  }
})

test('rejects a secret inside an array element', () => {
  const r = scanForSecrets({ accounts: [{ name: 'a' }, { apiKey: 'sk-2' }] })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.path).toBe('$.accounts[1].apiKey')
})

test('matches the secret key case-insensitively (AccessToken, ACCESSTOKEN)', () => {
  expect(scanForSecrets({ AccessToken: 'x' }).ok).toBe(false)
  expect(scanForSecrets({ ACCESSTOKEN: 'x' }).ok).toBe(false)
})

test('tolerates a cyclic reference without looping', () => {
  const a: Record<string, unknown> = { safe: 1 }
  a.self = a
  expect(scanForSecrets(a).ok).toBe(true)
})

test.each([
  'access_token',
  'access-token',
  'refresh_token',
  'api_key',
  'vault_file_path',
  'id_token',
  'client_secret',
  'private_key',
])('matches snake_case / kebab-case spelling %s (normalized key match)', key => {
  const r = scanForSecrets({ [key]: 'sk-secret' })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toBe(key)
})

test('rejects a secret hidden deep (does NOT fail open at a depth limit)', () => {
  // Regression: the guard previously returned ok:true past depth 64, leaking a
  // secret nested below the cutoff. Build a chain well past the old limit.
  let deep: Record<string, unknown> = { accessToken: 'sk-deep-leak' }
  for (let i = 0; i < 120; i++) deep = { wrap: deep }
  const r = scanForSecrets(deep)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toBe('accessToken')
})

test('fails CLOSED on a value nested past the scannable depth', () => {
  // A payload too deep to fully scan is rejected, not waved through — a secret
  // could otherwise hide below the cutoff.
  let deep: Record<string, unknown> = { safe: 1 }
  for (let i = 0; i < 300; i++) deep = { wrap: deep }
  const r = scanForSecrets(deep)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toContain('max depth')
})

test('an origin-bearing user frame is secretGuard-clean; a raw channel `meta` would NOT be', () => {
  // The narrowing that protects this frame is engine-side (`toSDKMessageOrigin`,
  // src/utils/messages/mappers.ts): the projection carries `server`/`user` but
  // never the channel's `meta` map, whose KEYS are authored by a third-party MCP
  // channel server. This asserts BOTH halves — that what we ship passes, and
  // that forwarding the raw origin would have cost the whole frame.
  const shipped = {
    kind: 'event',
    event: {
      type: 'message',
      message: {
        type: 'user',
        message: { role: 'user', content: 'can you look at the deploy failure?' },
        origin: { kind: 'channel', server: 'slack', user: 'dana' },
      },
    },
  }
  expect(scanForSecrets(shipped).ok).toBe(true)

  const rawUnnarrowed = {
    kind: 'event',
    event: {
      type: 'message',
      message: {
        type: 'user',
        origin: {
          kind: 'channel',
          server: 'slack',
          meta: { authorization: 'Bearer hunter2' },
        },
      },
    },
  }
  const r = scanForSecrets(rawUnnarrowed)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toBe('authorization')
})

test('a task-notification origin carries no free-text result to scan', () => {
  // `MessageOrigin`'s task-notification variant carries `result`/`usage`; the
  // projection keeps only status + summary, so the frame does not double the
  // banner text it already carries.
  const projected = {
    kind: 'task-notification',
    status: 'completed',
    summary: 'done',
  }
  expect(scanForSecrets(projected).ok).toBe(true)
  expect(Object.keys(projected).sort()).toEqual(['kind', 'status', 'summary'])
})
