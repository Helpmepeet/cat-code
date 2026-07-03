import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('every fixed renderer-to-main sender passes through the shared IPC guard', () => {
  const source = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

  expect(source).toContain("const CH_RESTART = 'catcode:restart'")
  expect(source).toContain('restart(sessionId: SessionId): void')
  expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(6)
})
