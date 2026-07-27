import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('startup resolves the session provider before selecting provider-sensitive tools', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const providerResolution = source.indexOf(
    'setSessionProvider(\n      resolveStartupProvider(',
  )
  const toolSelection = source.indexOf(
    'let tools = getTools(toolPermissionContext)',
  )

  expect(providerResolution).toBeGreaterThan(-1)
  expect(toolSelection).toBeGreaterThan(providerResolution)
})
