import { expect, test } from 'bun:test'
import { turnFailureCopy, retryableTurn, retrySendBlocked, retryComposerBlocked } from './turnFailure.js'
import { observeRetryWait, retryWaitSeconds } from './retryClock.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

const source = { id: 'user', sessionId: 's', frameId: 'user-frame', messageId: 'message', blockIndex: 0, parentToolUseId: null, children: [] }
const user = { ...source, kind: 'user-text', role: 'user', content: 'Try this request', isReplay: false } satisfies NestedTranscriptRow
const failure = { id: 'failure', sessionId: 's', frameId: 'result', kind: 'result', subtype: 'error_during_execution', isError: true, errors: [], children: [] } satisfies NestedTranscriptRow

test('classifies structured auth and overloaded status, narrowly recognizes usage failures, and strips terminal instructions', () => {
  expect(turnFailureCopy({ subtype: 'error_during_execution', errorStatus: 529 }).title).toBe('The service is overloaded')
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerCode: 'authentication_failed' })).toEqual({
    title: 'Authentication failed', detail: 'Check your provider credentials and access settings before trying again.', action: null,
  })
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'Repeated 529 Overloaded errors' }).title).toBe('The service is overloaded')
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'Codex account usage limit reached. Use /switch-account to switch to another account, or /accounts to check status.' })).toMatchObject({ title: 'Usage limit reached', action: 'accounts' })
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'Codex usage limit reached.\n\nRun /continue-after-limit to continue this conversation after the reset.' }).title).toBe('Usage limit reached')
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'OAuth token revoked · Please run /login' }).detail).toBe('OAuth token revoked')
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'Request rejected. Use /accounts to check status.' }).detail).toBe('Request rejected')
  expect(turnFailureCopy({ subtype: 'future', providerMessage: 'The data mentions overloaded usage but is not a limit error.' }).title).toBe('This turn could not finish')
  expect(turnFailureCopy({ subtype: 'error_during_execution', providerMessage: 'Please run /login' }).detail).toContain('save a diagnostics bundle')
})

test('auth failures retain distinct provider causes and useful remediation without assuming expiry', () => {
  for (const [providerMessage, detail] of [
    ['Invalid API key · Fix external API key', 'Invalid API key · Fix external API key'],
    ['Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable', 'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable'],
    ['OAuth token revoked · Please run /login', 'OAuth token revoked'],
    ['Authentication error · This may be a temporary network issue, please try again', 'Authentication error · This may be a temporary network issue, please try again'],
    ['Please run /login · API Error: Access restricted by organization policy', 'API Error: Access restricted by organization policy'],
    ['Please run /login. Contact your administrator to restore access.', 'Contact your administrator to restore access.'],
  ]) {
    for (const classification of [
      { subtype: 'error_auth_required' },
      { subtype: 'error_during_execution', providerCode: 'authentication_failed' },
    ]) {
      expect(turnFailureCopy({ ...classification, providerMessage })).toEqual({
        title: 'Authentication failed', detail, action: null,
      })
    }
  }
  expect(turnFailureCopy({ subtype: 'error_auth_required', providerMessage: 'Please run /login' }).detail)
    .toBe('Check your provider credentials and access settings before trying again.')
})

test('retry only targets the latest failed plain text turn and refuses ambiguous content', () => {
  expect(retryableTurn([user, failure])).toEqual({ resultId: 'failure', text: 'Try this request' })
  expect(retryableTurn([user, failure, { ...user, id: 'new-user', frameId: 'new' }])).toBeNull()
  expect(retryableTurn([user, failure, { ...failure, id: 'success', isError: false }])).toBeNull()
  expect(retryableTurn([user, { ...source, id: 'image', kind: 'user-image', source: { type: 'url', url: 'https://example.com/image.png' }, isReplay: false }, failure])).toBeNull()
  expect(retryableTurn([{ ...user, content: '/login' }, failure])).toBeNull()
  expect(retryableTurn([{ ...user, id: 'first-block' }, user, failure])).toBeNull()
})

test('countdowns use receipt time, do not restart on remount, and omit replay or zero delays', () => {
  const wait = { delayMs: 12000, replay: false }
  observeRetryWait(wait, 1000)
  expect(retryWaitSeconds(wait, 1000)).toBe(12)
  observeRetryWait(wait, 5000)
  expect(retryWaitSeconds(wait, 6000)).toBe(7)
  expect(retryWaitSeconds(wait, 14000)).toBe(0)
  const replay = { delayMs: 12000, replay: true }
  observeRetryWait(replay, 1000)
  expect(retryWaitSeconds(replay, 1000)).toBeNull()
  const zero = { delayMs: 0, replay: false }
  observeRetryWait(zero, 1000)
  expect(retryWaitSeconds(zero, 1000)).toBeNull()
})

test('a resend waits only on a running attached turn; parked and spawning sessions go to the submit planner', () => {
  expect(retrySendBlocked({ status: 'ready', inputEnabled: true }, true)).toBe(false)
  expect(retrySendBlocked({ status: 'ready', inputEnabled: false }, true)).toBe(true)
  expect(retrySendBlocked({ status: 'ready', inputEnabled: true }, false)).toBe(true)
  expect(retrySendBlocked({ status: 'parked', inputEnabled: false }, false)).toBe(false)
  expect(retrySendBlocked({ status: 'starting', inputEnabled: false }, false)).toBe(false)
})

test('card and native retry share each composer blocker without consuming its draft', () => {
  const ready = { draft: '', imageCount: 0, hasFile: false, attachmentPending: false, workspaceBusy: false, folderUnavailable: false, hasProjectRoute: false }
  expect(retryComposerBlocked(ready)).toBe(false)
  for (const change of [
    { draft: 'Unsent draft' }, { imageCount: 1 }, { hasFile: true }, { attachmentPending: true },
    { workspaceBusy: true }, { folderUnavailable: true }, { hasProjectRoute: true },
  ]) expect(retryComposerBlocked({ ...ready, ...change })).toBe(true)
})
