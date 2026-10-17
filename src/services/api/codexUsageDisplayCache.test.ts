import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PoolAccount } from './codexAccountPool.js'
import type { AccountUsage, PoolUsageSnapshot } from './codexUsage.js'
import { readCodexUsageDisplayCache as read, updateCodexUsageDisplayCache as update } from './codexUsageDisplayCache.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const now = 1_800_000_000_000
function options() {
  const directory = mkdtempSync(join(tmpdir(), 'usage-display-'))
  directories.push(directory)
  chmodSync(directory, 0o700)
  return { cacheFile: join(directory, 'display.json'), now }
}
function account(accountId = 'one', credentialGeneration = 1): PoolAccount {
  return {
    accountId, credentialGeneration, credentialGenerationState: 'lifecycle_bound',
    accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token', expiresAt: now + 10_000,
    source: 'vault', status: 'healthy', lastUsedAt: 0, vaultFilePath: `/private/${accountId}.json`,
    usagePrimary: 7, usageAllowed: true,
  }
}
function usage(accountId = 'one', fetchedAt = now): AccountUsage {
  return {
    accountId, fetchedAt, userId: 'private-user', email: 'private@example.com', planType: 'pro',
    allowed: true, limitReached: false,
    primaryWindow: { usedPercent: 30, limitWindowSeconds: 300, resetAfterSeconds: 10, resetAt: now / 1000 + 10 },
    secondaryWindow: { usedPercent: 40, limitWindowSeconds: 600, resetAfterSeconds: 60, resetAt: now / 1000 + 60 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
  }
}
function snapshot(...accounts: AccountUsage[]): PoolUsageSnapshot {
  return { accounts, fetchedAt: now, errors: [{ accountId: 'two', error: 'private raw failure' }] }
}

test('default location creates private storage beneath a public general cache directory', async () => {
  const config = mkdtempSync(join(tmpdir(), 'usage-display-config-'))
  directories.push(config)
  const generalCache = join(config, 'cache')
  mkdirSync(generalCache, { mode: 0o755 })
  chmodSync(generalCache, 0o755)
  const script = `
    import { readCodexUsageDisplayCache, updateCodexUsageDisplayCache } from ${JSON.stringify(new URL('./codexUsageDisplayCache.ts', import.meta.url).pathname)};
    const accounts = ${JSON.stringify([account()])};
    await updateCodexUsageDisplayCache(accounts, ${JSON.stringify(snapshot(usage()))}, { now: ${now} });
    console.log(JSON.stringify([...readCodexUsageDisplayCache(accounts, { now: ${now} })]));
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' })
  expect(JSON.parse(output)).toEqual([['one', {
    primaryWindow: usage().primaryWindow,
    secondaryWindow: usage().secondaryWindow,
    fetchedAt: now,
    stale: true,
  }]])
  const dedicated = join(generalCache, 'codex-usage-display')
  const cacheFile = join(dedicated, 'observation.json')
  expect(statSync(generalCache).mode & 0o777).toBe(0o755)
  expect(statSync(dedicated).mode & 0o777).toBe(0o700)
  expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
  chmodSync(dedicated, 0o755)
  expect(read([account()], { cacheFile, now }).size).toBe(0)
  await update([account()], snapshot(usage()), { cacheFile, now })
  expect(statSync(dedicated).mode & 0o777).toBe(0o755)
  expect(read([account()], { cacheFile, now }).size).toBe(0)
})

test('partial failure survives readers, recovers independently, and never mutates routing inputs', async () => {
  const opts = options()
  const accounts = [account(), account('two')]
  const before = structuredClone(accounts)
  const initial = snapshot(usage(), usage('two'))
  const original = structuredClone(initial)
  expect((await update(accounts, initial, opts)).get('one')?.stale).toBe(false)
  expect(read(accounts, opts).get('two')?.stale).toBe(true)
  const partial = await update(accounts, snapshot(usage('one', now + 1000)), { ...opts, now: now + 1000 })
  expect(partial.get('one')?.stale).toBe(false)
  expect(partial.get('two')?.stale).toBe(true)
  const recovery = await update(accounts, snapshot(usage('two', now + 2000)), { ...opts, now: now + 2000 })
  expect(recovery.get('two')?.stale).toBe(false)
  expect(recovery.get('two')?.primaryWindow?.resetAfterSeconds).toBe(8)
  expect(accounts).toEqual(before)
  expect(initial).toEqual(original)
  const encoded = readFileSync(opts.cacheFile, 'utf8')
  for (const secret of ['secret-access-token', 'secret-refresh-token', 'private@example.com', 'private-user', 'private raw failure', '/private/']) {
    expect(encoded).not.toContain(secret)
  }
  expect(statSync(opts.cacheFile).mode & 0o777).toBe(0o600)
})

test('windows expire independently and an empty post-reset success fences older completions', async () => {
  const opts = options()
  const accounts = [account()]
  await update(accounts, snapshot(usage()), opts)
  const later = { ...opts, now: now + 10_000 }
  expect(read(accounts, later).get('one')?.primaryWindow).toBeNull()
  expect(read(accounts, later).get('one')?.secondaryWindow?.resetAfterSeconds).toBe(50)
  const empty = usage('one', now + 70_000)
  const result = await update(accounts, snapshot(empty), { ...opts, now: now + 70_000 })
  expect(result.get('one')).toMatchObject({ primaryWindow: null, secondaryWindow: null, stale: false })
  await update(accounts, snapshot(usage()), { ...opts, now: now + 70_000 })
  expect(read(accounts, { ...opts, now: now + 70_000 }).get('one')?.fetchedAt).toBe(now + 70_000)
})

test('identity, generations, removal, unusable auth and future timestamps reject cached readings', async () => {
  const opts = options()
  const current = account()
  await update([current], snapshot(usage()), opts)
  for (const changed of [account('one', 2), account('one', 0), { ...current, source: 'config' as const },
    { ...current, vaultFilePath: '/different' }, { ...current, status: 'dead' as const },
    { ...current, status: 'quarantined' as const }, { ...current, accessToken: '' }]) {
    expect(read([changed], opts).size).toBe(0)
  }
  expect(read([current], { ...opts, now: now - 1 }).size).toBe(0)
  expect(read([], opts).size).toBe(0)
  await update([], snapshot(), opts)
  expect(read([current], opts).size).toBe(0)
  await update([account('one', 0)], snapshot(usage()), opts)
  expect(read([account('one', 0)], opts).size).toBe(0)
})

test('malformed, public, symlinked and unavailable storage fails closed without losing live success', async () => {
  const opts = options()
  const accounts = [account()]
  writeFileSync(opts.cacheFile, '{broken', { mode: 0o600 })
  expect(read(accounts, opts).size).toBe(0)
  await update(accounts, snapshot(usage()), opts)
  chmodSync(opts.cacheFile, 0o644)
  expect(read(accounts, opts).size).toBe(0)
  expect((await update(accounts, snapshot(usage()), opts)).get('one')?.stale).toBe(false)
  expect(statSync(opts.cacheFile).mode & 0o777).toBe(0o644)
  rmSync(opts.cacheFile)
  const target = join(directories[0]!, 'target')
  writeFileSync(target, 'untouched', { mode: 0o600 })
  symlinkSync(target, opts.cacheFile)
  expect(read(accounts, opts).size).toBe(0)
  await update(accounts, snapshot(usage()), opts)
  expect(readFileSync(target, 'utf8')).toBe('untouched')
  chmodSync(directories[0]!, 0o755)
  expect(read(accounts, opts).size).toBe(0)
  expect((await update(accounts, snapshot(usage()), opts)).get('one')?.stale).toBe(false)
  const other = options()
  const linked = join(directories[1]!, 'linked')
  symlinkSync(directories[0]!, linked)
  const linkedOptions = { ...other, cacheFile: join(linked, 'new.json') }
  expect((await update(accounts, snapshot(usage()), linkedOptions)).get('one')?.stale).toBe(false)
  expect(read(accounts, linkedOptions).size).toBe(0)
})

test('concurrent writers merge accounts and retain newer per-account observations', async () => {
  const opts = options()
  const accounts = [account(), account('two')]
  await Promise.all([
    update(accounts, snapshot(usage('one', now + 2000)), { ...opts, now: now + 3000 }),
    update(accounts, snapshot(usage('two', now + 1000)), { ...opts, now: now + 3000 }),
    update(accounts, snapshot(usage('one', now + 1000)), { ...opts, now: now + 3000 }),
  ])
  const result = read(accounts, { ...opts, now: now + 3000 })
  expect(result.size).toBe(2)
  expect(result.get('one')?.fetchedAt).toBe(now + 2000)
})

test('absent secondary windows, future successes and invalid records cannot revive cached data', async () => {
  const opts = options()
  const accounts = [account()]
  const single = { ...usage(), hasSecondaryWindow: false }
  expect((await update(accounts, snapshot(single), opts)).get('one')?.secondaryWindow).toBeNull()
  const future = usage('one', now + 1000)
  future.primaryWindow.usedPercent = 99
  const fallback = await update(accounts, snapshot(future), opts)
  expect(fallback.get('one')).toMatchObject({ stale: true, primaryWindow: { usedPercent: 30 } })
  const valid = JSON.parse(readFileSync(opts.cacheFile, 'utf8'))
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, accounts: [{ ...valid.accounts[0], generation: 0 }] },
    { ...valid, accounts: Array(129).fill(valid.accounts[0]) },
    { ...valid, accounts: [{ ...valid.accounts[0], primaryWindow: { ...single.primaryWindow, usedPercent: -1 } }] },
  ]) {
    writeFileSync(opts.cacheFile, JSON.stringify(invalid), { mode: 0o600 })
    expect(read(accounts, opts).size).toBe(0)
  }
  writeFileSync(opts.cacheFile, ' '.repeat(256 * 1024 + 1), { mode: 0o600 })
  expect(read(accounts, opts).size).toBe(0)
})
