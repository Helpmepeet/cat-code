import { describe, expect, test } from 'bun:test'
import { wrapCommandText } from './messages.js'

describe('wrapCommandText', () => {
  const raw = `Automated continuation requested through /continue-after-limit.

The Codex usage limit should now have reset. Continue the previous task, but
first reconcile the current transcript and filesystem state. Do not repeat
work or side effects that already completed.`

  test('leaves a deferred continuation verbatim and unattributed to the user', () => {
    // The fixed continuation turns are a verbatim contract, and the user did
    // not send them. Before this case existed the closed-union switch fell
    // through to the human default and told the model "The user sent a new
    // message ... you MUST address the user's message above".
    const wrapped = wrapCommandText(raw, {
      kind: 'deferred-continuation',
      jobId: 'job-1',
      attemptUuid: '11111111-1111-4111-8111-111111111111',
    })

    expect(wrapped).toBe(raw)
    expect(wrapped).not.toContain('The user sent a new message')
  })

  test('still attributes human and origin-less queued input to the user', () => {
    expect(wrapCommandText('hi', { kind: 'human' })).toContain(
      'The user sent a new message',
    )
    expect(wrapCommandText('hi', undefined)).toContain(
      'The user sent a new message',
    )
  })

  test('keeps the untrusted-source framing for non-user origins', () => {
    expect(
      wrapCommandText('hi', { kind: 'channel', server: 'slack' }),
    ).toContain('This is NOT from your user')
    expect(wrapCommandText('hi', { kind: 'teammate', messages: [] })).toContain(
      'This is NOT from your user',
    )
    expect(wrapCommandText('hi', { kind: 'task-notification' })).toContain(
      'A background agent completed a task',
    )
    expect(wrapCommandText('hi', { kind: 'coordinator' })).toContain(
      'The coordinator sent a message',
    )
  })
})
