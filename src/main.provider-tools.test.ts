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

// `initialMainLoopModel` comes from getUserSpecifiedModelSetting(), which
// includes settings.json. Passing it as the explicit-selection flag meant
// `{"model":"sonnet"}` beat CLAUDE_CODE_USE_OPENAI=1 and silently routed every
// request to Anthropic. Startup runs inside runCli() with process-wide MCP,
// hooks, and auth, so it has no unit-test seam; this pins the argument the
// same way the ordering test above pins the callsite.
test('a settings-file model is not treated as a startup provider selection', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const call = source.slice(
    source.indexOf('setSessionProvider(\n      resolveStartupProvider('),
  )
  const explicitFlag = call.split('\n')[3]

  expect(explicitFlag).not.toContain('initialMainLoopModel')
  expect(source).toContain(
    'const hasExplicitStartupModel =\n      effectiveModel !== undefined || getModelEnvOverride() !== undefined;',
  )
})
