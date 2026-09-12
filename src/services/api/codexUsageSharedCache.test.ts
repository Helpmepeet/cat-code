import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PoolAccount } from './codexAccountPool.js'
import type { PoolUsageSnapshot } from './codexUsage.js'

type Result = { snapshot: PoolUsageSnapshot; hints: (number | null)[] }
type ProbeCommand = { action: 'seed' | 'fetch' | 'invalidate'; accounts?: PoolAccount[]; forceRefresh?: boolean }
type Client = { request(command: ProbeCommand): Promise<Result>; stop(): Promise<void> }
let home: string
let server: ReturnType<typeof Bun.serve>
let requests = 0
let respond: (request: Request, count: number) => Response | Promise<Response>
const clients: Client[] = []

function account(id = 'account-a', extra: Partial<PoolAccount> = {}): PoolAccount {
  return { accountId: id, accessToken: `synthetic-access-${id}`, refreshToken: `synthetic-refresh-${id}`, expiresAt: 2e12, source: 'config', status: 'healthy', lastUsedAt: 0, ...extra }
}

function body(percent: number): Response {
  return Response.json({
    user_id: 'synthetic-user', email: 'synthetic@example.test', plan_type: 'plus',
    rate_limit: { allowed: true, limit_reached: false,
      primary_window: { used_percent: percent, limit_window_seconds: 18000, reset_after_seconds: 60, reset_at: Math.floor(Date.now() / 1000) + 60 },
      secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_after_seconds: 600, reset_at: Math.floor(Date.now() / 1000) + 600 },
    },
    irrelevant_raw_field: 'RAW_RESPONSE_SENTINEL',
  })
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('probe condition timed out')
    await Bun.sleep(5)
  }
}

async function client(accounts = [account()]): Promise<Client> {
  let sequence = 0
  let ready: () => void = () => {}
  const readyPromise = new Promise<void>(resolve => { ready = resolve })
  const pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', join(import.meta.dir, 'codexUsageSharedCache.probe.child.ts')],
    env: {
      PATH: process.env.PATH, HOME: home,
      CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SIMPLE: '1',
      CATCODE_USAGE_PROBE_URL: server.url.toString(),
    },
    stdout: 'pipe', stderr: 'pipe',
    ipc(message: { ready?: boolean; id?: number; error?: string } & Result) {
      if (message.ready) { ready(); return }
      const waiter = pending.get(message.id!)
      if (!waiter) return
      pending.delete(message.id!)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message)
    },
  })
  const stderr = new Response(child.stderr).text()
  void new Response(child.stdout).text()
  const result: Client = {
    request(command) {
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('usage probe request timed out')) }, 20_000)
        pending.set(id, { resolve, reject, timer })
        child.send({ id, ...command })
      })
    },
    async stop() {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('probe stopped')) }
      pending.clear()
      child.kill()
      await child.exited
    },
  }
  clients.push(result)
  await Promise.race([readyPromise, child.exited.then(async code => { throw new Error(`probe exited ${code}: ${await stderr}`) })])
  await result.request({ action: 'seed', accounts })
  return result
}

function cachePath(): string { return join(home, 'cache', 'codex-usage', 'observation.json') }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-usage-sharing-'))
  requests = 0
  respond = (_request, count) => body(count * 10)
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { return respond(request, ++requests) } })
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.stop()))
  await server?.stop(true)
  rmSync(home, { recursive: true, force: true })
})

test('three engine processes share one live read and preserve private normalized observations', async () => {
  let complete: (response: Response) => void = () => {}
  respond = () => new Promise(resolve => { complete = resolve })
  const group = await Promise.all([client(), client(), client()])
  const reads = group.map(client => client.request({ action: 'fetch' }))
  await until(() => requests === 1)
  complete(body(42))
  const results = await Promise.all(reads)
  expect(requests).toBe(1)
  for (const result of results) {
    expect(result.snapshot.accounts[0]?.primaryWindow.usedPercent).toBe(42)
    expect(result.snapshot.accounts[0]?.email).toBe('synthetic@example.test')
    expect(result.hints).toEqual([42])
  }
  const later = await client()
  await later.request({ action: 'fetch' })
  expect(requests).toBe(1)
  expect(statSync(cachePath()).mode & 0o777).toBe(0o600)
  expect(statSync(join(home, 'cache', 'codex-usage')).mode & 0o777).toBe(0o700)
  const saved = readFileSync(cachePath(), 'utf8')
  for (const forbidden of ['synthetic-access', 'synthetic-refresh', 'RAW_RESPONSE_SENTINEL', 'accessToken', 'refreshToken', 'vaultFilePath']) expect(saved).not.toContain(forbidden)
  expect(readdirSync(join(home, 'cache', 'codex-usage')).filter(name => name.endsWith('.lock'))).toEqual([])
}, 30_000)

test('forced reads complete independently of an older network read and cannot be overwritten by it', async () => {
  let completeOld: (response: Response) => void = () => {}
  respond = (_request, count) => count === 1 ? new Promise(resolve => { completeOld = resolve }) : body(90)
  const [slow, fresh] = await Promise.all([client(), client()])
  const oldRead = slow.request({ action: 'fetch' })
  await until(() => requests === 1)
  const forced = await fresh.request({ action: 'fetch', forceRefresh: true })
  expect(forced.snapshot.accounts[0]?.primaryWindow.usedPercent).toBe(90)
  expect(requests).toBe(2)
  completeOld(body(10))
  await oldRead
  const reader = await client()
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([90])
  expect(requests).toBe(2)
}, 30_000)

test('cross-process invalidation fences an old response and a warm local cache', async () => {
  const [reader, invalidator] = await Promise.all([client(), client()])
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([10])
  await invalidator.request({ action: 'invalidate' })
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([20])
  let completeOld: (response: Response) => void = () => {}
  respond = () => new Promise(resolve => { completeOld = resolve })
  const stale = reader.request({ action: 'fetch', forceRefresh: true })
  await until(() => requests === 3)
  await invalidator.request({ action: 'invalidate' })
  completeOld(body(88))
  expect((await stale).hints).toEqual([20])
  respond = () => body(33)
  const after = await client()
  expect((await after.request({ action: 'fetch' })).hints).toEqual([33])
  expect(requests).toBe(4)
}, 30_000)

test('credential, inventory and durable profile revisions invalidate local and shared observations', async () => {
  const reader = await client()
  await reader.request({ action: 'fetch' })
  await reader.request({ action: 'seed', accounts: [account('account-a', { accessToken: 'synthetic-rotated' })] })
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([20])
  await reader.request({ action: 'seed', accounts: [account('account-b')] })
  expect((await reader.request({ action: 'fetch' })).snapshot.accounts.map(account => account.accountId)).toEqual(['account-b'])
  const profile = join(home, 'profile.json')
  writeFileSync(profile, '{}')
  await reader.request({ action: 'seed', accounts: [account('account-b', { source: 'vault', vaultFilePath: profile })] })
  await reader.request({ action: 'fetch' })
  rmSync(profile)
  await reader.request({ action: 'fetch' })
  expect(requests).toBe(5)
}, 30_000)

test('expired, future-dated, malformed and oversized records are ignored', async () => {
  const writer = await client()
  await writer.request({ action: 'fetch' })
  const good = JSON.parse(readFileSync(cachePath(), 'utf8'))
  const variants = [
    JSON.stringify({ ...good, snapshot: { ...good.snapshot, fetchedAt: Date.now() - 60_001 } }),
    JSON.stringify({ ...good, snapshot: { ...good.snapshot, fetchedAt: Date.now() + 60_000 } }),
    JSON.stringify({ ...good, startedAt: Date.now() + 60_000 }),
    '{broken', 'x'.repeat(256 * 1024 + 1),
  ]
  for (const variant of variants) {
    writeFileSync(cachePath(), variant, { mode: 0o600 })
    await (await client()).request({ action: 'fetch' })
  }
  expect(requests).toBe(1 + variants.length)
}, 30_000)

test('failed observations and unavailable cache storage fall back without persisting errors', async () => {
  respond = () => new Response('PRIVATE_ERROR_BODY', { status: 503 })
  const first = await client()
  expect((await first.request({ action: 'fetch' })).snapshot.errors[0]?.error).toBe('HTTP 503')
  const second = await client()
  await second.request({ action: 'fetch' })
  expect(requests).toBe(2)
  expect(readdirSync(join(home, 'cache', 'codex-usage'))).not.toContain('observation.json')
  rmSync(join(home, 'cache', 'codex-usage'), { recursive: true })
  writeFileSync(join(home, 'cache', 'codex-usage'), 'not a directory')
  respond = () => body(61)
  expect((await (await client()).request({ action: 'fetch' })).hints).toEqual([61])
}, 30_000)

test('public or symlinked records are not consumed', async () => {
  await (await client()).request({ action: 'fetch' })
  chmodSync(cachePath(), 0o644)
  await (await client()).request({ action: 'fetch' })
  const target = join(home, 'outside-cache.json')
  writeFileSync(target, readFileSync(cachePath()), { mode: 0o600 })
  rmSync(cachePath())
  symlinkSync(target, cachePath())
  await (await client()).request({ action: 'fetch' })
  expect(requests).toBe(3)
}, 30_000)

test('failed epoch replacement evicts the previous observation when the directory still permits it', async () => {
  const reader = await client()
  await reader.request({ action: 'fetch' })
  // A directory at the marker target rejects atomic file replacement while
  // leaving deletion of the sibling observation available.
  mkdirSync(join(home, 'cache', 'codex-usage', 'epoch'))
  await (await client()).request({ action: 'invalidate' })
  expect(readdirSync(join(home, 'cache', 'codex-usage'))).not.toContain('observation.json')
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([20])
}, 30_000)

test('a read-only cache directory does not block live observations when locking fails', async () => {
  const directory = join(home, 'cache', 'codex-usage')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o500)
  try {
    expect((await (await client()).request({ action: 'fetch' })).hints).toEqual([10])
    expect(readdirSync(directory)).toEqual([])
  } finally {
    chmodSync(directory, 0o700)
  }
}, 30_000)

test('an in-flight observation cannot apply hints after credential replacement', async () => {
  let completeOld: (response: Response) => void = () => {}
  respond = (_request, count) => count === 1 ? new Promise(resolve => { completeOld = resolve }) : body(70)
  const reader = await client()
  const old = reader.request({ action: 'fetch' })
  await until(() => requests === 1)
  await reader.request({ action: 'seed', accounts: [account('account-a', { accessToken: 'synthetic-new-credential' })] })
  const current = await reader.request({ action: 'fetch', forceRefresh: true })
  expect(current.hints).toEqual([70])
  completeOld(body(10))
  expect((await old).hints).toEqual([70])
  expect((await reader.request({ action: 'fetch' })).hints).toEqual([70])
  expect(requests).toBe(2)
}, 30_000)
