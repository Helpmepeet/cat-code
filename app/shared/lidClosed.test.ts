import { expect, test } from 'bun:test'
import { isLidModeCommand } from './lidClosed.js'

test('timed mode admits only fixed presets and named operations, without renderer-authored paths', () => {
  expect(isLidModeCommand({ action: 'start', minutes: 15 })).toBe(true)
  expect(isLidModeCommand({ action: 'stop' })).toBe(true)
  for (const command of [
    { action: 'start', minutes: 0 }, { action: 'start', minutes: 1 },
    { action: 'stop', path: '/bin/sh' }, { action: 'reopen' }, { action: 'continue' },
    { action: { toString: () => 'stop' } },
  ]) expect(isLidModeCommand(command)).toBe(false)
})
