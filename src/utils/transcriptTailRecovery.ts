import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isHandoffUuid, isWorkspaceHandoffExecutionRecord, type ResumeCheckpoint } from '../../app/shared/workspaceHandoff.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { assertOwnedTranscriptLease } from './transcriptLease.js'
import { readSessionRelocation } from './sessionRelocationState.js'
import { assertTranscriptAppendGuard, canonicalTranscriptPath, hashTranscriptDescriptorPrefix, openPrivateTranscript, readTranscriptDescriptor, scanTranscriptDescriptor, withTranscriptAppendGuard, withTranscriptAppendGuardSync, writeTranscriptBytes } from './transcriptAppendGuard.js'

export const RECOVERY_WARNING = 'The final saved record was incomplete. Earlier history was recovered and the damaged bytes were preserved. Review the saved progress before continuing.'
export const RECOVERY_CONTEXT = 'Saved history ended with an incomplete record. Wait for a genuine user message. Do not repeat uncertain tool actions automatically.'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const MAX_PROOFS = 128
const MAX_RECOVERY_BYTES = 512 * 1024 * 1024

type Manifest = {
  version: 1 | 2; sessionId: string; path: string; dev: number; ino: number
  originalSize: number; boundary: number; prefixSha256: string; suffixSha256: string
  warningUuid: string; contextUuid: string; parentUuid: string; timestamp: string
}
export type TailRecoveryState = { reviewRequired: boolean; warningUuid: string; contextUuid: string } | null
function evidenceBase(path: string): string {
  const canonical = canonicalTranscriptPath(path)
  const portable = join(dirname(canonical), basename(canonical, '.jsonl'), 'transcript-recovery')
  const legacy = `${canonical}.recovery`
  if (existsSync(portable) && existsSync(legacy)) throw new Error('Conflicting recovery evidence locations')
  return !existsSync(portable) && existsSync(legacy) ? legacy : portable
}
function rootFor(path: string): string {
  const base = evidenceBase(path)
  const pointer = join(base, 'current.json')
  if (!existsSync(pointer)) return base
  privateDirectory(base)
  const current: unknown = JSON.parse(privateBytes(pointer, 512).toString('utf8'))
  if (!current || typeof current !== 'object' || Array.isArray(current) ||
      Object.keys(current).length !== 1 || !('episode' in current) || !isHandoffUuid(current.episode)) {
    throw new Error('Invalid current recovery episode')
  }
  if (!existsSync(join(base, 'episodes'))) throw new Error('Saved recovery episode evidence is missing')
  privateDirectory(join(base, 'episodes'))
  const root = join(base, 'episodes', current.episode)
  if (!existsSync(root)) throw new Error('Saved recovery episode evidence is missing')
  privateDirectory(root)
  return root
}
export const transcriptRecoveryDirectory = rootFor
export function recoveryHistoryForFork<T extends object>(messages: readonly T[], state?: TailRecoveryState): T[] {
  if (state?.reviewRequired) throw new Error('Review the recovered history before creating a new branch')
  return messages.map(message => {
    if (!('transcriptRecovery' in message)) return message
    if (!state) throw new Error('A branch cannot discard unverified recovery evidence')
    const { transcriptRecovery: _sourceIdentity, ...historical } = message
    return historical as T
  })
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function privateDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Unsafe recovery directory')
}
function privateBytes(path: string, limit: number): Buffer {
  const fd = openPrivateTranscript(path, constants.O_RDONLY)
  try {
    if (fstatSync(fd).size > limit) throw new Error('Recovery evidence exceeds its budget')
    return readTranscriptDescriptor(fd)
  } finally { closeSync(fd) }
}
function publishExclusive(path: string, bytes: Buffer, beforeSync?: () => void): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeTranscriptBytes(fd, bytes); beforeSync?.(); fsyncSync(fd) } finally { closeSync(fd) }
  syncDirectory(dirname(path))
}
function readManifest(path: string, sessionId: string): Manifest | null {
  let root: string
  try { root = rootFor(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!existsSync(root)) return null
  privateDirectory(root)
  const value: unknown = JSON.parse(privateBytes(join(root, 'manifest.json'), 8192).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery manifest')
  const m = value as Manifest
  if (Object.keys(m).length !== 13 || ![1, 2].includes(m.version) || m.sessionId !== sessionId ||
    typeof m.path !== 'string' || !isAbsolute(m.path) || basename(m.path) !== `${sessionId}.jsonl` || basename(path) !== `${sessionId}.jsonl` ||
    ![m.dev, m.ino, m.originalSize, m.boundary].every(n => Number.isSafeInteger(n) && n >= 0) ||
    m.boundary >= m.originalSize || !/^[a-f0-9]{64}$/.test(m.prefixSha256) || !/^[a-f0-9]{64}$/.test(m.suffixSha256) ||
    !isHandoffUuid(m.warningUuid) || !isHandoffUuid(m.contextUuid) || !isHandoffUuid(m.parentUuid) ||
    typeof m.timestamp !== 'string' || !Number.isFinite(Date.parse(m.timestamp))) throw new Error('Invalid recovery manifest')
  if (m.path !== canonicalTranscriptPath(path)) {
    const relocation = readSessionRelocation(sessionId)
    // The same inode/prefix must also survive. Relocation is authority for
    // changing location, not authority to substitute a copied transcript.
    const { getProjectDir } = require('./sessionStorage.js') as typeof import('./sessionStorage.js')
    if (relocation?.phase !== 'complete' ||
      canonicalTranscriptPath(join(getProjectDir(relocation.target.cwd), `${sessionId}.jsonl`)) !== canonicalTranscriptPath(path) ||
      ![relocation.original, relocation.source, ...(relocation.transitions ?? []).flatMap(step => [step.source, step.target])]
        .some(location => canonicalTranscriptPath(join(getProjectDir(location.cwd), `${sessionId}.jsonl`)) === m.path)) {
      throw new Error('Recovery evidence has no verified relocation to this location')
    }
  }
  const tail = privateBytes(join(root, 'tail.bin'), MAX_RECOVERY_BYTES)
  if (tail.length !== m.originalSize - m.boundary || sha(tail) !== m.suffixSha256) throw new Error('Recovery backup differs')
  return m
}
function disclosure(m: Manifest): Buffer {
  const envelope = { sessionId: m.sessionId, timestamp: m.timestamp, isSidechain: false }
  return Buffer.from([
    { ...envelope, type: 'system', subtype: 'informational', uuid: m.warningUuid, parentUuid: m.parentUuid,
      content: RECOVERY_WARNING, level: 'warning', isMeta: false, preventContinuation: true,
      ...(m.version === 2 ? { transcriptRecovery: { version: 1, contextUuid: m.contextUuid } } : {}) },
    { ...envelope, type: 'user', uuid: m.contextUuid, parentUuid: m.warningUuid, isMeta: true,
      message: { role: 'user', content: RECOVERY_CONTEXT } },
    { type: 'active-conversation-tip', sessionId: m.sessionId, tipUuid: m.contextUuid },
  ].map(row => JSON.stringify(row) + '\n').join(''))
}

/** Bounded discovery is scoped to this engine session, never all live ledgers. */
function knownProofs(sessionId: string): ResumeCheckpoint[] {
  const parent = join(getClaudeConfigHomeDir(), 'workspace-handoff-executions')
  const directory = join(parent, sessionId)
  if (!existsSync(parent)) return []
  privateDirectory(parent)
  if (!existsSync(directory)) return []
  privateDirectory(directory)
  const names = readdirSync(directory)
  if (names.length > MAX_PROOFS) throw new Error('Too much local checkpoint evidence for automatic recovery')
  const proofs: ResumeCheckpoint[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || !isHandoffUuid(name.slice(0, -5))) throw new Error('Unrecognized local checkpoint evidence')
    const record: unknown = JSON.parse(privateBytes(join(directory, name), 16 * 1024).toString('utf8'))
    if (!isWorkspaceHandoffExecutionRecord(record) || record.engineSessionId !== sessionId || `${record.operationId}.json` !== name) {
      throw new Error('Invalid local checkpoint evidence')
    }
    for (const evidence of [record.terminal, record.notice, record.reconciliation]) if (evidence) proofs.push(evidence.checkpoint)
  }
  return proofs
}

export async function verifyKnownTranscriptCheckpoints(sessionId: string, verify: (checkpoint: ResumeCheckpoint) => Promise<void>): Promise<void> {
  for (const checkpoint of knownProofs(sessionId)) await verify(checkpoint)
}

/** Streaming top-level-key detection, never a message-content substring match. */
function transcriptHasRecoveryMarker(path: string): boolean {
  let fd: number
  try { fd = openPrivateTranscript(path, constants.O_RDONLY, false) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let depth = 0
    let inString = false
    let escaped = false
    let expectingKey = false
    let key: number[] | null = null
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) return false
      for (const byte of chunk.subarray(0, count)) {
        if (inString) {
          if (key && key.length <= 256) key.push(byte)
          if (escaped) { escaped = false; continue }
          if (byte === 92) { escaped = true; continue }
          if (byte === 34) {
            inString = false
            if (key && key.length <= 256 && JSON.parse(Buffer.from(key).toString('utf8')) === 'transcriptRecovery') return true
            key = null
          }
          continue
        }
        if (byte === 34) {
          inString = true
          key = depth === 1 && expectingKey ? [34] : null
        } else if (byte === 123 || byte === 91) {
          depth++
          expectingKey = depth === 1
        } else if (byte === 125 || byte === 93) depth--
        else if (byte === 58 && depth === 1) expectingKey = false
        else if (byte === 44 && depth === 1) expectingKey = true
      }
    }
  } finally { closeSync(fd) }
}

function readRange(fd: number, offset: number, length: number): Buffer {
  if (length < 0 || length > MAX_RECOVERY_BYTES) throw new Error('Recovery artifact exceeds its inspection budget')
  const bytes = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const count = readSync(fd, bytes, done, length - done, offset + done)
    if (!count) throw new Error('Incomplete recovery evidence')
    done += count
  }
  return bytes
}

function recoveryDisclosures(sessionId: string) {
  const seen = new Set<string>()
  let latest: string | undefined
  return {
    get latest() { return latest },
    observe(row: Record<string, unknown>) {
      if (row.sessionId !== sessionId || row.type !== 'system' || !('transcriptRecovery' in row)) return
      const marker = row.transcriptRecovery
      if (!isHandoffUuid(row.uuid) || !marker || typeof marker !== 'object' || Array.isArray(marker) ||
          Object.keys(marker).length !== 2 || !('version' in marker) || marker.version !== 1 ||
          !('contextUuid' in marker) || !isHandoffUuid(marker.contextUuid)) throw new Error('Invalid recovery disclosure')
      if (!seen.has(row.uuid)) { seen.add(row.uuid); latest = marker.contextUuid }
    },
  }
}

function inspectReviewInput(path: string, manifest: Manifest, inputUuid?: string, expectedHash?: string) {
  const { isTranscriptMessage } = require('./sessionStorage.js') as typeof import('./sessionStorage.js')
  const fd = openPrivateTranscript(path, constants.O_RDONLY)
  try {
    const info = fstatSync(fd)
    const marker = disclosure(manifest)
    if (info.dev !== manifest.dev || info.ino !== manifest.ino ||
      hashTranscriptDescriptorPrefix(fd, manifest.boundary) !== manifest.prefixSha256 ||
      !readRange(fd, manifest.boundary, marker.length).equals(marker)) {
      throw new Error('Recovery disclosure is not complete or preserved')
    }
    const ancestry = new Map<string, { context: boolean; input: boolean }>()
    let active: string | undefined
    let inputHash: string | undefined
    let genuine = false
    let receiptMatched = false
    const disclosures = recoveryDisclosures(manifest.sessionId)
    const framing = scanTranscriptDescriptor(fd, row => {
      disclosures.observe(row)
      if (row.type === 'active-conversation-tip' && row.sessionId === manifest.sessionId) {
        active = isHandoffUuid(row.tipUuid) ? row.tipUuid : undefined
      }
      if (!isTranscriptMessage(row as unknown as import('../types/logs.js').Entry) ||
        row.sessionId !== manifest.sessionId || row.isSidechain || !isHandoffUuid(row.uuid)) return
      const parentUuid = row.type === 'system' && row.subtype === 'compact_boundary'
        ? row.parentUuid ?? row.logicalParentUuid
        : row.parentUuid
      const parent = typeof parentUuid === 'string' ? ancestry.get(parentUuid) : undefined
      const context = row.uuid === manifest.contextUuid || parent?.context === true
      const body = row.message && typeof row.message === 'object' && !Array.isArray(row.message)
        ? row.message as Record<string, unknown> : null
      const isInput = row.uuid === inputUuid && row.type === 'user' && body?.role === 'user' &&
        !row.isMeta && !row.origin && !row.isVirtual && !row.sourceToolAssistantUUID && row.toolUseResult === undefined &&
        (typeof body.content === 'string' || Array.isArray(body.content)) &&
        !(Array.isArray(body.content) && body.content.some(block => !block || typeof block !== 'object' || block.type === 'tool_result'))
      if (row.uuid === inputUuid) {
        genuine = isInput
        inputHash = sha(Buffer.from(JSON.stringify(row)))
        if (genuine && context && inputHash === expectedHash) receiptMatched = true
      }
      ancestry.set(row.uuid, { context, input: (isInput && context) || parent?.input === true })
    })
    if (framing.suffix.length) throw new Error('A further damaged tail requires separate recovery')
    if (disclosures.latest && disclosures.latest !== manifest.contextUuid) throw new Error('Saved recovery episode evidence is missing')
    return { inputHash, genuine, receiptMatched, descendsContext: !!inputUuid && ancestry.get(inputUuid)?.context === true,
      active: !!active && ancestry.get(active)?.input === true }
  } finally { closeSync(fd) }
}

export function readTailRecoveryState(path: string, sessionId: string, checkedMessages?: readonly unknown[]): TailRecoveryState {
  const manifest = readManifest(path, sessionId)
  if (!manifest) {
    const missing = checkedMessages
      ? checkedMessages.some(row => !!row && typeof row === 'object' && 'transcriptRecovery' in row)
      : transcriptHasRecoveryMarker(path)
    if (missing) throw new Error('Saved recovery evidence is missing; history remains read-only')
    return null
  }
  let reviewRequired = true
  const acceptedPath = join(rootFor(path), 'accepted.json')
  if (existsSync(acceptedPath)) {
    const value = JSON.parse(privateBytes(acceptedPath, 512).toString('utf8')) as { inputUuid?: unknown; inputSha256?: unknown }
    if (Object.keys(value).length !== 2 || !isHandoffUuid(value.inputUuid) || typeof value.inputSha256 !== 'string') throw new Error('Invalid recovery acceptance')
    const observed = inspectReviewInput(path, manifest, value.inputUuid, value.inputSha256)
    reviewRequired = !(observed.receiptMatched && observed.active)
  } else inspectReviewInput(path, manifest)
  return { reviewRequired, warningUuid: manifest.warningUuid, contextUuid: manifest.contextUuid }
}

/** Call only after the real input record and its directory have been fsynced. */
export function acceptTailRecoveryReview(path: string, sessionId: string, inputUuid: string): void {
  assertOwnedTranscriptLease(sessionId)
  withTranscriptAppendGuardSync(path, () => {
    const manifest = readManifest(path, sessionId)
    if (!manifest || !isHandoffUuid(inputUuid)) throw new Error('Invalid recovery admission')
    const observed = inspectReviewInput(path, manifest, inputUuid)
    if (!observed.genuine || !observed.descendsContext || !observed.active || !observed.inputHash) {
      throw new Error('Recovery admission is not genuine input descending from its recovery context')
    }
    const accepted = join(rootFor(path), 'accepted.json')
    if (!existsSync(accepted)) publishExclusive(accepted, Buffer.from(JSON.stringify({ inputUuid, inputSha256: observed.inputHash })))
    if (readTailRecoveryState(path, sessionId)?.reviewRequired) throw new Error('Recovery input is not preserved in the transcript')
  })
}

/** No hooks or caller writes may run while this owned preflight is pending. */
export async function prepareOwnedTranscriptTail(path: string, sessionId: string, callbacks: {
  verifyCheckpoint: (checkpoint: ResumeCheckpoint) => Promise<void>
  validateRetained: (prefixBytes: number) => Promise<string>
  fault?: (stage: 'backup' | 'backup-sync' | 'manifest' | 'manifest-sync' | 'truncate' | 'truncate-sync' | 'disclosure' | 'disclosure-sync') => void
}): Promise<TailRecoveryState> {
  assertOwnedTranscriptLease(sessionId)
  return withTranscriptAppendGuard(path, async () => {
    assertOwnedTranscriptLease(sessionId)
    const fd = openPrivateTranscript(path, constants.O_RDWR | constants.O_APPEND)
    try {
      const originalSize = fstatSync(fd).size
      let manifest = readManifest(path, sessionId)
      const disclosures = recoveryDisclosures(sessionId)
      const framing = scanTranscriptDescriptor(fd, disclosures.observe)
      for (const checkpoint of knownProofs(sessionId)) await callbacks.verifyCheckpoint(checkpoint)
      if (manifest && fstatSync(fd).size - manifest.boundary >= disclosure(manifest).length &&
          readRange(fd, manifest.boundary, disclosure(manifest).length).equals(disclosure(manifest)) &&
          disclosures.latest && disclosures.latest !== manifest.contextUuid) {
        throw new Error('Saved recovery episode evidence is missing')
      }
      let nextEpisode: string | undefined
      if (manifest && framing.suffix.length) {
        const info = fstatSync(fd)
        const marker = disclosure(manifest)
        if (info.size - manifest.boundary >= marker.length &&
            readRange(fd, manifest.boundary, marker.length).equals(marker)) {
          if (info.dev !== manifest.dev || info.ino !== manifest.ino ||
              hashTranscriptDescriptorPrefix(fd, manifest.boundary) !== manifest.prefixSha256) {
            throw new Error('Transcript no longer matches preserved recovery evidence')
          }
          // Keep all earlier evidence immutable. Publish the new episode before
          // touching its damaged suffix, just like the initial recovery journal.
          nextEpisode = randomUUID()
          manifest = null
        }
      }
      if (!manifest && !framing.suffix.length) return null
      if (!manifest && framing.boundary > MAX_RECOVERY_BYTES) throw new Error('Retained history exceeds the automatic recovery proof budget')
      const originalSha256 = hashTranscriptDescriptorPrefix(fd, originalSize)
      assertOwnedTranscriptLease(sessionId)
      if (!manifest) {
        const parentUuid = await callbacks.validateRetained(framing.boundary)
        assertOwnedTranscriptLease(sessionId)
        if (!isHandoffUuid(parentUuid)) throw new Error('No intact conversation remains')
        const info = fstatSync(fd)
        if (info.size !== originalSize || hashTranscriptDescriptorPrefix(fd, originalSize) !== originalSha256) throw new Error('Transcript changed during recovery preflight')
        manifest = { version: 2, sessionId, path: canonicalTranscriptPath(path), dev: info.dev, ino: info.ino,
          originalSize, boundary: framing.boundary, prefixSha256: hashTranscriptDescriptorPrefix(fd, framing.boundary),
          suffixSha256: sha(framing.suffix), warningUuid: randomUUID(), contextUuid: randomUUID(), parentUuid,
          timestamp: new Date().toISOString() }
        const base = evidenceBase(path)
        const destination = nextEpisode ? join(base, 'episodes', nextEpisode) : rootFor(path)
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
        privateDirectory(dirname(destination))
        const root = `${destination}.preparing-${randomUUID()}`
        mkdirSync(root, { mode: 0o700 })
        syncDirectory(dirname(root))
        publishExclusive(join(root, 'tail.bin'), framing.suffix, () => callbacks.fault?.('backup-sync'))
        callbacks.fault?.('backup')
        publishExclusive(join(root, 'manifest.json'), Buffer.from(JSON.stringify(manifest)))
        renameSync(root, destination)
        if (nextEpisode) {
          const pointer = join(base, `current-${randomUUID()}.json`)
          publishExclusive(pointer, Buffer.from(JSON.stringify({ episode: nextEpisode })))
          renameSync(pointer, join(base, 'current.json'))
          syncDirectory(base)
        }
        callbacks.fault?.('manifest-sync')
        syncDirectory(dirname(root))
        callbacks.fault?.('manifest')
      }
      const m = manifest
      const info = fstatSync(fd)
      if (m.dev !== info.dev || m.ino !== info.ino || info.size < m.boundary || hashTranscriptDescriptorPrefix(fd, m.boundary) !== m.prefixSha256) {
        throw new Error('Transcript no longer matches preserved recovery evidence')
      }
      const marker = disclosure(m)
      const originalTail = privateBytes(join(rootFor(path), 'tail.bin'), MAX_RECOVERY_BYTES)
      if (info.size - m.boundary >= marker.length && readRange(fd, m.boundary, marker.length).equals(marker)) {
        if (framing.suffix.length) throw new Error('A further damaged tail requires separate recovery')
        return readTailRecoveryState(path, sessionId)
      }
      const suffix = readRange(fd, m.boundary, info.size - m.boundary)
      if (!suffix.equals(originalTail) && !marker.subarray(0, suffix.length).equals(suffix)) throw new Error('Unexpected bytes after recovery boundary')
      // Preserve failed disclosure bytes too; exclusive publication never overwrites evidence.
      if (suffix.length && !suffix.equals(originalTail)) {
        const failedPath = join(rootFor(path), `partial-${sha(suffix)}.bin`)
        if (!existsSync(failedPath)) publishExclusive(failedPath, suffix)
        else if (!privateBytes(failedPath, MAX_RECOVERY_BYTES).equals(suffix)) throw new Error('Failed disclosure backup differs')
      }
      assertOwnedTranscriptLease(sessionId)
      assertTranscriptAppendGuard(path)
      const current = lstatSync(path)
      if (current.dev !== m.dev || current.ino !== m.ino || !current.isFile()) throw new Error('Transcript identity changed before truncation')
      if (fstatSync(fd).size !== originalSize || hashTranscriptDescriptorPrefix(fd, originalSize) !== originalSha256) throw new Error('Transcript changed before truncation')
      ftruncateSync(fd, m.boundary)
      callbacks.fault?.('truncate-sync')
      fsyncSync(fd)
      callbacks.fault?.('truncate')
      writeTranscriptBytes(fd, marker)
      callbacks.fault?.('disclosure-sync')
      fsyncSync(fd)
      callbacks.fault?.('disclosure')
      syncDirectory(dirname(path))
      return readTailRecoveryState(path, sessionId)
    } finally { closeSync(fd) }
  })
}
