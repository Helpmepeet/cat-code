/** Engine-owned manual Chat relocation. One transcript, one real companion tree. */
import { cp, lstat, mkdir, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises'
import { closeSync, fsyncSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isPathTrusted } from './config.js'
import { buildDisplayConversationChain, getProjectDir, loadTranscriptFile, selectActiveConversation } from './sessionStorage.js'
import { withUnownedTranscriptLease } from './transcriptLease.js'
import { readPendingDeferredContinuation } from '../services/deferredContinuation.js'
import { assertSessionNotMoving, readSessionRelocation, relocationDirectory, writeSessionRelocation, type RelocationRequest, type SessionLocation, type SessionRelocation } from './sessionRelocationState.js'
export type { RelocationRequest } from './sessionRelocationState.js'
async function stat(path: string) {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function sameLocation(a: SessionLocation, b: SessionLocation): boolean {
  return a.cwd === b.cwd && JSON.stringify(a.binding) === JSON.stringify(b.binding)
}

function lastDisplayFrameId(
  loaded: Awaited<ReturnType<typeof loadTranscriptFile>>,
): string | null {
  const active = selectActiveConversation(loaded.messages, loaded.leafUuids, loaded.activeConversationTip)
  if (!active.tip) return null
  const chain = buildDisplayConversationChain(loaded.messages, active.tip)
  for (let index = chain.length - 1; index >= 0; index--) {
    const message = chain[index]!
    if (message.type === 'system' && message.subtype === 'compact_boundary') return message.uuid
    if (message.type === 'assistant' && message.message?.content.some(block =>
      block.type === 'text' || block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'tool_use')) return message.uuid
    if (message.type !== 'user' || message.isMeta || message.isVisibleInTranscriptOnly) continue
    const content = message.message?.content
    if (typeof content === 'string' ? content.trim().length > 0 :
      Array.isArray(content) && content.some(block =>
        block.type === 'text' || block.type === 'image' || block.type === 'document')) return message.uuid
  }
  return null
}

export async function relocateSession(request: RelocationRequest): Promise<void> {
  const { engineSessionId: id, source, target } = request
  assertSessionNotMoving(id)
  const prior = readSessionRelocation(id)
  const original = prior?.original ?? source
  if (original.binding.kind !== 'managed' || source.cwd === target.cwd ||
      (source.binding.kind !== 'managed' && target.binding.kind !== 'managed') ||
      (target.binding.kind === 'managed' && JSON.stringify(target) !== JSON.stringify(original)) ||
      (prior && JSON.stringify(prior.target) !== JSON.stringify(source))) {
    throw new Error('Only Chat to project and Move back are supported')
  }
  for (const location of [source, target]) {
    if ((await realpath(location.cwd)).normalize('NFC') !== location.cwd || !(await lstat(location.cwd)).isDirectory()) {
      throw new Error('The conversation folder changed')
    }
  }
  if (target.binding.kind === 'project' && !isPathTrusted(target.cwd)) {
    throw new Error('Open and trust this project before moving a Chat into it')
  }
  const from = join(getProjectDir(source.cwd), `${id}.jsonl`)
  const to = join(getProjectDir(target.cwd), `${id}.jsonl`)
  const fromDir = join(dirname(from), id)
  const toDir = join(dirname(to), id)
  const result = await withUnownedTranscriptLease(id, async () => {
    assertSessionNotMoving(id)
    if (await readPendingDeferredContinuation(id)) throw new Error('Finish the scheduled continuation before moving this Chat')
    const sourceTranscript = await stat(from)
    const transcript = sourceTranscript ? await loadTranscriptFile(from, { keepCompactedHistory: true }) : null
    if (transcript?.worktreeStates.get(id as `${string}-${string}-${string}-${string}-${string}`)) {
      throw new Error('Leave the worktree before moving this Chat')
    }
    if ((sourceTranscript && (!sourceTranscript.isFile() || sourceTranscript.isSymbolicLink())) || await stat(to)) {
      throw new Error('The conversation history is missing or the destination already contains it')
    }
    const empty = !transcript || transcript.messages.size === 0
    if (!empty && !sourceTranscript) throw new Error('The conversation history is missing')
    const companion = await stat(fromDir)
    if (companion && (!companion.isDirectory() || companion.isSymbolicLink())) throw new Error('Unexpected conversation data location')
    const alias = await stat(toDir)
    if (alias && (!prior || !alias.isSymbolicLink() || resolve(dirname(toDir), await readlink(toDir)) !== fromDir)) {
      throw new Error('The destination already contains conversation data')
    }
    await mkdir(dirname(from), { recursive: true, mode: 0o700 })
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    if ((await lstat(dirname(to))).dev !== (await lstat(dirname(from))).dev) throw new Error('Conversation storage must be on the same disk')
    const backup = join(relocationDirectory(), 'backups', `${id}-${randomUUID()}`)
    await mkdir(backup, { recursive: true, mode: 0o700 })
    if (sourceTranscript) await cp(from, join(backup, `${id}.jsonl`), { errorOnExist: true, force: false })
    if (companion) await cp(fromDir, join(backup, id), { recursive: true, dereference: false, errorOnExist: true, force: false })
    const movedAt = Date.now()
    const afterFrameId = transcript ? lastDisplayFrameId(transcript) : null
    const previousTransitions = prior?.transitions ?? []
    const lastTransition = previousTransitions.at(-1)
    if (request.rollback && (!lastTransition || !sameLocation(lastTransition.target, source) ||
      !sameLocation(lastTransition.source, target) || lastTransition.afterFrameId !== afterFrameId)) {
      throw new Error('The failed move changed before it could be restored')
    }
    const transitions = request.rollback
      ? previousTransitions.slice(0, -1)
      : [...previousTransitions, { id: randomUUID(), afterFrameId, source, target, movedAt }]
    const { rollback: _rollback, ...persistedRequest } = request
    const record: SessionRelocation = {
      version: 1, ...persistedRequest, original, phase: 'moving', backup, movedAt,
      ...(empty ? { empty: true as const } : {}),
      transitions: previousTransitions,
    }
    writeSessionRelocation(record)
    // Any failure after this point leaves the durable stop record and backup.
    if (alias) await unlink(toDir)
    if (sourceTranscript) await rename(from, to)
    if (companion) await rename(fromDir, toDir)
    else await mkdir(toDir, { mode: 0o700 })
    await symlink(toDir, fromDir, 'dir')
    syncDirectory(dirname(from))
    syncDirectory(dirname(to))
    writeSessionRelocation({ ...record, phase: 'complete', transitions })
  })
  if (!result.acquired) throw new Error('This conversation is still open in another process')
}
