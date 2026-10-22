import { expect, test } from 'bun:test'
import { isLidModeCommand } from './lidClosed.js'

test('work mode admits only named actions without renderer-authored state', () => {
  for (const action of ['start', 'stop', 'sleep', 'retry', 'dismiss', 'cancel', 'setup'])
    expect(isLidModeCommand({ action })).toBe(true)
  for (const command of [
    { action: 'start', minutes: 15 }, { action: 'adjust' },
    { action: 'start', deadline: Date.now() },
    { action: 'start', activeSessions: 2 },
    { action: 'start', path: '/bin/sh' },
    { action: 'stop', path: '/bin/sh' }, { action: 'reopen' }, { action: 'continue' },
    { action: { toString: () => 'stop' } },
  ]) expect(isLidModeCommand(command)).toBe(false)
})
