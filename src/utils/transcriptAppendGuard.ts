import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { lock, lockSync } from './lockfile.js'
import { sleep } from './sleep.js'
import { isHandoffUuid } from '../../app/shared/workspaceHandoff.js'
import { assertSessionNotMoving } from './sessionRelocationState.js'

export type TranscriptFraming = { boundary: number; suffix: Buffer; needsSeparator: boolean }
export const canonicalTranscriptPath = (path: string) => join(realpathSync(dirname(path)), basename(path))
const held = new Map<string, { dev: number; ino: number }>()
const readHolders = new Set<string>()

export function assertTranscriptAppendGuard(path: string): void {
  const key = canonicalTranscriptPath(path)
  const expected = held.get(key)
  const actual = lstatSync(`${key}.append.lock`)
  if (!expected || expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error('Transcript append exclusion was lost')
  const sessionId = basename(path, '.jsonl')
  if (isHandoffUuid(sessionId)) assertSessionNotMoving(sessionId)
}

/** Byte offsets are retained even for invalid UTF-8 in an unfinished record. */
export function inspectTranscriptFraming(bytes: Buffer): TranscriptFraming {
  let start = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parse = (line: Buffer) => {
    const text = decoder.decode(line)
    if (!text.trim()) return
    const row: unknown = JSON.parse(text)
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid transcript record')
  }
  for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
    try { parse(bytes.subarray(start, end)) }
    catch (cause) { throw new Error('Transcript contains a malformed terminated record; recovery refused', { cause }) }
    start = end + 1
  }
  if (start === bytes.length) return { boundary: start, suffix: Buffer.alloc(0), needsSeparator: false }
  try {
    parse(bytes.subarray(start))
    return { boundary: bytes.length, suffix: Buffer.alloc(0), needsSeparator: true }
  } catch {
    return { boundary: start, suffix: bytes.subarray(start), needsSeparator: false }
  }
}

export function openPrivateTranscript(path: string, flags: number, requirePrivate = true): number {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (requirePrivate && (before.mode & 0o077) !== 0) ||
    (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error('Unsafe transcript file')
  const fd = openSync(path, flags | constants.O_NOFOLLOW)
  try {
    const after = fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) throw new Error('Transcript identity changed')
    return fd
  } catch (error) { closeSync(fd); throw error }
}

export function readTranscriptDescriptor(fd: number): Buffer {
  const size = fstatSync(fd).size
  if (size > 512 * 1024 * 1024) throw new Error('Transcript exceeds safe inspection budget')
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset)
    if (!count) throw new Error('Transcript changed during read')
    offset += count
  }
  if (fstatSync(fd).size !== size) throw new Error('Transcript changed during read')
  return bytes
}

/** Strict JSONL validation with memory bounded by a single record, not history size. */
export function scanTranscriptDescriptor(
  fd: number,
  onRecord?: (row: Record<string, unknown>, bytes: Buffer) => void,
): TranscriptFraming {
  const size = fstatSync(fd).size
  const chunk = Buffer.alloc(64 * 1024)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let parts: Buffer[] = []
  let retained = 0
  let boundary = 0
  const add = (bytes: Buffer) => {
    retained += bytes.length
    if (retained > 128 * 1024 * 1024) throw new Error('A transcript record exceeds the strict inspection budget')
    if (bytes.length) parts.push(bytes)
  }
  const parse = (bytes: Buffer): Record<string, unknown> | undefined => {
    const text = decoder.decode(bytes)
    if (!text.trim()) return
    const row: unknown = JSON.parse(text)
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid transcript record')
    return row as Record<string, unknown>
  }
  for (let offset = 0; offset < size;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset)
    if (!count) throw new Error('Transcript changed during inspection')
    let start = 0
    for (let end = chunk.indexOf(10, start); end >= 0 && end < count; end = chunk.indexOf(10, start)) {
      add(Buffer.from(chunk.subarray(start, end)))
      const line = Buffer.concat(parts, retained)
      try {
        const row = parse(line)
        if (row) onRecord?.(row, line)
      } catch (cause) {
        throw new Error('Transcript contains a malformed terminated record; recovery refused', { cause })
      }
      parts = []; retained = 0
      boundary = offset + end + 1
      start = end + 1
    }
    add(Buffer.from(chunk.subarray(start, count)))
    offset += count
  }
  if (fstatSync(fd).size !== size) throw new Error('Transcript changed during inspection')
  const suffix = Buffer.concat(parts, retained)
  if (!suffix.length) return { boundary: size, suffix, needsSeparator: false }
  let row: Record<string, unknown> | undefined
  try { row = parse(suffix) } catch {
    return { boundary, suffix, needsSeparator: false }
  }
  if (row) onRecord?.(row, suffix)
  return { boundary: size, suffix: Buffer.alloc(0), needsSeparator: true }
}

export function hashTranscriptDescriptorPrefix(fd: number, prefixBytes: number): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  if (fstatSync(fd).size < prefixBytes) throw new Error('Transcript prefix is unavailable')
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(64 * 1024)
  for (let offset = 0; offset < prefixBytes;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, prefixBytes - offset), offset)
    if (!count) throw new Error('Transcript prefix is unavailable')
    hash.update(chunk.subarray(0, count))
    offset += count
  }
  return hash.digest('hex')
}

export function writeTranscriptBytes(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!count) throw new Error('Incomplete transcript write')
    offset += count
  }
}

/** Ownership cannot be released between validation and this synchronous mutation. */
export function replacePrivateTranscriptWithinGuard(path: string, data: string, assertHealthy: () => void): void {
  assertTranscriptAppendGuard(path)
  assertHealthy()
  let fd: number
  try { fd = openPrivateTranscript(path, constants.O_RDWR) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  }
  try {
    const current = lstatSync(path)
    const opened = fstatSync(fd)
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Transcript identity changed before replacement')
    ftruncateSync(fd, 0)
    writeTranscriptBytes(fd, Buffer.from(data))
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

/** Framing only. Whole-history integrity is checked at owned resume/proof boundaries. */
export function inspectTranscriptAppendBoundary(fd: number): { needsSeparator: boolean } {
  const size = fstatSync(fd).size
  if (!size) return { needsSeparator: false }
  const last = Buffer.alloc(1)
  if (readSync(fd, last, 0, 1, size - 1) !== 1) throw new Error('Transcript changed during boundary inspection')
  if (last[0] === 10) return { needsSeparator: false }
  const limit = 8 * 1024 * 1024
  const chunks: Buffer[] = []
  let offset = size
  let retained = 0
  while (offset > 0) {
    const count = Math.min(offset, 64 * 1024, limit - retained)
    if (!count) throw new Error('Unterminated transcript record exceeds safe boundary inspection budget')
    const chunk = Buffer.alloc(count)
    offset -= count
    if (readSync(fd, chunk, 0, count, offset) !== count) throw new Error('Transcript changed during boundary inspection')
    const newline = chunk.lastIndexOf(10)
    const content = newline < 0 ? chunk : chunk.subarray(newline + 1)
    chunks.unshift(content)
    retained += content.length
    if (newline >= 0 || offset === 0) break
  }
  const framing = inspectTranscriptFraming(Buffer.concat(chunks))
  if (framing.suffix.length) throw new Error('Transcript has an unfinished record; owned recovery is required')
  return { needsSeparator: framing.needsSeparator }
}

// All current sync and async appenders use this resource lock. It does not
// claim exclusion against older binaries or arbitrary filesystem writers.
export function withTranscriptAppendGuardSync<T>(path: string, action: () => T): T {
  const key = canonicalTranscriptPath(path)
  if (readHolders.has(key)) return action()
  const release = lockSync(`${key}.append`, { realpath: false, retries: 0, stale: 120_000 })
  held.set(key, lstatSync(`${key}.append.lock`))
  try { return action() } finally { held.delete(key); release() }
}

export async function withTranscriptAppendGuard<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = canonicalTranscriptPath(path)
  const release = await lock(`${key}.append`, { realpath: false,
    retries: { retries: 40, factor: 1.2, minTimeout: 5, maxTimeout: 100 }, stale: 120_000 })
  held.set(key, lstatSync(`${key}.append.lock`))
  try { return await action() } finally { held.delete(key); await release() }
}

/** Never repairs damaged bytes. Mutation of an incomplete tail needs owned preflight. */
export function appendFramedTranscriptSync(path: string, data: string): void {
  withTranscriptAppendGuardSync(path, () => appendFramedTranscriptWithinGuard(path, data))
}

async function retryWhileLocked<T>(attempt: () => T): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return attempt() }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || retry >= 40) throw error
      await sleep(Math.min(100, 5 * 1.2 ** retry))
    }
  }
}

// Takes the lock for one synchronous step: sync appenders cannot wait on an
// async holder in their own process, so they must never find the lock taken by
// a routine append. The retries only cover other holders.
export function appendFramedTranscript(path: string, data: string): Promise<void> {
  return retryWhileLocked(() => appendFramedTranscriptSync(path, data))
}

// For holders that only read a prefix fixed by their own stat. The lock keeps
// other processes out. Appends from this process land whole, past that prefix,
// so they proceed under this lock instead of failing. It is taken and released
// synchronously so no append can arrive while it changes hands.
export async function withTranscriptReadGuard<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = canonicalTranscriptPath(path)
  const release = await retryWhileLocked(() => lockSync(`${key}.append`, { realpath: false, retries: 0, stale: 120_000 }))
  held.set(key, lstatSync(`${key}.append.lock`))
  readHolders.add(key)
  try { return await action() } finally { readHolders.delete(key); held.delete(key); release() }
}

export function appendFramedTranscriptWithinGuard(path: string, data: string): void {
  assertTranscriptAppendGuard(path)
  let fd: number
  try { fd = openPrivateTranscript(path, constants.O_RDWR | constants.O_APPEND, false) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  }
  try {
    const framing = inspectTranscriptAppendBoundary(fd)
    assertTranscriptAppendGuard(path)
    if (framing.needsSeparator) {
      writeTranscriptBytes(fd, Buffer.from('\n'))
      fsyncSync(fd)
    }
    writeTranscriptBytes(fd, Buffer.from(data))
  } finally { closeSync(fd) }
}
