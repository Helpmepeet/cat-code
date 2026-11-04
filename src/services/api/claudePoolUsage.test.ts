import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ClaudePoolAccount } from './claudeAccountPool.js'
import { CLAUDE_USAGE_FRESH_MS, fetchClaudePoolUsage } from './claudePoolUsage.js'
import type { Utilization } from './usage.js'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const HOUR = 3_600_000
let dir: string
let cacheFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-pool-usage-'))
  cacheFile = join(dir, 'cache', 'claude-usage.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function account(over: Partial<ClaudePoolAccount> & { accountUuid: string }): ClaudePoolAccount {
  return {
    emailAddress: `${over.accountUuid}@example.com`,
    accessToken: `token-${over.accountUuid}`,
    refreshToken: 'refresh',
    expiresAt: NOW + 8 * HOUR,
    status: 'healthy',
    ...over,
  }
}

function reading(fivePct: number, weekPct: number): Utilization {
  return {
    five_hour: { utilization: fivePct, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
    seven_day: { utilization: weekPct, resets_at: new Date(NOW + 72 * HOUR).toISOString() },
  }
}

test('reads each account with its own token and maps both windows', async () => {
  const seen: string[] = []
  const usage = await fetchClaudePoolUsage(
    [account({ accountUuid: 'a' }), account({ accountUuid: 'b' })],
    {
      now: NOW,
      cacheFile,
      fetchUsage: async token => {
        seen.push(token)
        return token === 'token-a' ? reading(12.4, 40) : reading(100, 7)
      },
    },
  )
  expect(seen.sort()).toEqual(['token-a', 'token-b'])
  expect(usage.get('a')).toEqual({
    fiveHour: { percent: 12, resetAt: (NOW + 2 * HOUR) / 1000 },
    weekly: { percent: 40, resetAt: (NOW + 72 * HOUR) / 1000 },
    weeklyOpus: null, weeklySonnet: null, extraUsage: null,
    checkedAt: NOW, stale: false,
  })
  expect(usage.get('b')?.fiveHour?.percent).toBe(100)
  expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(cacheFile, 'utf8')).not.toContain('token-')
})

test('caches model windows and extra credits, marking failed reads stale', async () => {
  const accounts = [account({ accountUuid: 'a' })]
  const data: Utilization = {
    ...reading(10, 20),
    seven_day_opus: reading(0, 31).seven_day,
    seven_day_sonnet: reading(0, 42).seven_day,
    extra_usage: { used_credits: 123, monthly_limit: 500, is_enabled: false, utilization: 24.6 },
  }
  const fresh = await fetchClaudePoolUsage(accounts, {
    now: NOW, cacheFile, fetchUsage: async () => data,
  })
  expect(fresh.get('a')?.weeklyOpus?.percent).toBe(31)
  expect(fresh.get('a')?.weeklySonnet?.percent).toBe(42)
  expect(fresh.get('a')?.extraUsage).toEqual({
    usedCredits: 123, monthlyLimit: 500, isEnabled: false,
  })
  const stale = await fetchClaudePoolUsage(accounts, {
    now: NOW + CLAUDE_USAGE_FRESH_MS, cacheFile,
    fetchUsage: async () => { throw new Error('offline') },
  })
  expect(stale.get('a')).toEqual({ ...fresh.get('a'), stale: true })

  // A version-2 observation from before these optional fields is still usable.
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  for (const key of ['weeklyOpus', 'weeklySonnet', 'extraUsage', 'checkedAt', 'stale']) {
    delete cache.accounts.a[key]
  }
  writeFileSync(cacheFile, JSON.stringify(cache))
  const legacy = await fetchClaudePoolUsage(accounts, {
    now: NOW + 1, cacheFile, cachedOnly: true,
  })
  expect(legacy.get('a')?.checkedAt).toBe(NOW)
  expect(legacy.get('a')?.stale).toBe(false)
  expect(legacy.get('a')?.weekly?.percent).toBe(20)
})

test('never sends an expired or dead account token, and reuses its last reading', async () => {
  const fetched: string[] = []
  const fetchUsage = async (token: string) => {
    fetched.push(token)
    return reading(30, 50)
  }
  await fetchClaudePoolUsage([account({ accountUuid: 'idle' })], {
    now: NOW,
    cacheFile,
    fetchUsage,
  })
  fetched.length = 0

  const later = NOW + HOUR
  const usage = await fetchClaudePoolUsage(
    [
      account({ accountUuid: 'idle', expiresAt: later - 1 }),
      account({ accountUuid: 'dead', status: 'dead' }),
    ],
    { now: later, cacheFile, fetchUsage },
  )
  expect(fetched).toEqual([])
  expect(usage.get('idle')?.fiveHour?.percent).toBe(30)
  expect(usage.has('dead')).toBe(false)
})

test('a fresh cached reading is reused instead of asking again', async () => {
  let calls = 0
  const fetchUsage = async () => {
    calls++
    return reading(calls, calls)
  }
  const accounts = [account({ accountUuid: 'a' })]
  await fetchClaudePoolUsage(accounts, { now: NOW, cacheFile, fetchUsage })
  const reused = await fetchClaudePoolUsage(accounts, {
    now: NOW + CLAUDE_USAGE_FRESH_MS - 1,
    cacheFile,
    fetchUsage,
  })
  expect(calls).toBe(1)
  expect(reused.get('a')?.fiveHour?.percent).toBe(1)

  const refreshed = await fetchClaudePoolUsage(accounts, {
    now: NOW + CLAUDE_USAGE_FRESH_MS,
    cacheFile,
    fetchUsage,
  })
  expect(calls).toBe(2)
  expect(refreshed.get('a')?.fiveHour?.percent).toBe(2)
})

test('forced fresh reads target only requested accounts and preserve all cached results', async () => {
  const accounts = [account({ accountUuid: 'a' }), account({ accountUuid: 'b' })]
  await fetchClaudePoolUsage(accounts, {
    now: NOW, cacheFile, fetchUsage: async () => reading(10, 20),
  })
  const originalB = JSON.parse(readFileSync(cacheFile, 'utf8')).accounts.b
  const seen: string[] = []
  const fetchUsage = async (token: string) => {
    seen.push(token)
    return reading(30, 40)
  }
  const refreshed = await fetchClaudePoolUsage(accounts, {
    now: NOW + 1, cacheFile, fetchUsage, force: true, accountIds: ['a'],
  })
  expect(seen).toEqual(['token-a'])
  expect(refreshed.get('a')?.fiveHour?.percent).toBe(30)
  expect(refreshed.get('a')?.checkedAt).toBe(NOW + 1)
  expect(refreshed.get('b')?.fiveHour?.percent).toBe(10)
  expect(JSON.parse(readFileSync(cacheFile, 'utf8')).accounts.b).toEqual(originalB)

  const stale = await fetchClaudePoolUsage(accounts, {
    now: NOW + CLAUDE_USAGE_FRESH_MS + 1, cacheFile, fetchUsage, accountIds: [],
  })
  expect(seen).toEqual(['token-a'])
  expect(stale.size).toBe(2)
  expect(stale.get('b')?.stale).toBe(true)
  await fetchClaudePoolUsage(accounts, {
    now: NOW + 2, cacheFile, fetchUsage, force: true, cachedOnly: true,
  })
  expect(seen).toEqual(['token-a'])
})

test('a changed credential cannot reuse usage attributed to the old token', async () => {
  await fetchClaudePoolUsage([account({ accountUuid: 'a', accessToken: 'wrong-account-token' })], {
    now: NOW, cacheFile, fetchUsage: async () => reading(100, 20),
  })
  const accounts = [account({ accountUuid: 'a', accessToken: 'correct-account-token' })]
  const cached = await fetchClaudePoolUsage(accounts, {
    now: NOW + 1, cacheFile, cachedOnly: true,
  })
  expect(cached.has('a')).toBe(false)

  const refreshed = await fetchClaudePoolUsage(accounts, {
    now: NOW + 2, cacheFile, fetchUsage: async () => reading(21, 3),
  })
  expect(refreshed.get('a')?.fiveHour?.percent).toBe(21)
  expect(refreshed.get('a')?.weekly?.percent).toBe(3)
  expect(readFileSync(cacheFile, 'utf8')).not.toContain('account-token')
})

test('a window past its reset time is dropped rather than shown as current', async () => {
  const accounts = [account({ accountUuid: 'a', expiresAt: NOW + 10 * HOUR })]
  await fetchClaudePoolUsage(accounts, {
    now: NOW,
    cacheFile,
    fetchUsage: async () => reading(80, 60),
  })
  const usage = await fetchClaudePoolUsage(accounts, {
    now: NOW + 3 * HOUR,
    cacheFile,
    fetchUsage: async () => {
      throw new Error('429')
    },
  })
  expect(usage.get('a')).toEqual({
    fiveHour: null,
    weekly: { percent: 60, resetAt: (NOW + 72 * HOUR) / 1000 },
    weeklyOpus: null, weeklySonnet: null, extraUsage: null,
    checkedAt: NOW, stale: true,
  })
})

test('cached-only reads never use the network, including on a stale or missing cache', async () => {
  const accounts = [account({ accountUuid: 'a' })]
  let calls = 0
  const fetchUsage = async () => {
    calls++
    return reading(25, 9)
  }
  const empty = await fetchClaudePoolUsage(accounts, {
    now: NOW, cacheFile, cachedOnly: true, fetchUsage,
  })
  expect(empty.size).toBe(0)
  expect(calls).toBe(0)

  await fetchClaudePoolUsage(accounts, { now: NOW, cacheFile, fetchUsage })
  const saved = await fetchClaudePoolUsage(accounts, {
    now: NOW + 3 * HOUR, cacheFile, cachedOnly: true, fetchUsage,
  })
  expect(calls).toBe(1)
  expect(saved.get('a')).toEqual({
    fiveHour: null,
    weekly: { percent: 9, resetAt: (NOW + 72 * HOUR) / 1000 },
    weeklyOpus: null, weeklySonnet: null, extraUsage: null,
    checkedAt: NOW, stale: true,
  })
})

test('removed accounts leave the cache and a corrupt cache is ignored', async () => {
  writeFileSync(join(dir, 'corrupt.json'), '{not json')
  const usage = await fetchClaudePoolUsage([account({ accountUuid: 'a' })], {
    now: NOW,
    cacheFile: join(dir, 'corrupt.json'),
    fetchUsage: async () => reading(5, 5),
  })
  expect(usage.get('a')?.weekly?.percent).toBe(5)

  await fetchClaudePoolUsage([], {
    now: NOW,
    cacheFile: join(dir, 'corrupt.json'),
    fetchUsage: async () => reading(5, 5),
  })
  expect(JSON.parse(readFileSync(join(dir, 'corrupt.json'), 'utf8'))).toEqual({
    version: 2,
    accounts: {},
  })
})

test('unknown or invalid resets expire by observation age while known windows survive', async () => {
  for (const resets_at of [null, 'invalid']) {
    await fetchClaudePoolUsage([account({ accountUuid: 'a' })], {
      now: NOW, cacheFile,
      fetchUsage: async () => ({
        five_hour: { utilization: 40, resets_at },
        seven_day: reading(0, 70).seven_day,
      } as Utilization),
    })
    const fresh = await fetchClaudePoolUsage([account({ accountUuid: 'a' })], {
      now: NOW + CLAUDE_USAGE_FRESH_MS - 1, cacheFile, cachedOnly: true,
    })
    expect(fresh.get('a')?.fiveHour?.percent).toBe(40)
    const old = await fetchClaudePoolUsage([account({ accountUuid: 'a' })], {
      now: NOW + CLAUDE_USAGE_FRESH_MS, cacheFile, cachedOnly: true,
    })
    expect(old.get('a')?.fiveHour).toBeNull()
    expect(old.get('a')?.weekly?.percent).toBe(70)
    rmSync(cacheFile)
  }
})

test('a delayed process cannot overwrite newer observations or resurrect a removed cached account', async () => {
  const accounts = [account({ accountUuid: 'a' }), account({ accountUuid: 'removed' })]
  await fetchClaudePoolUsage(accounts, {
    now: NOW, cacheFile, fetchUsage: async () => reading(10, 10),
  })
  const modulePath = new URL('./claudePoolUsage.ts', import.meta.url).href
  const child = Bun.spawn([process.execPath, '-e', `
    const { fetchClaudePoolUsage } = await import(${JSON.stringify(modulePath)});
    let waiting = false;
    await fetchClaudePoolUsage(${JSON.stringify(accounts)}, {
      now: ${NOW + CLAUDE_USAGE_FRESH_MS}, cacheFile: ${JSON.stringify(cacheFile)},
      fetchUsage: async () => {
        if (!waiting) {
          waiting = true;
          process.stdout.write('ready\\n');
          await Bun.stdin.stream().getReader().read();
        }
        return ${JSON.stringify(reading(20, 20))};
      },
    });
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  try {
    const reader = child.stdout.getReader()
    const ready = await reader.read()
    expect(new TextDecoder().decode(ready.value)).toContain('ready')
    await fetchClaudePoolUsage([accounts[0]!, account({ accountUuid: 'new' })], {
      now: NOW + 2 * CLAUDE_USAGE_FRESH_MS, cacheFile,
      fetchUsage: async () => reading(90, 90),
    })
    child.stdin.write('continue\n')
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe('')
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8')).accounts
    expect(saved.a.fiveHour.percent).toBe(90)
    expect(saved.new.fiveHour.percent).toBe(90)
    expect(saved.removed).toBeUndefined()
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})
