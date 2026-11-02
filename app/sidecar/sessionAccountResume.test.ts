import { afterAll, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockSessionAccountRoute, clearSessionAccountRouteBlock } from '../../src/services/api/sessionAccountRouting.js'

const root = mkdtempSync(join(tmpdir(), 'account-resume-hooks-'))
const previous = { config: process.env.CLAUDE_CONFIG_DIR, persistence: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  simple: process.env.CLAUDE_CODE_SIMPLE }
process.env.CLAUDE_CONFIG_DIR = root
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.CLAUDE_CODE_SIMPLE = '1'
const macro = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const previousMacro = macro.MACRO
macro.MACRO = { VERSION: 'account-resume-test' }
const bootstrap = await import('../../src/bootstrap/state.js')
const oldSession = bootstrap.getSessionId(), oldProject = bootstrap.getSessionProjectDir()
const { asSessionId } = await import('../../src/types/ids.js')
const storage = await import('../../src/utils/sessionStorage.js')
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.js')
const hooks = await import('../../src/utils/sessionStart.js')

afterAll(async () => {
  clearSessionAccountRouteBlock('anthropic')
  clearSessionAccountRouteBlock('openai')
  await releaseActiveTranscriptLease()
  storage.resetProjectForTesting()
  bootstrap.switchSession(asSessionId(oldSession), oldProject)
  if (previousMacro === undefined) delete macro.MACRO
  else macro.MACRO = previousMacro
  for (const [key, value] of Object.entries({ CLAUDE_CONFIG_DIR: previous.config,
    TEST_ENABLE_SESSION_PERSISTENCE: previous.persistence, CLAUDE_CODE_SIMPLE: previous.simple })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test('a blocked saved route preserves real resume history without running startup hooks', async () => {
  const sessionId = asSessionId(randomUUID())
  bootstrap.switchSession(sessionId, root)
  const message = createUserMessage({ content: 'Retain this valid history while recovering the account' })
  await storage.recordTranscript([message, createAssistantMessage({ content: 'Saved answer' })])
  await storage.flushCurrentTranscriptDurably()
  const path = storage.getTranscriptPathForSession(sessionId)
  const hook = spyOn(hooks, 'processSessionStartHooks').mockResolvedValue([])
  try {
    blockSessionAccountRoute('anthropic', 'unavailable-saved-account')
    const blocked = await loadConversationForResume(sessionId, path, { mutable: true, interruptedTurn: 'ignore' })
    expect(blocked?.messages.some(row => row.uuid === message.uuid)).toBe(true)
    expect(hook).not.toHaveBeenCalled()
    clearSessionAccountRouteBlock('anthropic')
    const recovered = await loadConversationForResume(sessionId, path, { mutable: true, interruptedTurn: 'ignore' })
    expect(recovered?.messages.some(row => row.uuid === message.uuid)).toBe(true)
    expect(hook).toHaveBeenCalledTimes(1)
  } finally {
    hook.mockRestore()
  }
})
