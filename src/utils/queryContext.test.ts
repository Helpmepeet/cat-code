import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('side-question fallback delivers instruction context once through the real fork query', async () => {
  // prependUserContext deliberately skips test mode. A child exercises the
  // production branch and keeps module spies/configuration out of other suites.
  const child = Bun.spawn([
    process.execPath,
    fileURLToPath(new URL('./fixtures/sideQuestionFallback.fixture.ts', import.meta.url)),
  ], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode).toBe(0)
  if (exitCode !== 0) throw new Error(stderr)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.rawHistoryLength).toBe(1)
  expect(result.fallbackHistoryLength).toBe(1)
  expect(result.fallbackInstructionCount).toBe(1)
  expect(result.savedHistoryInstructionCount).toBe(1)
  expect(result.openaiInstructionCount).toBe(1)
})
