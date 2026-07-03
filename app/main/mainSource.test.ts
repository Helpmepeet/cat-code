import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('normal Electron startup does not opt into the sidecar probe', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const createSupervisorStart = source.indexOf(
    'function createSupervisor(): SidecarSupervisor',
  )
  const createSupervisorEnd = source.indexOf(
    'function applySecurityBaseline(): void',
  )
  const createSupervisorSource = source.slice(
    createSupervisorStart,
    createSupervisorEnd,
  )

  expect(createSupervisorSource).not.toContain('CATCODE_SIDECAR_PROBE')
})
