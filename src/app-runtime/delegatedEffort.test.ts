import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Scenario = 'inherited' | 'explicit' | 'low' | 'fork' | 'claude'
type ProviderRequest = {
  model: string
  reasoning?: { effort: string; summary?: string }
  thinking?: { type: string; display?: string }
}

async function runScenario(scenario: Scenario): Promise<ProviderRequest[]> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'delegated-effort-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([
      process.execPath,
      new URL('./delegatedEffort.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        CLAUDE_CODE_USE_OPENAI: scenario === 'claude' ? '0' : '1',
        ANTHROPIC_API_KEY: 'fixture-not-a-credential',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ENABLE_TOOL_SEARCH: 'false',
        DISABLE_TELEMETRY: '1',
        DELEGATED_EFFORT_TEST_ROOT: root, DELEGATED_EFFORT_SCENARIO: scenario,
      },
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Delegated effort fixture (${scenario}) failed (${code}): ${stderr}`)
      return JSON.parse(stdout)
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

for (const [scenario, expected] of [
  ['inherited', ['high', 'high', 'high']],
  ['explicit', ['medium', 'xhigh', 'medium']],
  ['low', ['high', 'low', 'high']],
  ['fork', ['low', 'low', 'low']],
] as const) {
  test(`Codex serializes ${scenario} worker effort without changing the parent's effort`, async () => {
    const requests = await runScenario(scenario)
    expect(requests.map(request => request.model)).toEqual(Array(3).fill('gpt-6.2-sol'))
    expect(requests.map(request => request.reasoning?.effort)).toEqual([...expected])
    if (scenario === 'fork') expect(requests[1]?.reasoning).toEqual({ effort: 'low' })
  }, 20_000)
}

test('Claude workers retain required adaptive thinking', async () => {
  const requests = await runScenario('claude')
  expect(requests.map(request => request.model)).toEqual(Array(3).fill('claude-opus-5-5'))
  expect(requests[1]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
}, 20_000)
