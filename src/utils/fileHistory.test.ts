import { expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getIsInteractive,
  getSessionId,
  getSessionProjectDir,
  setIsInteractive,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { asSessionId } from '../types/ids.js'
import { getCwd } from './cwd.js'
import type { FileHistorySnapshot, FileHistoryState } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog, fileHistoryRewind } from './fileHistory.js'
import { exitRestoredWorktree, restoreSessionStateFromLog, restoreWorktreeForResume } from './sessionRestore.js'
import { resetProjectForTesting } from './sessionStorage.js'
import { setCwd } from './Shell.js'
import { getCurrentWorktreeSession, restoreWorktreeSession } from './worktree.js'

test('restoring file history binds legacy relative keys to the current base', () => {
  const originalCwd = getOriginalCwd()
  const originalInteractive = getIsInteractive()
  const originalEnabled =
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
  const originalDisabled = process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  const sandbox = realpathSync(
    mkdtempSync(join(tmpdir(), 'file-history-restore-')),
  )
  const laterCwd = realpathSync(
    mkdtempSync(join(tmpdir(), 'file-history-later-')),
  )

  try {
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    setIsInteractive(false)
    setOriginalCwd(sandbox)

    const legacyRelativePath = 'nested/legacy.txt'
    const absolutePath = join(sandbox, 'already-absolute.txt')
    const backup = {
      backupFileName: 'backup@v1',
      version: 1,
      backupTime: new Date(),
    }
    const snapshot: FileHistorySnapshot = {
      messageId: randomUUID(),
      trackedFileBackups: {
        [legacyRelativePath]: backup,
        [absolutePath]: backup,
      },
      timestamp: new Date(),
    }

    let restored: FileHistoryState | undefined
    fileHistoryRestoreStateFromLog([snapshot], newState => {
      restored = newState
    })

    expect(restored).toBeDefined()
    expect([...restored!.trackedFiles]).toEqual([
      join(sandbox, legacyRelativePath),
      absolutePath,
    ])
    expect(Object.keys(restored!.snapshots[0]!.trackedFileBackups)).toEqual([
      join(sandbox, legacyRelativePath),
      absolutePath,
    ])

    setOriginalCwd(laterCwd)
    expect([...restored!.trackedFiles]).toEqual([
      join(sandbox, legacyRelativePath),
      absolutePath,
    ])
  } finally {
    setOriginalCwd(originalCwd)
    setIsInteractive(originalInteractive)
    if (originalEnabled === undefined) {
      delete process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = originalEnabled
    }
    if (originalDisabled === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    } else {
      process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = originalDisabled
    }
    rmSync(sandbox, { recursive: true, force: true })
    rmSync(laterCwd, { recursive: true, force: true })
  }
})

test('legacy checkpoint restore after switching worktree A to B targets only B', async () => {
  const originalCwd = getOriginalCwd()
  const originalProcessCwd = process.cwd()
  const originalShellCwd = getCwd()
  const originalInteractive = getIsInteractive()
  const originalSessionId = getSessionId()
  const originalProjectDir = getSessionProjectDir()
  const originalWorktree = getCurrentWorktreeSession()
  const envKeys = [
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
  ] as const
  const originalEnv = envKeys.map(key => process.env[key])
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'file-history-switch-')))
  const worktreeA = join(sandbox, 'a')
  const worktreeB = join(sandbox, 'b')
  mkdirSync(worktreeA)
  mkdirSync(worktreeB)

  try {
    process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'config')
    process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = '1'
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
    setIsInteractive(false)
    resetProjectForTesting()
    restoreWorktreeSession(null)
    const sessionA = asSessionId(randomUUID())
    const sessionB = asSessionId(randomUUID())
    switchSession(sessionA, null)
    restoreWorktreeForResume({
      originalCwd: sandbox,
      worktreePath: worktreeA,
      worktreeName: 'a',
      sessionId: sessionA,
    })
    expect(getOriginalCwd()).toBe(worktreeA)
    const fileA = join(worktreeA, 'new.txt')
    const fileB = join(worktreeB, 'new.txt')
    writeFileSync(fileA, 'valuable A contents\n')
    writeFileSync(fileB, 'created after B checkpoint\n')
    const messageId = randomUUID()
    const log = {
      worktreeSession: {
        originalCwd: sandbox,
        worktreePath: worktreeB,
        worktreeName: 'b',
        sessionId: sessionB,
      },
      fileHistorySnapshots: [{
        messageId,
        timestamp: new Date(),
        trackedFileBackups: {
          'new.txt': { backupFileName: null, version: 1, backupTime: new Date() },
        },
      }],
    }
    let state = getDefaultAppState()
    switchSession(sessionB, null)
    exitRestoredWorktree()
    restoreWorktreeForResume(log.worktreeSession)
    restoreSessionStateFromLog(log, updater => { state = updater(state) })

    expect(getSessionId()).toBe(sessionB)
    expect(getOriginalCwd()).toBe(worktreeB)
    expect([...state.fileHistory.trackedFiles]).toEqual([fileB])
    await fileHistoryRewind(updater => {
      state = { ...state, fileHistory: updater(state.fileHistory) }
    }, messageId)
    expect(readFileSync(fileA, 'utf8')).toBe('valuable A contents\n')
    expect(existsSync(fileB)).toBe(false)
  } finally {
    resetProjectForTesting()
    restoreWorktreeSession(originalWorktree)
    process.chdir(originalProcessCwd)
    setCwd(originalShellCwd)
    setOriginalCwd(originalCwd)
    switchSession(originalSessionId, originalProjectDir)
    setIsInteractive(originalInteractive)
    envKeys.forEach((key, index) => {
      if (originalEnv[index] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[index]
    })
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('REPL wiring restores checkpoint state after the worktree or fork branch', () => {
  // Source-order tripwire only; the helper test above exercises filesystem effects.
  const source = readFileSync(new URL('../screens/REPL.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const resume = useCallback(')
  expect(start).toBeGreaterThan(-1)
  const resume = source.slice(start)
  const copy = resume.indexOf('void copyFileHistoryForResume(log);')
  const switchId = resume.indexOf('switchSession(asSessionId(sessionId),')
  const exit = resume.indexOf('exitRestoredWorktree();')
  const enter = resume.indexOf('restoreWorktreeForResume(log.worktreeSession);')
  const fork = resume.indexOf('if (ws) saveWorktreeState(ws);')
  const restore = resume.indexOf('restoreSessionStateFromLog(log, setAppState);')
  expect(copy).toBeGreaterThan(-1)
  expect(switchId).toBeGreaterThan(copy)
  expect(exit).toBeGreaterThan(switchId)
  expect(enter).toBeGreaterThan(exit)
  expect(fork).toBeGreaterThan(enter)
  expect(restore).toBeGreaterThan(fork)
})
