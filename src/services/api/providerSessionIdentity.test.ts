import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  getAPISessionId,
  getSessionId,
  onSessionSwitch,
  regenerateAPISessionId,
  regenerateSessionId,
  resetStateForTests,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import {
  _getConversationIdForRequestForTest,
  setCodexPromptCacheKey,
} from './codex-fetch-adapter.js'
import { applyPostCodexAccountSwitchRefresh } from './codexAccountPool.js'

afterEach(() => {
  resetStateForTests()
})

describe('provider-facing session identity', () => {
  test('auth refresh rotates the API identity without moving the transcript identity', () => {
    const transcriptSessionId = getSessionId()
    const initialAPISessionId = getAPISessionId()

    applyPostCodexAccountSwitchRefresh()

    expect(getSessionId()).toBe(transcriptSessionId)
    expect(getAPISessionId()).not.toBe(initialAPISessionId)
  })

  test('real transcript identity changes keep both identities aligned', () => {
    const original = getSessionId()
    regenerateAPISessionId()

    const regenerated = regenerateSessionId()
    expect(regenerated).not.toBe(original)
    expect(getSessionId()).toBe(regenerated)
    expect(getAPISessionId()).toBe(regenerated)

    const resumed = '11111111-1111-4111-8111-111111111111' as SessionId
    switchSession(resumed)
    expect(getSessionId()).toBe(resumed)
    expect(getAPISessionId()).toBe(resumed)
  })

  test('auth callers rotate only the API identity and provider request fields consume it', () => {
    const loginSource = readFileSync(
      new URL('../../commands/login/login.tsx', import.meta.url),
      'utf8',
    )
    const poolSource = readFileSync(
      new URL('./codexAccountPool.ts', import.meta.url),
      'utf8',
    )
    const claudeSource = readFileSync(new URL('./claude.ts', import.meta.url), 'utf8')
    const clientSource = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')

    expect(loginSource).toContain('regenerateAPISessionId()')
    expect(loginSource).not.toContain('regenerateSessionId()')
    expect(poolSource).toContain('regenerateAPISessionId()')
    expect(claudeSource).toContain('session_id: getAPISessionId()')
    expect(clientSource).toContain("'X-Claude-Code-Session-Id': getAPISessionId()")
  })
})

/**
 * `/clear` regenerates the session but never went through switchSession, so
 * subscribers that track the active sessionId (the Codex prompt-cache rebind in
 * setup.ts, the PID file in concurrentSessions.ts) were left on the cleared
 * conversation for the life of the process. Report §15.4.
 */
describe('session regeneration notifies sessionId subscribers', () => {
  test('regenerateSessionId emits the switch signal with the new id', () => {
    const seen: SessionId[] = []
    onSessionSwitch(id => {
      seen.push(id)
    })

    const regenerated = regenerateSessionId({ setCurrentAsParent: true })

    expect(seen).toEqual([regenerated])
  })

  test('the rebind actually moves the Codex conversation_id', () => {
    // Drives the same chain setup.ts registers: signal -> the prompt-cache
    // setter -> the conversation_id the request carries. Asserting only that
    // the signal fired would pass even while the derived id stayed memoized.
    onSessionSwitch(id => {
      setCodexPromptCacheKey(id)
    })
    setCodexPromptCacheKey(getSessionId())
    const beforeClear = _getConversationIdForRequestForTest('acct-1', 'gpt-5.6-sol')

    regenerateSessionId({ setCurrentAsParent: true })

    expect(_getConversationIdForRequestForTest('acct-1', 'gpt-5.6-sol')).not.toBe(
      beforeClear,
    )
  })

  test('an unchanged key keeps the conversation_id stable', () => {
    setCodexPromptCacheKey(getSessionId())
    const first = _getConversationIdForRequestForTest('acct-1', 'gpt-5.6-sol')

    setCodexPromptCacheKey(getSessionId())

    expect(_getConversationIdForRequestForTest('acct-1', 'gpt-5.6-sol')).toBe(first)
  })
})
