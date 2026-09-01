import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { randomUUID, type UUID } from 'crypto'
import { existsSync, mkdtempSync, rmSync } from 'fs'
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
import { createUserMessage } from '../../utils/messages.js'
import {
  clearSessionMessagesCache,
  flushCurrentTranscriptDurably,
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
  let configDir: string
  let repoDir: string
  let sessionId: UUID

  beforeEach(async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await releaseActiveTranscriptLease()
    resetProjectForTesting()

    configDir = mkdtempSync(join(tmpdir(), 'enter-worktree-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    repoDir = mkdtempSync(join(tmpdir(), 'enter-worktree-repo-'))
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
})
