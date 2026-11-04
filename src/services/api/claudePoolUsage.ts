/**
 * Per-account usage for the Claude subscription pool, read for display only.
 *
 * Each account is read with its OWN stored access token. Nothing here refreshes
 * a token: only the active account's token is kept fresh by the request path,
 * so an idle account's live read stops once its token expires. Its last reading
 * stays valid until that window's reset time, which is why observations are
 * kept in a private on-disk cache. The cache also bounds how often a 60 s
 * caller polls Anthropic per account.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { lock } from '../../utils/lockfile.js'
import type { ClaudePoolAccount } from './claudeAccountPool.js'
import { fetchUtilizationForToken, type Utilization } from './usage.js'

export type ClaudeUsageWindow = {
  /** Used percentage, 0 to 100. */
  percent: number | null
  /** Unix seconds. */
  resetAt: number | null
}

export type ClaudeAccountUsage = {
  fiveHour: ClaudeUsageWindow | null
  weekly: ClaudeUsageWindow | null
  weeklyOpus?: ClaudeUsageWindow | null
  weeklySonnet?: ClaudeUsageWindow | null
  extraUsage?: {
    usedCredits: number | null
    monthlyLimit: number | null
    isEnabled: boolean | null
  } | null
  /** Epoch milliseconds of the last successful observation. */
  checkedAt?: number
  stale?: boolean
}

/** A cached reading younger than this is reused instead of asking again. */
export const CLAUDE_USAGE_FRESH_MS = 3 * 60_000

const windowSchema = z
  .object({
    percent: z.number().finite().min(0).nullable(),
    resetAt: z.number().finite().min(0).nullable(),
  })
  .strict()
const entrySchema = z
  .object({
    credentialKey: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.number().finite().min(0),
    fiveHour: windowSchema.nullable(),
    weekly: windowSchema.nullable(),
    weeklyOpus: windowSchema.nullable().optional(),
    weeklySonnet: windowSchema.nullable().optional(),
    extraUsage: z.object({
      usedCredits: z.number().finite().min(0).nullable(),
      monthlyLimit: z.number().finite().min(0).nullable(),
      isEnabled: z.boolean().nullable(),
    }).strict().nullable().optional(),
    checkedAt: z.number().finite().min(0).optional(),
    stale: z.boolean().optional(),
  })
  .strict()
const cacheSchema = z
  .object({
    version: z.literal(2),
    accounts: z.record(z.string().min(1).max(256), entrySchema),
  })
  .strict()
// Declared rather than inferred: without root strict mode zod infers every
// field optional, though the schema requires each one.
type CacheEntry = ClaudeAccountUsage & {
  credentialKey: string
  fetchedAt: number
  fiveHour: ClaudeUsageWindow | null
  weekly: ClaudeUsageWindow | null
}

function defaultCacheFile(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'claude-usage.json')
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success
      ? (parsed.data.accounts as Record<string, CacheEntry>)
      : {}
  } catch {
    return {}
  }
}

async function writeCache(
  file: string,
  accounts: Record<string, CacheEntry>,
): Promise<void> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  await writeFileAtomicDurable(
    file,
    JSON.stringify({ version: 2, accounts }),
    { mode: 0o600 },
  )
}

function toWindow(
  limit: Utilization['five_hour'],
): ClaudeUsageWindow | null {
  if (!limit) return null
  const percent =
    typeof limit.utilization === 'number' && Number.isFinite(limit.utilization)
      ? Math.max(0, Math.round(limit.utilization))
      : null
  const resetMs = limit.resets_at ? Date.parse(limit.resets_at) : NaN
  const resetAt = Number.isFinite(resetMs) ? Math.floor(resetMs / 1000) : null
  return percent === null && resetAt === null ? null : { percent, resetAt }
}

/** A window that has reset no longer describes current usage. */
function current(
  window: ClaudeUsageWindow | null,
  now: number,
  fetchedAt: number,
): ClaudeUsageWindow | null {
  if (!window) return null
  return window.resetAt === null
    ? (now - fetchedAt < CLAUDE_USAGE_FRESH_MS ? window : null)
    : (window.resetAt * 1000 <= now ? null : window)
}

/** Same five-minute margin as `isOAuthTokenExpired`, against the caller's clock. */
const EXPIRY_MARGIN_MS = 5 * 60_000

function canRead(account: ClaudePoolAccount, now: number): boolean {
  return (
    account.status === 'healthy' &&
    account.accessToken.length > 0 &&
    account.expiresAt - EXPIRY_MARGIN_MS > now &&
    (account.scopes === undefined || account.scopes.includes('user:profile'))
  )
}

/**
 * Usage for each pool account that has a current reading, keyed by account
 * UUID. Best-effort per account: a failed read keeps that account's cached
 * reading and never fails the whole call.
 */
export async function fetchClaudePoolUsage(
  accounts: readonly ClaudePoolAccount[],
  options: {
    now?: number
    cacheFile?: string
    cachedOnly?: boolean
    /** Bypass observation freshness, but never credential eligibility or cachedOnly. */
    force?: boolean
    /** Restrict network reads only; all supplied accounts retain cached results. */
    accountIds?: readonly string[]
    fetchUsage?: (
      accessToken: string,
      credential: { accountUuid: string; lifecycleGeneration: number; credentialRevision?: number },
    ) => Promise<Utilization>
  } = {},
): Promise<Map<string, ClaudeAccountUsage>> {
  const now = options.now ?? Date.now()
  const cacheFile = options.cacheFile ?? defaultCacheFile()
  const fetchUsage = options.fetchUsage ?? fetchUtilizationForToken
  const cached = readCache(cacheFile)
  const refreshIds = options.accountIds === undefined
    ? undefined : new Set(options.accountIds)
  const credentialKeys = new Map(accounts.map(account => [
    account.accountUuid,
    createHash('sha256').update(JSON.stringify([account.accountUuid, account.accessToken])).digest('hex'),
  ]))
  const next: Record<string, CacheEntry> = {}
  let changed = false

  await Promise.all(
    accounts.map(async account => {
      let entry = cached[account.accountUuid]
      const credentialKey = credentialKeys.get(account.accountUuid)!
      if (entry?.credentialKey !== credentialKey) entry = undefined
      const stale = !entry || now - entry.fetchedAt >= CLAUDE_USAGE_FRESH_MS
      if (!options.cachedOnly &&
          (options.force || stale) &&
          (refreshIds === undefined || refreshIds.has(account.accountUuid)) &&
          canRead(account, now)) {
        try {
          const data = await fetchUsage(account.accessToken, {
            accountUuid: account.accountUuid,
            lifecycleGeneration: account.lifecycleGeneration ?? 0,
            credentialRevision: account.credentialRevision ?? 0,
          })
          entry = {
            credentialKey,
            fetchedAt: now,
            fiveHour: toWindow(data.five_hour),
            weekly: toWindow(data.seven_day),
            weeklyOpus: toWindow(data.seven_day_opus),
            weeklySonnet: toWindow(data.seven_day_sonnet),
            extraUsage: data.extra_usage ? {
              usedCredits: nonnegative(data.extra_usage.used_credits),
              monthlyLimit: nonnegative(data.extra_usage.monthly_limit),
              isEnabled: typeof data.extra_usage.is_enabled === 'boolean'
                ? data.extra_usage.is_enabled : null,
            } : null,
            checkedAt: now,
            stale: false,
          }
          changed = true
        } catch {
          // Keep the previous reading; it is still bounded by its reset time.
        }
      }
      if (entry) next[account.accountUuid] = entry
    }),
  )

  if (Object.keys(cached).some(id => !(id in next))) changed = true
  if (changed) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 })
      const release = await lock(cacheFile, {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        retries: { retries: 100, minTimeout: 20, maxTimeout: 100 },
      })
      try {
        const latest = readCache(cacheFile)
        const merged = { ...latest }
        for (const id of Object.keys(cached)) {
          if (!(id in next) && latest[id]?.fetchedAt === cached[id]?.fetchedAt) {
            delete merged[id]
          }
        }
        for (const [id, entry] of Object.entries(next)) {
          // A concurrent removal wins over a refresh based on the old cache.
          if (cached[id] && !latest[id]) continue
          if (!latest[id] || entry.fetchedAt > latest[id].fetchedAt) {
            merged[id] = entry
          }
        }
        await writeCache(cacheFile, merged)
        for (const id of Object.keys(next)) {
          if (merged[id]) next[id] = merged[id]
          else delete next[id]
        }
      } finally {
        await release()
      }
    } catch {
      // A display cache that cannot be written only costs a re-read next time.
    }
  }

  const usage = new Map<string, ClaudeAccountUsage>()
  for (const [id, entry] of Object.entries(next)) {
    if (entry.credentialKey !== credentialKeys.get(id)) continue
    const fiveHour = current(entry.fiveHour, now, entry.fetchedAt)
    const weekly = current(entry.weekly, now, entry.fetchedAt)
    const weeklyOpus = current(entry.weeklyOpus ?? null, now, entry.fetchedAt)
    const weeklySonnet = current(entry.weeklySonnet ?? null, now, entry.fetchedAt)
    if (fiveHour || weekly || weeklyOpus || weeklySonnet || entry.extraUsage) {
      usage.set(id, {
        fiveHour, weekly, weeklyOpus, weeklySonnet,
        extraUsage: entry.extraUsage ?? null,
        checkedAt: entry.checkedAt ?? entry.fetchedAt,
        stale: now - entry.fetchedAt >= CLAUDE_USAGE_FRESH_MS,
      })
    }
  }
  return usage
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : null
}
