import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const harness = readFileSync(new URL('./hardening-smoke.ts', import.meta.url), 'utf8')
const runner = readFileSync(new URL('./run-hardening-smoke.ts', import.meta.url), 'utf8')

test('hardening summary names the renderer and main-process policy scope', () => {
  const success = '[hardening-smoke] renderer document + main-process policy passed'

  expect(harness).toContain(success)
  expect(runner).toContain(success)
  expect(harness).not.toContain('[hardening-smoke] production path passed')
  expect(runner).not.toContain('production-path assertions did not pass')
})
