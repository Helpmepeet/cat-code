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
  })
  expect(usage.get('b')?.fiveHour?.percent).toBe(100)
  expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
  expect(readFileSync(cacheFile, 'utf8')).not.toContain('token-')
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
    version: 1,
    accounts: {},
  })
})
