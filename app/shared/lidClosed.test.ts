import { expect, test } from 'bun:test'
import { isLidModeCommand } from './lidClosed.js'

test('timed mode admits only fixed presets and named operations, without renderer-authored paths', () => {
  for (const action of ['start', 'adjust'])
    for (const minutes of [5, 15, 30, 60, 120])
      expect(isLidModeCommand({ action, minutes })).toBe(true)
  expect(isLidModeCommand({ action: 'stop' })).toBe(true)
  for (const command of [
    { action: 'start', minutes: 0 }, { action: 'start', minutes: 1 },
    { action: 'start', minutes: 10 }, { action: 'adjust', minutes: 6 },
    { action: 'start', minutes: 5, path: '/bin/sh' },
    { action: 'stop', path: '/bin/sh' }, { action: 'reopen' }, { action: 'continue' },
    { action: { toString: () => 'stop' } },
  ]) expect(isLidModeCommand(command)).toBe(false)
})
