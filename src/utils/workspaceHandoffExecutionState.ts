import { constants } from 'node:fs'
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { assertActiveTranscriptLease } from './transcriptLease.js'
import { canonicalResumeJson } from './resumeCheckpoint.js'
import { isHandoffUuid, isWorkspaceHandoffExecutionRecord,
  type WorkspaceHandoffIdentity, type WorkspaceHandoffExecutionRecord,
  type WorkspaceHandoffRecordStatus } from '../../app/shared/workspaceHandoff.js'

export const MAX_HANDOFF_EXECUTION_BYTES = 16 * 1024
export function workspaceHandoffExecutionDirectory(): string {
  return join(getClaudeConfigHomeDir(), 'workspace-handoff-executions')
}
const operations = new Map<string, Promise<unknown>>()
const identityKeys = ['appSessionId', 'engineSessionId', 'operationId', 'continuationId',
  'sourceGeneration', 'admissionGeneration', 'operationSha256'] as const
function pathFor(identity: WorkspaceHandoffIdentity): string {
  if (!isHandoffUuid(identity.engineSessionId) || !isHandoffUuid(identity.operationId)) throw new Error('Invalid execution identity')
  return join(workspaceHandoffExecutionDirectory(), identity.engineSessionId, `${identity.operationId}.json`)
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Unsafe execution directory')
}

async function syncExecutionDirectoryLinks(identity: WorkspaceHandoffIdentity): Promise<void> {
  // Sync both the file's directory and the entries that link newly created
  // private directories to their parents before publishing any receipt.
  for (const directory of [join(workspaceHandoffExecutionDirectory(), identity.engineSessionId),
    workspaceHandoffExecutionDirectory(), getClaudeConfigHomeDir()]) {
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isDirectory()) throw new Error('Invalid execution directory')
      await handle.sync()
    } finally { await handle.close() }
  }
}

export async function readWorkspaceHandoffExecution(identity: WorkspaceHandoffIdentity): Promise<WorkspaceHandoffRecordStatus | { kind: 'identity_mismatch' }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    for (const directory of [workspaceHandoffExecutionDirectory(), join(workspaceHandoffExecutionDirectory(), identity.engineSessionId)]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) return { kind: 'invalid' }
    }
    handle = await open(pathFor(identity), constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_HANDOFF_EXECUTION_BYTES || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) return { kind: 'invalid' }
    const bytes = Buffer.alloc(info.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== info.size) return { kind: 'invalid' }
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) } catch { return { kind: 'invalid' } }
    if (!isWorkspaceHandoffExecutionRecord(value)) return { kind: 'invalid' }
    if (identityKeys.some(key => value[key] !== identity[key])) return { kind: 'identity_mismatch' }
    // A visible rename alone is insufficient after an ambiguous directory sync.
    // Recovery re-establishes the durability barrier before exposing evidence.
    await handle.sync()
    await syncExecutionDirectoryLinks(identity)
    return { kind: 'valid', record: value }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable' }
  } finally { await handle?.close().catch(() => {}) }
}

/** The transcript lease is the process authority; the chain protects local awaits. */
export async function updateWorkspaceHandoffExecution(identity: WorkspaceHandoffIdentity,
  update: (previous: WorkspaceHandoffExecutionRecord | null) => WorkspaceHandoffExecutionRecord): Promise<WorkspaceHandoffExecutionRecord> {
  const path = pathFor(identity)
  const previousOperation = operations.get(path) ?? Promise.resolve()
  const operation = previousOperation.catch(() => {}).then(async () => {
    assertActiveTranscriptLease(identity.engineSessionId)
    const status = await readWorkspaceHandoffExecution(identity)
    if (status.kind !== 'valid' && status.kind !== 'absent') throw new Error('Execution storage unavailable')
    const previous = status.kind === 'valid' ? status.record : null
    const next = update(previous)
    if (!isWorkspaceHandoffExecutionRecord(next) || identityKeys.some(key => next[key] !== identity[key]) ||
      next.revision !== (previous?.revision ?? 0) + 1) throw new Error('Invalid execution replacement')
    if (previous && ((previous.consumed && !next.consumed) || (previous.inputCommitted && !next.inputCommitted) ||
      (previous.terminal && canonicalResumeJson(previous.terminal) !== canonicalResumeJson(next.terminal)) ||
      (previous.notice && canonicalResumeJson(previous.notice) !== canonicalResumeJson(next.notice)) ||
      (previous.reconciliation && canonicalResumeJson(previous.reconciliation) !== canonicalResumeJson(next.reconciliation)) ||
      (previous.cancellation && canonicalResumeJson(previous.cancellation) !== canonicalResumeJson(next.cancellation)))) {
      throw new Error('Conflicting execution evidence')
    }
    const text = `${JSON.stringify(next)}\n`
    if (Buffer.byteLength(text) > MAX_HANDOFF_EXECUTION_BYTES) throw new Error('Execution record too large')
    await privateDirectory(workspaceHandoffExecutionDirectory())
    const directory = join(workspaceHandoffExecutionDirectory(), identity.engineSessionId)
    await privateDirectory(directory)
    const temporary = join(directory, `.${identity.operationId}.${randomUUID()}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(temporary, 'wx', 0o600)
      await file.writeFile(text)
      await file.sync()
      await file.close(); file = undefined
      assertActiveTranscriptLease(identity.engineSessionId)
      await rename(temporary, path)
      await syncExecutionDirectoryLinks(identity)
      return next
    } finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  })
  operations.set(path, operation)
  try { return await operation } finally { if (operations.get(path) === operation) operations.delete(path) }
}
