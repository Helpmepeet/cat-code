import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  getAPISessionId,
  getSessionId,
  regenerateAPISessionId,
  regenerateSessionId,
  resetStateForTests,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
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
