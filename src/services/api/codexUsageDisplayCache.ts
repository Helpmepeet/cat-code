import { createHash } from 'crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { writeFileAtomicDurable } from '../../utils/atomicFile.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { lock } from '../../utils/lockfile.js'
import type { PoolAccount } from './codexAccountPool.js'
import type { PoolUsageSnapshot, UsageWindow } from './codexUsage.js'

export type CodexAccountDisplayUsage = {
  primaryWindow: UsageWindow | null
  secondaryWindow: UsageWindow | null
  fetchedAt: number
  stale: boolean
}

type Options = { cacheFile?: string; now?: number }
const MAX_BYTES = 256 * 1024
const MAX_ACCOUNTS = 128
const finite = z.number().finite().nonnegative()
const windowSchema = z.object({
  usedPercent: finite.max(100),
  limitWindowSeconds: finite,
  resetAfterSeconds: finite,
  resetAt: finite,
}).strict()
const entrySchema = z.object({
  accountId: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  fetchedAt: finite,
  primaryWindow: windowSchema.nullable(),
  secondaryWindow: windowSchema.nullable(),
}).strict()
const recordSchema = z.object({
  version: z.literal(1),
  accounts: z.array(entrySchema).max(MAX_ACCOUNTS),
}).strict()
type Entry = z.infer<typeof entrySchema>

function location(options: Options): string {
  return options.cacheFile ?? join(getClaudeConfigHomeDir(), 'cache', 'codex-usage-display', 'observation.json')
}

function privateDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory)
    return stat.isDirectory() && (stat.mode & 0o077) === 0 &&
      (!process.getuid || stat.uid === process.getuid())
  } catch {
    return false
  }
}

function identity(account: PoolAccount): string {
  return createHash('sha256').update(JSON.stringify([
    account.accountId, account.source, account.vaultFilePath ?? '',
  ])).digest('hex')
}

function usable(account: PoolAccount): boolean {
  return Number.isSafeInteger(account.credentialGeneration) && account.credentialGeneration > 0 &&
    account.status !== 'dead' && account.status !== 'quarantined' && !!account.accessToken &&
    account.accountId.length > 0 && account.accountId.length <= 256
}

function windowAt(window: UsageWindow | null, now: number): UsageWindow | null {
  if (!window || window.limitWindowSeconds <= 0 || window.resetAt <= now / 1000) return null
  return { ...window, resetAfterSeconds: Math.max(0, Math.ceil(window.resetAt - now / 1000)) }
}

function readEntries(file: string, accounts: readonly PoolAccount[], now: number): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  if (!privateDirectory(dirname(file))) return entries
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) return entries
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > MAX_BYTES) return entries
    const record = recordSchema.safeParse(JSON.parse(buffer.subarray(0, size).toString('utf8')))
    if (!record.success) return entries
    const inventory = new Map(accounts.filter(usable).map(account => [account.accountId, account]))
    for (const entry of record.data.accounts) {
      const account = inventory.get(entry.accountId)
      if (!account || account.credentialGeneration !== entry.generation || identity(account) !== entry.identity ||
        entry.fetchedAt > now) continue
      entries.set(entry.accountId, {
        ...entry,
        primaryWindow: windowAt(entry.primaryWindow, now),
        secondaryWindow: windowAt(entry.secondaryWindow, now),
      })
    }
  } catch {
    // This derived cache is optional, including when private storage is unavailable.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return entries
}

function display(entries: Map<string, Entry>, fresh = new Set<string>()): Map<string, CodexAccountDisplayUsage> {
  return new Map([...entries].map(([id, entry]) => [id, {
    primaryWindow: entry.primaryWindow,
    secondaryWindow: entry.secondaryWindow,
    fetchedAt: entry.fetchedAt,
    stale: !fresh.has(id),
  }]))
}

/** Cached observations are display data only, never pool hints or availability. */
export function readCodexUsageDisplayCache(
  accounts: readonly PoolAccount[], options: Options = {},
): Map<string, CodexAccountDisplayUsage> {
  return display(readEntries(location(options), accounts, options.now ?? Date.now()))
}

export async function updateCodexUsageDisplayCache(
  accounts: readonly PoolAccount[], snapshot: PoolUsageSnapshot, options: Options = {},
): Promise<Map<string, CodexAccountDisplayUsage>> {
  const file = location(options)
  const now = options.now ?? Date.now()
  const merge = (entries: Map<string, Entry>) => {
    const fresh = new Set<string>()
    for (const account of accounts.slice(0, MAX_ACCOUNTS)) {
      if (!usable(account)) continue
      const observation = snapshot.accounts.find(item => item.accountId === account.accountId)
      if (!observation || !Number.isFinite(observation.fetchedAt) || observation.fetchedAt < 0 ||
        observation.fetchedAt > now) continue
      const primary = windowSchema.safeParse(observation.primaryWindow)
      const secondary = windowSchema.safeParse(observation.secondaryWindow)
      if (!primary.success || (observation.hasSecondaryWindow !== false && !secondary.success)) continue
      const previous = entries.get(account.accountId)
      if (previous && previous.fetchedAt > observation.fetchedAt) continue
      // Persist empty successful readings too: an older completion must not revive pre-reset windows.
      entries.set(account.accountId, {
        accountId: account.accountId,
        generation: account.credentialGeneration,
        identity: identity(account),
        fetchedAt: observation.fetchedAt,
        primaryWindow: windowAt(primary.data, now),
        secondaryWindow: windowAt(observation.hasSecondaryWindow === false ? null : secondary.data!, now),
      })
      fresh.add(account.accountId)
    }
    return display(entries, fresh)
  }
  let release: (() => Promise<void>) | undefined
  let compromised = false
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if (!privateDirectory(dirname(file))) return merge(new Map())
    release = await lock(file, {
      realpath: false, stale: 30_000, update: 5_000,
      retries: { retries: 8, minTimeout: 20, maxTimeout: 100 },
      onCompromised: () => { compromised = true },
    })
    const entries = readEntries(file, accounts, now)
    const result = merge(entries)
    const encoded = JSON.stringify({ version: 1, accounts: [...entries.values()].slice(0, MAX_ACCOUNTS) })
    // Refuse links/public files rather than replacing another owner's storage.
    let safeTarget = true
    try {
      const stat = lstatSync(file)
      safeTarget = stat.isFile() && (stat.mode & 0o077) === 0 &&
        (!process.getuid || stat.uid === process.getuid())
    } catch (error) {
      safeTarget = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (safeTarget && !compromised && privateDirectory(dirname(file)) && Buffer.byteLength(encoded) <= MAX_BYTES) {
      await writeFileAtomicDurable(file, encoded, { mode: 0o600 })
    }
    return result
  } catch {
    return merge(readEntries(file, accounts, now))
  } finally {
    await release?.().catch(() => {})
  }
}
