import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const answer = [
  'Storage multiplies an already-millisecond deadline by 1,000.',
  'The expiry comparison is correct.',
]
const fixture = fileURLToPath(new URL('./delegatedFinalAnswer.fixture.ts', import.meta.url))

async function runFixture(scenario: 'single' | 'synchronous' | 'background') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delegated-answer-')))
  const workspace = join(root, 'workspace')
  const config = join(root, 'config')
  try {
    await Promise.all([mkdir(workspace), mkdir(config)])
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', fixture, scenario], {
      cwd: workspace,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
        HOME: root,
        TMPDIR: root,
        CLAUDE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: config,
        ANTHROPIC_BASE_URL: 'https://delegated-answer.invalid',
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Delegated answer fixture exited with ${code}\n${stderr}\n${stdout}`)
      return JSON.parse(stdout) as { synchronous?: string[]; notification?: string; taskOutput?: string }
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('the synchronous Agent receipt preserves every final text block in provider order', async () => {
  expect((await runFixture('synchronous')).synchronous).toEqual(answer)
}, 20_000)

test('the background notification and TaskOutput deliver the same complete final answer', async () => {
  expect(await runFixture('background')).toEqual({
    notification: answer.join('\n'),
    taskOutput: answer.join('\n'),
  })
}, 20_000)

test('a single-block worker answer reaches the parent unchanged', async () => {
  expect((await runFixture('single')).synchronous).toEqual([answer[1]])
}, 20_000)
