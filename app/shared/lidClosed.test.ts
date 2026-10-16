import { expect, test } from 'bun:test'
import { isLidModeCommand } from './lidClosed.js'

test('reopen accepts a named action without allowing the renderer to choose executable or arguments', () => {
  expect(isLidModeCommand({ action: 'reopen' })).toBe(true)
  for (const extra of [{ path: '/tmp/other.app' }, { execPath: '/bin/sh' }, { args: ['--inspect'] }, { minutes: 15 }]) {
    expect(isLidModeCommand({ action: 'reopen', ...extra })).toBe(false)
  }
  expect(isLidModeCommand({ action: { toString: () => 'reopen' } })).toBe(false)
})
