import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// Startup runs inside runCli() with process-wide MCP, hooks, and auth, so the
// --agents block has no unit-test seam (same reason as
// main.provider-tools.test.ts). The parsing it delegates to is covered by
// tools/AgentTool/loadAgentsDir.test.ts; this pins the four-line adapter that
// turns a rejection into a message and a non-zero exit. The bug it guards is a
// swallowed parse: the session started with zero CLI agents and said nothing.
const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

test('an invalid --agents payload stops startup with an error on stderr', () => {
  const block = source.slice(
    source.indexOf('// Parse CLI agents if provided via --agents flag'),
    source.indexOf('// Merge CLI agents with existing ones'),
  )

  expect(block).toContain('parseAgentsFlag(agentsJson')
  expect(block).toContain('if (parseResult.errors.length > 0) {')
  expect(block).toContain(
    'process.stderr.write(`Error: Invalid agent configuration:\\n${details}\\n`)',
  )
  expect(block).toContain('process.exit(1)')
})

test('the --agents block does not swallow a failure', () => {
  const block = source.slice(
    source.indexOf('// Parse CLI agents if provided via --agents flag'),
    source.indexOf('// Merge CLI agents with existing ones'),
  )

  expect(block).not.toContain('catch')
})
