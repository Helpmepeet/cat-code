/**
 * Private, disposable observations shared by engine processes. This owns no
 * credentials or routing decisions: callers still supply their own inventory,
 * make authenticated requests, and apply hints to their process-local pool.
 */
import { createHash, randomUUID } from 'crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readSync, statSync, unlinkSync,
} from 'fs'
import { join } from 'path'
import { z } from 'zod/v4'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { writeFileAtomicDurable, writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { lock } from '../../utils/lockfile.js'
import type { PoolAccount } from './codexAccountPool.js'
import type { PoolUsageSnapshot } from './codexUsage.js'

export const SHARED_USAGE_TTL_MS = 60_000
const MAX_CACHE_BYTES = 256 * 1024
const CACHE_FILE = 'observation.json'
const EPOCH_FILE = 'epoch'
let directoryForTest: string | null | undefined
const disabledDirectories = new Set<string>()

/** null disables disk access for tests of the existing in-process behavior. */
export function setSharedUsageCacheDirectoryForTest(directory: string | null | undefined): void {
  directoryForTest = directory
  if (directory) disabledDirectories.delete(directory)
}

function cacheDirectory(): string | null {
  return directoryForTest === undefined
    ? join(getClaudeConfigHomeDir(), 'cache', 'codex-usage')
    : directoryForTest
}

const finite = z.number().finite().nonnegative()
const windowSchema = z.object({
  usedPercent: finite,
  limitWindowSeconds: finite,
  resetAfterSeconds: finite,
  resetAt: finite,
}).strict()
const snapshotSchema = z.object({
  accounts: z.array(z.object({
    accountId: z.string().min(1).max(256),
    // Existing Reset UI uses these normalized identity fields. They remain
    // private (0700 directory / 0600 record), never logs or host messages.
    userId: z.string().max(256),
    email: z.string().max(320),
    planType: z.string().max(128),
    allowed: z.boolean(),
    limitReached: z.boolean(),
    primaryWindow: windowSchema,
    secondaryWindow: windowSchema,
    hasSecondaryWindow: z.boolean().optional(),
    credits: z.object({
      hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().max(64),
    }).strict(),
    resetCreditsAvailable: finite.optional(),
    fetchedAt: finite,
  }).strict()).min(1).max(128),
  fetchedAt: finite,
  // Failed reads remain in the process-local cache only. Never persist error
  // text, which can contain transport details or arbitrary response content.
  errors: z.array(z.never()).length(0),
}).strict()
const recordSchema = z.object({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  epoch: z.string().max(64),
  startedAt: finite,
  snapshot: snapshotSchema,
}).strict()
type CacheRecord = z.infer<typeof recordSchema>

export type SharedUsageContext = {
  directory: string
  scope: string
  epoch: string
  accountIds: string[]
}
export type SharedUsageObservation = { snapshot: PoolUsageSnapshot; startedAt: number }

/** Bound reads before parsing, reject links and publicly readable records. */
function readPrivateFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0) return null
    if (process.getuid && stat.uid !== process.getuid()) return null
    const buffer = Buffer.alloc(maxBytes + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    return size > maxBytes ? null : buffer.subarray(0, size).toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readEpoch(directory: string): string | null {
  const epoch = readPrivateFile(join(directory, EPOCH_FILE), 64)
  return epoch === '' || (epoch !== null && /^[a-f0-9-]{36}$/.test(epoch)) ? epoch : null
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Unavailable private usage cache directory')
  }
}

function fileRevision(path: string): string {
  try {
    const stat = statSync(path, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch {
    return 'missing'
  }
}

export function getUsageInventoryKey(accounts: readonly PoolAccount[]): string {
  const inventory = accounts.map(account => [
    account.accountId, account.accessToken, account.refreshToken,
    account.source, account.vaultFilePath ?? '',
  ]).sort((a, b) => a[0]!.localeCompare(b[0]!))
  return createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
}

/**
 * Changing inventory or credentials changes the scope without copying secrets
 * to disk. Durable file revisions also reject a cache held by a process whose
 * in-memory credentials have not caught up with a deletion/rotation yet.
 */
export function getSharedUsageContext(
  accounts: readonly PoolAccount[],
  backend: string,
): SharedUsageContext | null {
  const directory = cacheDirectory()
  if (directory === null || disabledDirectories.has(directory) || accounts.length === 0 || accounts.length > 128) return null
  const epoch = readEpoch(directory)
  if (epoch === null) return null
  const revisions = accounts.map(account => [
    account.accountId,
    fileRevision(account.vaultFilePath ?? getGlobalClaudeFile()),
  ]).sort((a, b) => a[0]!.localeCompare(b[0]!))
  return {
    directory,
    scope: createHash('sha256').update(JSON.stringify([backend, getUsageInventoryKey(accounts), revisions])).digest('hex'),
    epoch,
    accountIds: accounts.map(account => account.accountId).sort(),
  }
}

export function sameSharedUsageContext(a: SharedUsageContext | null, b: SharedUsageContext | null): boolean {
  return a === b || (a !== null && b !== null && a.directory === b.directory && a.scope === b.scope && a.epoch === b.epoch)
}

function readRecord(context: SharedUsageContext): CacheRecord | null {
  const raw = readPrivateFile(join(context.directory, CACHE_FILE), MAX_CACHE_BYTES)
  if (!raw) return null
  try {
    const result = recordSchema.safeParse(JSON.parse(raw))
    if (!result.success) return null
    const record = result.data
    const now = Date.now()
    if (record.scope !== context.scope || record.epoch !== context.epoch ||
      record.startedAt > performance.timeOrigin + performance.now() ||
      record.snapshot.fetchedAt > now || now - record.snapshot.fetchedAt >= SHARED_USAGE_TTL_MS ||
      record.snapshot.accounts.some(account => account.fetchedAt > now) ||
      JSON.stringify(record.snapshot.accounts.map(account => account.accountId).sort()) !== JSON.stringify(context.accountIds)) return null
    return record
  } catch {
    return null
  }
}

async function acquireCacheLock(path: string, fetching: boolean): Promise<{ release: () => Promise<void>; intact: () => boolean }> {
  let compromised = false
  const retries = fetching ? 30 : 8
  for (let attempt = 0; ; attempt++) {
    try {
      const release = await lock(path, {
        realpath: false, stale: 30_000, update: 5_000,
        onCompromised: () => { compromised = true },
      })
      return { release, intact: () => !compromised }
    } catch (error) {
      // Wait only for an owner that can actually finish. Permission or disk
      // failures cannot improve through retries and should fall back promptly.
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || attempt >= retries) throw error
      const delay = fetching ? Math.min(50 * 1.2 ** attempt, 400) : Math.min(20 * 1.5 ** attempt, 100)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function publish(
  context: SharedUsageContext,
  observation: SharedUsageObservation,
  isCurrent: () => boolean,
): Promise<void> {
  let held: Awaited<ReturnType<typeof acquireCacheLock>> | undefined
  try {
    const record = recordSchema.safeParse({ version: 1, scope: context.scope, epoch: context.epoch, ...observation })
    if (!record.success) return
    const encoded = JSON.stringify(record.data)
    if (Buffer.byteLength(encoded) > MAX_CACHE_BYTES) return
    ensurePrivateDirectory(context.directory)
    // Publication has a separate short lock. A forced read never waits for
    // the unforced owner's network request (or its 10s response deadline).
    held = await acquireCacheLock(join(context.directory, CACHE_FILE), false)
    if (!held.intact() || !isCurrent() || readEpoch(context.directory) !== context.epoch) return
    const previous = readRecord(context)
    if (previous && previous.startedAt > observation.startedAt) return
    await writeFileAtomicDurable(join(context.directory, CACHE_FILE), encoded, { mode: 0o600 })
    // Invalidation may race the atomic rename; that is safe because every
    // record carries its old epoch and every reader checks the current epoch.
  } catch {
    // An optional cache must never turn a successful observation into failure.
  } finally {
    await held?.release().catch(() => {})
  }
}

export async function readOrFetchSharedUsage(
  context: SharedUsageContext | null,
  forceRefresh: boolean,
  fetchSnapshot: () => Promise<PoolUsageSnapshot>,
  isCurrent: () => boolean,
): Promise<SharedUsageObservation> {
  const fetchOwn = async (): Promise<SharedUsageObservation> => {
    const startedAt = performance.timeOrigin + performance.now()
    const snapshot = await fetchSnapshot()
    const observation = { snapshot, startedAt }
    if (context && isCurrent()) await publish(context, observation, isCurrent)
    return observation
  }
  if (!context || forceRefresh) return fetchOwn()
  const cached = readRecord(context)
  if (cached) return cached
  let held: Awaited<ReturnType<typeof acquireCacheLock>> | undefined
  try {
    ensurePrivateDirectory(context.directory)
    held = await acquireCacheLock(join(context.directory, 'fetch'), true)
  } catch {
    // Lock contention/failure is bounded; fall back to the existing live read.
    return fetchOwn()
  }
  try {
    const afterWait = readRecord(context)
    if (afterWait && isCurrent()) return afterWait
    const startedAt = performance.timeOrigin + performance.now()
    const snapshot = await fetchSnapshot()
    const observation = { snapshot, startedAt }
    if (held.intact() && isCurrent()) await publish(context, observation, isCurrent)
    return observation
  } finally {
    await held.release().catch(() => {})
  }
}

/** Synchronous epoch publication matches invalidateUsageCache's contract. */
export function invalidateSharedUsageCache(): void {
  const directory = cacheDirectory()
  if (directory === null) return
  try {
    ensurePrivateDirectory(directory)
    writeFileAtomicDurableSync(join(directory, EPOCH_FILE), randomUUID(), { mode: 0o600 })
  } catch {
    // If epoch replacement failed but eviction remains possible, prevent other
    // processes from consuming the old observation. If storage refuses BOTH
    // operations, cross-process invalidation is unavailable until its TTL;
    // local fencing and forced requests still work.
    try { unlinkSync(join(directory, CACHE_FILE)) } catch {}
    // No new shared reads/writes in this process if invalidation cannot be
    // published. Local generation fencing continues to work without the cache.
    disabledDirectories.add(directory)
  }
}
