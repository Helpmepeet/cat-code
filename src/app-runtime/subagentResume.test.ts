import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function run(scenario: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'subagent-resume-')))
  const workspace = join(root, 'workspace')
  const config = join(root, 'config')
  try {
    await Promise.all([mkdir(workspace), mkdir(config)])
    const child = Bun.spawn([
      process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW',
      new URL('./subagentResume.fixture.ts', import.meta.url).pathname, scenario,
    ], {
      cwd: workspace, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
        HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', ENABLE_TOOL_SEARCH: 'false',
      },
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout))
    if (code !== 0) throw new Error(`Subagent resume fixture (${scenario}) failed (${code})\n${stderr}\n${stdout}`)
    return JSON.parse(stdout) as {
      result: { success: boolean; message: string }
      workerTools: string[][]
      reviews: Array<{ action: { tool: string }; assignment?: { text: string }; conversation: Array<{ origin: string; actor?: string; text: string }> }>
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each([
  ['denied', /fixture-worker.*denied.*Agent\(fixture-worker\)/],
  ['missing', /fixture-worker.*no longer available/],
  ['legacy', /the original tool list was not recorded/],
] as const)('ResumeAgent refuses a %s worker before a new worker request', async (scenario, reason) => {
  const evidence = await run(scenario)
  expect(evidence.result.success).toBe(false)
  expect(evidence.result.message).toMatch(reason)
  expect(evidence.workerTools).toHaveLength(1)
}, 20_000)

test('ResumeAgent keeps the original tool ceiling when the current role widens', async () => {
  const evidence = await run('expanded')
  expect(evidence.result.success).toBe(true)
  expect(evidence.workerTools).toHaveLength(2)
  expect(evidence.workerTools[0]).toContain('Bash')
  expect(evidence.workerTools[0]).not.toContain('Read')
  expect(evidence.workerTools[1]).toContain('Bash')
  expect(evidence.workerTools[1]!.filter(tool => !evidence.workerTools[0]!.includes(tool))).toEqual([])
}, 20_000)

test('the Auto reviewer sees a current resume brief and separately attributed worker history', async () => {
  const evidence = await run('retained')
  expect(evidence.result.success).toBe(true)
  const review = evidence.reviews.find(entry => entry.action.tool === 'Bash')
  expect(review?.assignment?.text).toBe('Current worker brief: check the new fixture condition.')
  expect(review?.conversation).toContainEqual(expect.objectContaining({
    origin: 'other', actor: 'worker history', text: 'Original worker brief: inspect the isolated workspace.',
  }))
  expect(review?.conversation).not.toContainEqual(expect.objectContaining({
    origin: 'operator', text: 'Original worker brief: inspect the isolated workspace.',
  }))
}, 20_000)
