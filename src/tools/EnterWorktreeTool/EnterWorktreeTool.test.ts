import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { randomUUID, type UUID } from 'crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  setOriginalCwd,
  switchSession,
} from '../../bootstrap/state.js'
import { asAgentId, asSessionId } from '../../types/ids.js'
import {
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
} from '../../utils/fileHistory.js'
import { createUserMessage } from '../../utils/messages.js'
import {
  clearSessionMessagesCache,
  flushCurrentTranscriptDurably,
  flushSessionStorage,
  getAgentTranscriptPath,
  getTranscriptPath,
  recordTranscript,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import { setCwd } from '../../utils/Shell.js'
import { releaseActiveTranscriptLease } from '../../utils/transcriptLease.js'
import { restoreWorktreeSession } from '../../utils/worktree.js'
import { EnterWorktreeTool } from './EnterWorktreeTool.js'

/**
 * EnterWorktree used to call `setOriginalCwd(getCwd())` after chdir'ing into
 * the worktree. For a session that was never resumed `sessionProjectDir` is
 * null, so `getTranscriptPath()` derives from originalCwd — it would start
 * resolving under the WORKTREE's project dir while the writer kept appending
 * to the file it latched at materialization, under the ORIGINAL one. Every
 * hook invocation after that received a `transcript_path` (hooks.ts
 * createBaseHookInput) pointing at a file that does not exist, and the same
 * divergence hits getAgentTranscriptPath, getAgentTranscriptPathForSession,
 * listAgentMetadataForSession and the remote-agents dir.
 *
 * Driving the real tool is the point: the bug is the ORDER of the two calls
 * inside `call()`, so a unit test on the pieces would not see it.
 */
describe('EnterWorktreeTool transcript path', () => {
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalCwd = getOriginalCwd()
  const originalProcessCwd = process.cwd()
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalFileHistoryEnabled =
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
  const originalFileHistoryDisabled =
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  let configDir: string
  let repoDir: string
  let sessionId: UUID

  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    await releaseActiveTranscriptLease()
    resetProjectForTesting()

    configDir = realpathSync(
      mkdtempSync(join(tmpdir(), 'enter-worktree-config-')),
    )
    process.env.CLAUDE_CONFIG_DIR = configDir

    repoDir = realpathSync(
      mkdtempSync(join(tmpdir(), 'enter-worktree-repo-')),
    )
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    git('commit', '-q', '--allow-empty', '-m', 'base')

    process.chdir(repoDir)
    setCwd(repoDir)
    setOriginalCwd(process.cwd())
    // null projectDir is the case the bug needs: a session that was never
    // resumed derives its transcript path from originalCwd.
    sessionId = randomUUID()
    switchSession(asSessionId(sessionId), null)
  })

  afterEach(async () => {
    restoreWorktreeSession(null)
    await flushSessionStorage()
    clearSessionMessagesCache()
    resetProjectForTesting()
    await releaseActiveTranscriptLease()
    process.chdir(originalProcessCwd)
    setCwd(originalProcessCwd)
    setOriginalCwd(originalCwd)
    switchSession(asSessionId(originalSessionId), originalProjectDir)
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalFileHistoryEnabled === undefined) {
      delete process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING =
        originalFileHistoryEnabled
    }
    if (originalFileHistoryDisabled === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING =
        originalFileHistoryDisabled
    }
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  test('entering a worktree keeps the transcript path on the real file', async () => {
    await recordTranscript([createUserMessage({ content: 'before worktree' })])
    await flushCurrentTranscriptDurably()

    const materializedPath = getTranscriptPath()
    expect(existsSync(materializedPath)).toBe(true)
    // Every sibling path reads the same `getSessionProjectDir() ??
    // getProjectDir(getOriginalCwd())` expression, so one of them standing in
    // for getAgentTranscriptPathForSession / listAgentMetadataForSession /
    // the remote-agents dir is enough to prove the shared derivation.
    const agentPath = getAgentTranscriptPath(asAgentId('a1b2c3'))

    // call() reads only its input; the remaining params are unused by this tool.
    await (
      EnterWorktreeTool.call as (input: { name: string }) => Promise<unknown>
    )({ name: 'transcript-path' })

    expect(getTranscriptPath()).toBe(materializedPath)
    expect(existsSync(getTranscriptPath())).toBe(true)
    expect(getAgentTranscriptPath(asAgentId('a1b2c3'))).toBe(agentPath)
  })

  test('rewinding after entering a worktree keeps file history on the original checkout', async () => {
    const rootFile = join(repoDir, 'important.txt')
    writeFileSync(rootFile, 'committed baseline\n')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
    git('add', 'important.txt')
    git('commit', '-q', '-m', 'fixture')

    writeFileSync(rootFile, 'valuable uncommitted original\n')
    let state: FileHistoryState = {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    }
    const update = (
      updater: (previous: FileHistoryState) => FileHistoryState,
    ) => {
      state = updater(state)
    }
    const beforeEdit = randomUUID()

    await fileHistoryMakeSnapshot(update, beforeEdit)
    await fileHistoryTrackEdit(update, rootFile, beforeEdit)
    expect([...state.trackedFiles]).toEqual([rootFile])
    expect(Object.keys(state.snapshots[0]!.trackedFileBackups)).toEqual([
      rootFile,
    ])

    writeFileSync(rootFile, 'agent changed original\n')
    await (
      EnterWorktreeTool.call as (input: { name: string }) => Promise<unknown>
    )({ name: 'file-history' })

    const worktreeFile = join(getOriginalCwd(), 'important.txt')
    expect(readFileSync(worktreeFile, 'utf8')).toBe('committed baseline\n')
    writeFileSync(worktreeFile, 'valuable worktree-only changes\n')
    await fileHistoryMakeSnapshot(update, randomUUID())
    expect(Object.keys(state.snapshots.at(-1)!.trackedFileBackups)).toEqual([
      rootFile,
    ])

    await fileHistoryRewind(update, beforeEdit)

    expect(readFileSync(rootFile, 'utf8')).toBe('valuable uncommitted original\n')
    expect(readFileSync(worktreeFile, 'utf8')).toBe(
      'valuable worktree-only changes\n',
    )
  })

  test('rewinding a null backup deletes only the original checkout file', async () => {
    const rootFile = join(repoDir, 'created-after-checkpoint.txt')
    let state: FileHistoryState = {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    }
    const update = (
      updater: (previous: FileHistoryState) => FileHistoryState,
    ) => {
      state = updater(state)
    }
    const beforeEdit = randomUUID()

    await fileHistoryMakeSnapshot(update, beforeEdit)
    await fileHistoryTrackEdit(update, rootFile, beforeEdit)
    expect(state.snapshots[0]!.trackedFileBackups[rootFile]!.backupFileName).toBe(
      null,
    )

    writeFileSync(rootFile, 'created in original checkout\n')
    await (
      EnterWorktreeTool.call as (input: { name: string }) => Promise<unknown>
    )({ name: 'file-history-null-backup' })

    const worktreeFile = join(getOriginalCwd(), 'created-after-checkpoint.txt')
    writeFileSync(worktreeFile, 'created in worktree checkout\n')
    await fileHistoryMakeSnapshot(update, randomUUID())

    await fileHistoryRewind(update, beforeEdit)

    expect(existsSync(rootFile)).toBe(false)
    expect(readFileSync(worktreeFile, 'utf8')).toBe(
      'created in worktree checkout\n',
    )
  })
})
