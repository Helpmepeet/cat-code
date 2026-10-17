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
import { mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
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
    fetchedAt: z.number().finite().min(0),
    fiveHour: windowSchema.nullable(),
    weekly: windowSchema.nullable(),
  })
  .strict()
const cacheSchema = z
  .object({
    version: z.literal(1),
    accounts: z.record(z.string().min(1).max(256), entrySchema),
  })
  .strict()
// Declared rather than inferred: without root strict mode zod infers every
// field optional, though the schema requires each one.
type CacheEntry = {
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
    JSON.stringify({ version: 1, accounts }),
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
): ClaudeUsageWindow | null {
  if (!window) return null
  return window.resetAt !== null && window.resetAt * 1000 <= now ? null : window
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
    fetchUsage?: (accessToken: string) => Promise<Utilization>
  } = {},
): Promise<Map<string, ClaudeAccountUsage>> {
  const now = options.now ?? Date.now()
  const cacheFile = options.cacheFile ?? defaultCacheFile()
  const fetchUsage = options.fetchUsage ?? fetchUtilizationForToken
  const cached = readCache(cacheFile)
  const next: Record<string, CacheEntry> = {}
  let changed = false

  await Promise.all(
    accounts.map(async account => {
      let entry = cached[account.accountUuid]
      const stale = !entry || now - entry.fetchedAt >= CLAUDE_USAGE_FRESH_MS
      if (!options.cachedOnly && stale && canRead(account, now)) {
        try {
          const data = await fetchUsage(account.accessToken)
          entry = {
            fetchedAt: now,
            fiveHour: toWindow(data.five_hour),
            weekly: toWindow(data.seven_day),
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
      await writeCache(cacheFile, next)
    } catch {
      // A display cache that cannot be written only costs a re-read next time.
    }
  }

  const usage = new Map<string, ClaudeAccountUsage>()
  for (const [id, entry] of Object.entries(next)) {
    const fiveHour = current(entry.fiveHour, now)
    const weekly = current(entry.weekly, now)
    if (fiveHour || weekly) usage.set(id, { fiveHour, weekly })
  }
  return usage
}
