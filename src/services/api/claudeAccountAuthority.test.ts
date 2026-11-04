import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import * as authority from './claudeAccountAuthority.js'
import * as atomic from '../../utils/atomicFile.js'

let root: string
const id = 'synthetic-account'
const credentials = { accessToken: 'first', refreshToken: 'refresh-first', expiresAt: 100 }
const profile = { account_uuid: id, email_address: 'synthetic@example.com' }
const path = () => join(root, 'authority-v1', `${id}.json`)
function legacy(generation = 0, vaultGeneration = generation, deleted = false) {
  mkdirSync(join(root, 'accounts'), { recursive: true })
  writeFileSync(join(root, 'accounts', `${id}.json`), JSON.stringify({ lifecycle_generation: vaultGeneration,
    tokens: { access_token: 'old', refresh_token: 'refresh-old', expires_at: 100 }, profile }))
  writeFileSync(join(root, 'accounts', `${id}.json.lifecycle`), JSON.stringify({ generation, deleted }))
}
function spawnProbe(action: string, operationId?: string, token?: string) {
  return Bun.spawn({ cmd: [process.execPath, 'run', join(import.meta.dir, 'claudeAccountAuthority.probe.child.ts'), root, action, operationId ?? 'login', token ?? 'new'],
    env: { PATH: process.env.PATH ?? '', HOME: root, CLAUDE_CONFIG_DIR: join(root, 'config'), NODE_ENV: 'development' }, stdout: 'pipe', stderr: 'pipe' })
}
async function child(action: string, operationId?: string, token?: string) {
  const proc = spawnProbe(action, operationId, token)
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (exit !== 0) throw new Error(`child ${action} exited ${exit}: ${stderr}\n${stdout}`)
  const line = stdout.split('\n').find(line => line.startsWith('RESULT:'))
  if (!line) throw new Error(`Missing child result: ${stdout}; ${stderr}`)
  return JSON.parse(line.slice(7))
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'claude-authority-')); authority.setClaudeAuthorityVaultPathForTest(root) })
afterEach(() => { authority.setClaudeAuthorityVaultPathForTest(undefined); rmSync(root, { recursive: true, force: true }) })

test('fresh processes migrate and choose explicit login without expiry ordering', async () => {
  legacy()
  expect((await child('migrate')).status).toBe('ready')
  expect((await child('login', 'login-one', 'newer')).outcome).toBe('committed')
  const fresh = await child('read')
  expect(fresh.record.credentials.accessToken).toBe('newer')
  expect(fresh.handle).toEqual({ accountId: id, generation: 1, revision: 0 })
  expect((await child('login', 'login-one', 'newer')).handle.generation).toBe(1)
})
test('mismatched legacy pair never becomes a usable account', async () => {
  legacy(3, 4)
  expect((await child('migrate')).status).toBe('migration_conflict')
  expect((await child('read')).status).toBe('migration_conflict')
})
test('legacy tombstone wins over surviving credential file', async () => {
  legacy(4, 3, true)
  expect((await child('migrate')).status).toBe('deleted')
  expect((await child('read')).record.credentials).toBeUndefined()
})
test('interrupted migration repairs barrier then lifecycle fence across restart', async () => {
  legacy()
  const original = atomic.writeFileAtomicDurableSync
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target).endsWith('.lifecycle')) throw Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' })
    return original(target, data, options)
  })
  try { expect(() => authority.migrateClaudeAccountAuthority(id)).toThrow('synthetic disk failure') } finally { spy.mockRestore() }
  expect((await child('migrate')).status).toBe('ready')
  expect((await child('read')).record.credentials.accessToken).toBe('old')
})
test('staged login retries its allocated generation exactly once after restart', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const original = atomic.writeFileAtomicDurableSync
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target) === path() && JSON.parse(String(data)).loginGeneration === 1) throw new Error('synthetic disk failure')
    return original(target, data, options)
  })
  let pending
  try { pending = authority.commitClaudeLogin(id, 'deferred', credentials, profile) } finally { spy.mockRestore() }
  expect(pending).toMatchObject({ outcome: 'persistence_pending', restartRecoverable: true })
  expect((await child('retry', 'deferred')).handle.generation).toBe(1)
  expect((await child('retry', 'deferred')).handle.generation).toBe(1)
})
test('rejection survives observers and cannot reject a refreshed revision', async () => {
  await child('login', 'login-one', 'first')
  const old = authority.readClaudeAccountAuthority(id)
  if (!('handle' in old)) throw new Error('Missing handle')
  await child('refresh', 'refresh-one', 'second')
  expect(authority.rejectClaudeCredential(old.handle, 'late-rejection').outcome).toBe('rejected')
  expect((await child('read')).status).toBe('ready')
  await child('reject', 'reject-current')
  expect((await child('read')).status).toBe('rejected')
})
test('old operation receipt cannot resurrect a deleted or newer login', async () => {
  await child('login', 'login-one', 'first')
  await child('delete', 'delete-one')
  expect((await child('login', 'login-one', 'first')).outcome).toBe('rejected')
  expect((await child('read')).status).toBe('deleted')
})
test('detects incompatible legacy writer instead of importing credentials', async () => {
  await child('login')
  legacy(999)
  expect((await child('read')).status).toBe('incompatible_writer')
  expect((await child('migrate')).status).toBe('incompatible_writer')
})
test('fresh login retires overflow-conflicted generation and old operation replays across restart', async () => {
  await child('login', 'old-login', 'first')
  const old = authority.captureClaudeCredentialHandle(id, 'first')!
  const claim = authority.claimClaudeRefresh(old, 'old-refresh', 'owner').claim!
  authority.markClaudeRefreshDispatched(claim)
  legacy(Number.MAX_SAFE_INTEGER + 1)
  expect(authority.readClaudeAccountAuthority(id).status).toBe('incompatible_writer')
  expect(authority.commitClaudeLogin(id, 'old-login', credentials, profile).outcome).toBe('rejected')
  expect((await child('login', 'fresh-login', 'fresh')).outcome).toBe('committed')
  const fresh = await child('read')
  expect(fresh.status).toBe('ready')
  expect(fresh.record.credentials.accessToken).toBe('fresh')
  expect(fresh.handle.generation).toBe(old.generation + 2)
  expect(authority.isClaudeCredentialReady(old)).toBe(false)
  expect(authority.completeClaudeRefresh(claim, credentials).outcome).toBe('rejected')
  expect((await child('login', 'old-login', 'first')).outcome).toBe('rejected')
  expect((await child('login', 'fresh-login', 'fresh')).handle).toEqual(fresh.handle)
})
for (const failure of ['reservation', 'reservation-after-rename', 'legacy', 'lifecycle', 'publication']) {
  test(`recovery retries ${failure} failure without an old-token ready window`, async () => {
    await child('login', 'old-login', 'first')
    const freshCredentials = { ...credentials, accessToken: 'fresh', refreshToken: 'refresh-fresh' }
    const old = authority.captureClaudeCredentialHandle(id, 'first')!
    legacy(Number.MAX_SAFE_INTEGER + 1)
    const original = atomic.writeFileAtomicDurableSync
    let failed = false
    const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
      const record = String(target) === path() ? JSON.parse(String(data)) : undefined
      const hit = !failed && (
        ((failure === 'reservation' || failure === 'reservation-after-rename') && record?.pendingLogin?.repairBarriers) ||
        (failure === 'legacy' && String(target).endsWith(`/accounts/${id}.json`)) ||
        (failure === 'lifecycle' && String(target).endsWith('.lifecycle')) ||
        (failure === 'publication' && record?.state === 'active'))
      if (hit) {
        failed = true
        if (failure === 'reservation-after-rename') original(target, data, options)
        throw new Error('synthetic recovery failure')
      }
      const out = original(target, data, options)
      expect(authority.isClaudeCredentialReady(old)).toBe(false)
      return out
    })
    try {
      expect(authority.commitClaudeLogin(id, 'recovery', freshCredentials, profile).outcome).toBe('persistence_pending')
      expect(failed).toBe(true)
    } finally { spy.mockRestore() }
    expect(authority.isClaudeCredentialReady(old)).toBe(false)
    // An old writer may overwrite the barriers again before the retry.
    if (failure !== 'reservation') legacy(Number.MAX_SAFE_INTEGER + 1)
    expect((await child('login', 'recovery', 'fresh')).outcome).toBe('committed')
    expect((await child('read')).record.credentials.accessToken).toBe('fresh')
    expect(authority.isClaudeCredentialReady(old)).toBe(false)
  })
}
test('interrupted recovery fences competing payloads and old refresh until its reservation finishes', async () => {
  await child('login', 'old-login', 'first')
  const freshCredentials = { ...credentials, accessToken: 'fresh', refreshToken: 'refresh-fresh' }
  const old = authority.captureClaudeCredentialHandle(id, 'first')!
  const claim = authority.claimClaudeRefresh(old, 'refresh-race', 'owner').claim!
  authority.markClaudeRefreshDispatched(claim)
  legacy(Number.MAX_SAFE_INTEGER + 1)
  const original = atomic.writeFileAtomicDurableSync
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target).endsWith('.lifecycle')) throw new Error('synthetic fence failure')
    return original(target, data, options)
  })
  try {
    expect(authority.commitClaudeLogin(id, 'interrupted', freshCredentials, profile).outcome).toBe('persistence_pending')
  } finally { spy.mockRestore() }
  expect(authority.retryClaudeAuthorityPersistence(id, 'old-login').outcome).toBe('rejected')
  expect(authority.completeClaudeRefresh(claim, credentials).outcome).toBe('rejected')
  const targets = [path(), join(root, 'accounts', `${id}.json`), join(root, 'accounts', `${id}.json.lifecycle`)]
  const before = targets.map(target => readFileSync(target, 'utf8'))
  for (const accessToken of ['first', 'old', 'different-fresh']) {
    expect(authority.commitClaudeLogin(id, `competing-${accessToken}`, { ...credentials, accessToken }, profile))
      .toMatchObject({ outcome: 'rejected', reason: 'recovery_in_progress' })
    expect(targets.map(target => readFileSync(target, 'utf8'))).toEqual(before)
  }
  expect((await child('retry', 'interrupted')).outcome).toBe('committed')
  expect((await child('login', 'winner', 'winner-token')).outcome).toBe('committed')
  expect((await child('retry', 'interrupted')).outcome).toBe('rejected')
  expect(authority.commitClaudeLogin(id, 'interrupted', freshCredentials, profile).outcome).toBe('rejected')
  expect((await child('read')).record.credentials.accessToken).toBe('winner-token')
})
for (const failedBarrier of ['legacy', 'lifecycle']) {
  test(`production init finishes reserved fresh login after ${failedBarrier} recovery failure`, async () => {
    await child('login', 'old-login', 'first')
    const old = authority.captureClaudeCredentialHandle(id, 'first')!
    legacy(Number.MAX_SAFE_INTEGER + 1)
    const fresh = { ...credentials, accessToken: 'fresh', refreshToken: 'refresh-fresh' }
    const original = atomic.writeFileAtomicDurableSync
    const target = join(root, 'accounts', `${id}.json${failedBarrier === 'lifecycle' ? '.lifecycle' : ''}`)
    const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((destination, data, options) => {
      if (String(destination) === target) throw new Error('synthetic barrier failure')
      return original(destination, data, options)
    })
    try {
      expect(authority.commitClaudeLogin(id, 'startup-recovery', fresh, profile).outcome).toBe('persistence_pending')
    } finally { spy.mockRestore() }
    const reserved = JSON.parse(readFileSync(path(), 'utf8')).pendingLogin
    expect(reserved.operationId).toBe('startup-recovery')
    expect(authority.readClaudeAccountAuthority(id).status).toBe('incompatible_writer')
    // Even a visible denial rewrite followed by a durability error must stop
    // startup before either barrier is repaired.
    const before = readFileSync(target, 'utf8')
    const resync = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((destination, data, options) => {
      const out = original(destination, data, options)
      if (String(destination) === path()) throw new Error('synthetic after-rename denial sync failure')
      return out
    })
    try { expect(() => authority.migrateClaudeAccountAuthority(id)).toThrow('synthetic after-rename denial sync failure') }
    finally { resync.mockRestore() }
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(authority.isClaudeCredentialReady(old)).toBe(false)
    const initialized = await child('init')
    expect(initialized.authority.status).toBe('ready')
    expect(initialized.authority.record.credentials.accessToken).toBe('fresh')
    expect(initialized.authority.handle.generation).toBe(reserved.generation)
    expect(initialized.authority.record.operations['startup-recovery']).toMatchObject({ kind: 'login', generation: reserved.generation })
    expect(initialized.authority.record.pendingLogin).toBeUndefined()
    expect((await child('init')).authority.handle).toEqual(initialized.authority.handle)
    expect(authority.isClaudeCredentialReady(old)).toBe(false)
  })
}
test('recovery installation errors give actionable instructions', () => {
  const receipt = { outcome: 'rejected' as const, operationId: 'login', restartRecoverable: false }
  expect(new authority.ClaudeLoginInstallationError({ ...receipt, reason: 'recovery_in_progress' }).message)
    .toBe('A previous sign-in still needs to finish saving. Restart Cat Code, then try again.')
  expect(new authority.ClaudeLoginInstallationError({ ...receipt, reason: 'stale_credentials' }).message)
    .toBe('These sign-in credentials are no longer usable. Start a new sign-in.')
  expect(new authority.ClaudeLoginInstallationError(receipt).message)
    .toBe('Failed to save Claude sign-in. Restore vault access and retry saving.')
})
test('recovery refuses known stale access tokens under new operations without disk mutation', async () => {
  await child('login', 'old-login', 'first')
  legacy(Number.MAX_SAFE_INTEGER + 1)
  const targets = [path(), join(root, 'accounts', `${id}.json`), join(root, 'accounts', `${id}.json.lifecycle`)]
  const before = targets.map(target => readFileSync(target, 'utf8'))
  for (const accessToken of ['first', 'old']) {
    expect(authority.commitClaudeLogin(id, `stale-${accessToken}`, { ...credentials, accessToken }, profile))
      .toMatchObject({ outcome: 'rejected', reason: 'stale_credentials' })
    expect(targets.map(target => readFileSync(target, 'utf8'))).toEqual(before)
  }
})
test('pre-rename recovery reservation cannot become a later login after a winner', async () => {
  await child('login', 'old-login', 'first')
  legacy(Number.MAX_SAFE_INTEGER + 1)
  const freshCredentials = { ...credentials, accessToken: 'fresh', refreshToken: 'refresh-fresh' }
  const before = readFileSync(path(), 'utf8')
  const original = atomic.writeFileAtomicDurableSync
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target) === path()) throw new Error('synthetic pre-rename reservation failure')
    return original(target, data, options)
  })
  try {
    expect(authority.commitClaudeLogin(id, 'failed-reservation', freshCredentials, profile).outcome).toBe('persistence_pending')
  } finally { spy.mockRestore() }
  expect(readFileSync(path(), 'utf8')).toBe(before)
  expect(authority.commitClaudeLogin(id, 'winner', { ...freshCredentials, accessToken: 'winner' }, profile).outcome).toBe('committed')
  const winner = readFileSync(path(), 'utf8')
  expect(authority.commitClaudeLogin(id, 'failed-reservation', freshCredentials, profile).outcome).toBe('rejected')
  expect(authority.retryClaudeAuthorityPersistence(id, 'failed-reservation').outcome).toBe('rejected')
  expect(readFileSync(path(), 'utf8')).toBe(winner)
  expect((await child('login', 'failed-reservation', 'fresh')).outcome).toBe('rejected')
})
test('fresh recovery refuses unsupported and corrupt authority records', async () => {
  await child('login')
  const record = JSON.parse(readFileSync(path(), 'utf8'))
  legacy(Number.MAX_SAFE_INTEGER + 1)
  for (const bad of [{ ...record, formatVersion: 2 }, { ...record, operations: null }]) {
    writeFileSync(path(), JSON.stringify(bad))
    expect(authority.commitClaudeLogin(id, 'fresh', credentials, profile).outcome).toBe('rejected')
    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual(bad)
    expect(JSON.parse(readFileSync(join(root, 'accounts', `${id}.json`), 'utf8')).tokens.access_token).toBe('old')
  }
})
test('unsupported and malformed nested versions fail closed', async () => {
  await child('login')
  const record = JSON.parse(readFileSync(path(), 'utf8'))
  writeFileSync(path(), JSON.stringify({ ...record, formatVersion: 2 }))
  expect((await child('read')).status).toBe('unsupported')
  writeFileSync(path(), JSON.stringify({ ...record, refreshIntent: { phase: 'prepared' } }))
  expect((await child('read')).status).toBe('unavailable')
})
test('immutable handles deny old chats after a new login', async () => {
  await child('login', 'login-one', 'first')
  const old = authority.captureClaudeCredentialHandle(id, 'first')!
  expect(Object.isFrozen(old)).toBe(true)
  await child('login', 'login-two', 'second')
  expect(authority.withClaudeCredentialSend(old, () => 'sent')).toBeNull()
})
test('access rejection is repairable but never sendable, while invalid grant denies refresh', async () => {
  await child('login', 'one', 'first')
  await child('reject', 'access-denied')
  const rejected = authority.readClaudeAccountAuthority(id)
  if (!('handle' in rejected)) throw new Error('Missing handle')
  expect(authority.withClaudeCredentialSend(rejected.handle, () => 'sent')).toBeNull()
  expect((await child('refresh', 'repair', 'second')).outcome).toBe('committed')
  const current = authority.readClaudeAccountAuthority(id)
  if (!('handle' in current)) throw new Error('Missing handle')
  expect(current.status).toBe('ready')
  authority.rejectClaudeCredential(current.handle, 'invalid', 'invalid_grant')
  expect(authority.claimClaudeRefresh(current.handle, 'denied', 'owner').outcome).toBe('rejected')
  expect((await child('read')).record.rejection).toBe('refresh_rejected')
})
test('missing authority never remigrates its compatibility barrier', async () => {
  await child('login')
  rmSync(path())
  expect((await child('read')).status).toBe('unavailable')
  expect((await child('migrate')).status).toBe('unavailable')
  expect((await child('login', 'new-operation')).outcome).toBe('rejected')
})
test('failed writes with no durable payload explicitly cannot survive restart', () => {
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic ENOSPC') })
  try {
    expect(authority.commitClaudeLogin(id, 'no-write', credentials, profile))
      .toMatchObject({ outcome: 'persistence_pending', restartRecoverable: false })
  } finally { spy.mockRestore() }
})
test('deferred login cannot rebase itself after a newer operation wins', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const original = atomic.writeFileAtomicDurableSync
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target) === path() && JSON.parse(String(data)).loginGeneration === 1) throw new Error('synthetic ENOSPC')
    return original(target, data, options)
  })
  try { expect(authority.commitClaudeLogin(id, 'deferred', credentials, profile).outcome).toBe('persistence_pending') } finally { spy.mockRestore() }
  await child('login', 'winner', 'winner-token')
  expect((await child('retry', 'deferred')).outcome).toBe('rejected')
  expect((await child('login', 'deferred', 'first')).outcome).toBe('rejected')
  expect((await child('read')).record.credentials.accessToken).toBe('winner-token')
})
test('refresh successor persistence retry never claims or dispatches redemption again', () => {
  authority.commitClaudeLogin(id, 'login', credentials, profile)
  const current = authority.readClaudeAccountAuthority(id)
  if (!('handle' in current)) throw new Error('Missing handle')
  const claim = authority.claimClaudeRefresh(current.handle, 'refresh-pending', 'owner').claim!
  let sends = 0
  authority.startClaudeRefreshDispatch(claim, () => ++sends)
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic ENOSPC') })
  try {
    expect(authority.completeClaudeRefresh(claim, { ...credentials, accessToken: 'successor' }))
      .toMatchObject({ outcome: 'persistence_pending', restartRecoverable: false })
  } finally { spy.mockRestore() }
  expect(authority.retryClaudeAuthorityPersistence(id, 'refresh-pending').outcome).toBe('committed')
  expect(authority.readClaudeAccountAuthority(id)).toMatchObject({ status: 'ready', handle: { revision: 1 },
    record: { credentials: { accessToken: 'successor' } } })
  expect(sends).toBe(1)
})
test('refresh lock path shares the exact isolated authority root', () => {
  expect(authority.getClaudeRefreshLockPath(id)).toBe(join(root, 'authority-v1', `${id}.json.refresh`))
  expect(() => authority.getClaudeRefreshLockPath('../other')).toThrow('Invalid Claude account identity')
})
test.each(['separate-process', 'same-process'] as const)('failed in-memory login staging survives a %s refresh of its original generation', async observer => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic staging failure') })
  try {
    expect(authority.commitClaudeLogin(id, 'deferred-stage', credentials, profile))
      .toMatchObject({ outcome: 'persistence_pending', restartRecoverable: false })
  } finally { spy.mockRestore() }
  if (observer === 'separate-process') expect((await child('refresh', 'intervening-refresh', 'refreshed')).outcome).toBe('committed')
  else {
    const current = authority.readClaudeAccountAuthority(id)
    if (!('handle' in current)) throw new Error('Missing handle')
    const claim = authority.claimClaudeRefresh(current.handle, 'intervening-refresh', 'owner').claim!
    authority.startClaudeRefreshDispatch(claim, () => true)
    expect(authority.completeClaudeRefresh(claim, { ...credentials, accessToken: 'refreshed' }).outcome).toBe('committed')
  }
  const retried = authority.commitClaudeLogin(id, 'deferred-stage', credentials, profile)
  expect(retried).toMatchObject({ outcome: 'committed', handle: { generation: 1, revision: 0 } })
  const fresh = await child('read')
  expect(fresh.record.operations['intervening-refresh'].kind).toBe('refresh')
  expect(fresh.record.operations['deferred-stage'].kind).toBe('login')
  expect(fresh.record.credentials.accessToken).toBe(credentials.accessToken)
  expect((await child('retry', 'deferred-stage')).handle.generation).toBe(1)
})
test('an in-memory pending login rejects changed payload reuse without committing either payload', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic staging failure') })
  try { authority.commitClaudeLogin(id, 'pending-reuse', credentials, profile) } finally { spy.mockRestore() }
  expect(authority.commitClaudeLogin(id, 'pending-reuse', { ...credentials, accessToken: 'different' }, profile))
    .toMatchObject({ outcome: 'rejected', reason: 'operation_conflict' })
  expect(authority.commitClaudeLogin(id, 'pending-reuse', credentials, { ...profile, email_address: 'different@example.com' }))
    .toMatchObject({ outcome: 'rejected', reason: 'operation_conflict' })
  expect((await child('read')).record.credentials.accessToken).toBe('old')
  expect(authority.commitClaudeLogin(id, 'pending-reuse', credentials, profile).outcome).toBe('committed')
})
test.each(['login', 'delete'])('failed in-memory login staging is still superseded by a newer %s', async action => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const spy = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic staging failure') })
  try { authority.commitClaudeLogin(id, 'superseded-stage', credentials, profile) } finally { spy.mockRestore() }
  await child(action, 'newer-operation', 'winner')
  expect(authority.retryClaudeAuthorityPersistence(id, 'superseded-stage'))
    .toMatchObject({ outcome: 'rejected', reason: 'superseded' })
  expect(authority.commitClaudeLogin(id, 'superseded-stage', credentials, profile))
    .toMatchObject({ outcome: 'rejected', reason: 'superseded' })
})
test('a newer same-process login durably retires an unstaged operation for fresh commit callers', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation(() => { throw new Error('synthetic staging failure') })
  try { authority.commitClaudeLogin(id, 'unstaged-old-login', credentials, profile) } finally { fail.mockRestore() }
  expect(authority.commitClaudeLogin(id, 'winner-login', { ...credentials, accessToken: 'winner' }, profile).outcome).toBe('committed')
  expect(authority.commitClaudeLogin(id, 'unstaged-old-login', credentials, profile).outcome).toBe('rejected')
  expect((await child('login', 'unstaged-old-login', credentials.accessToken)).outcome).toBe('rejected')
  expect((await child('read')).record.credentials.accessToken).toBe('winner')
})
test('uncertain issued success reconciles under authority ownership but never overwrites a new login', async () => {
  authority.commitClaudeLogin(id, 'login', credentials, profile)
  const current = authority.readClaudeAccountAuthority(id)
  if (!('handle' in current)) throw new Error('Missing handle')
  const claim = authority.claimClaudeRefresh(current.handle, 'refresh-one', 'owner').claim!
  authority.startClaudeRefreshDispatch(claim, () => true)
  authority.markClaudeRefreshUncertain(claim)
  const successor = { ...credentials, accessToken: 'issued' }
  expect(authority.completeClaudeRefresh(claim, successor).outcome).toBe('rejected')
  expect(authority.reconcileClaudeRefresh(id, claim.operationId, { claim, credentials: successor }).outcome).toBe('committed')
  await child('login', 'new-login', 'new-login-token')
  expect(authority.reconcileClaudeRefresh(id, claim.operationId, { claim, credentials: successor }).outcome).toBe('rejected')
  expect((await child('read')).record.credentials.accessToken).toBe('new-login-token')
})
test('receipts retain hashes, not historical credentials or profile payloads', async () => {
  await child('login', 'one', 'old-secret-token')
  await child('login', 'two', 'new-secret-token')
  const text = readFileSync(path(), 'utf8')
  expect(text).not.toContain('old-secret-token')
  const record = JSON.parse(text)
  expect(record.operations.one.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  expect(record.operations.two.fingerprint).toMatch(/^[0-9a-f]{64}$/)
})
test.each(['resume', 'kill'] as const)('suspended read/write owner cannot lose its kernel guard; %s releases ownership', async action => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const owner = spawnProbe('suspend-login', 'paused-login', 'paused-token')
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(join(root, 'paused.ready'))) {
      if (Date.now() > deadline) throw new Error('Owner did not reach authority read/write boundary')
      await Bun.sleep(5)
    }
    const old = new Date(Date.now() - 600_000)
    utimesSync(join(root, 'accounts', `${id}.json.lock`), old, old)
    expect(await child('try-guard')).toEqual({ acquired: false, code: 'ELOCKED' })
    expect((await child('read')).record.credentials.accessToken).toBe('old')
    if (action === 'resume') {
      const contender = child('login', 'newer-login', 'newer-token')
      process.kill(owner.pid, 'SIGCONT')
      expect(await owner.exited).toBe(0)
      expect((await contender).outcome).toBe('committed')
      expect((await child('read')).record.credentials.accessToken).toBe('newer-token')
    } else {
      process.kill(owner.pid, 'SIGKILL')
      await owner.exited
      expect((await child('login', 'after-death', 'recovered-token')).outcome).toBe('committed')
      expect((await child('read')).record.credentials.accessToken).toBe('recovered-token')
    }
  } finally {
    if (owner.exitCode === null) owner.kill('SIGKILL')
    await owner.exited
  }
})
test('production restart repairs pending A without replacing the newer successful default B', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const original = atomic.writeFileAtomicDurableSync
  const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target) === path() && JSON.parse(String(data)).loginGeneration === 1) throw new Error('synthetic A commit failure')
    return original(target, data, options)
  })
  try { authority.commitClaudeLogin(id, 'pending-a', credentials, profile) } finally { fail.mockRestore() }
  expect((await child('login-other', 'successful-b', 'b-token')).outcome).toBe('committed')
  const restarted = await child('init')
  expect(restarted.active.accountUuid).toBe('other-account')
  expect(restarted.active.accessToken).toBe('b-token')
  expect(restarted.authority).toMatchObject({
    status: 'ready', handle: { generation: 1 },
    record: { operations: { 'pending-a': { kind: 'login' } } },
  })
  expect((await child('init')).active.accountUuid).toBe('other-account')
})
test('production initialization resumes a durable pending login exactly once in a fresh process', async () => {
  legacy(); authority.migrateClaudeAccountAuthority(id)
  const original = atomic.writeFileAtomicDurableSync
  const fail = spyOn(atomic, 'writeFileAtomicDurableSync').mockImplementation((target, data, options) => {
    if (String(target) === path() && JSON.parse(String(data)).loginGeneration === 1) throw new Error('synthetic commit failure')
    return original(target, data, options)
  })
  try { authority.commitClaudeLogin(id, 'startup-repair', credentials, profile) } finally { fail.mockRestore() }
  expect((await child('read')).status).toBe('persistence_pending')
  const failed = await child('init-failure')
  expect(failed.active).toBeNull()
  expect(failed.authority.status).toBe('persistence_pending')
  const repaired = await child('init')
  expect(repaired.active.accessToken).toBe(credentials.accessToken)
  expect(repaired.active.lifecycleGeneration).toBe(1)
  expect(repaired.authority.record.operations['startup-repair'].kind).toBe('login')
  expect((await child('init')).active.lifecycleGeneration).toBe(1)
})
