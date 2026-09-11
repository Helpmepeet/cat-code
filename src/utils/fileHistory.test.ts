import { expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  getIsInteractive,
  setIsInteractive,
  setOriginalCwd,
} from '../bootstrap/state.js'
import type { FileHistorySnapshot, FileHistoryState } from './fileHistory.js'
import { fileHistoryRestoreStateFromLog } from './fileHistory.js'

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
