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

test('combined mode admits only closed preset targets', () => {
  for (const target of ['off', 'work', 15, 30, 60, 120])
    expect(isLidModeCommand({ action: 'set', target })).toBe(true)
  for (const target of [undefined, null, true, 0, 5, 16, 900, '15', 'timed', {}, Infinity, NaN])
    expect(isLidModeCommand({ action: 'set', target })).toBe(false)
  expect(isLidModeCommand({ action: 'set', target: 15, deadline: Date.now() })).toBe(false)
  expect(isLidModeCommand({ action: 'stop', target: 'off' })).toBe(false)
})
