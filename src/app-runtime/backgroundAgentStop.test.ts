import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.each(['direct', 'script', 'approval', 'force-send'])('desktop turn interruption respects background agent ownership (%s)', async scenario => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'background-agent-stop-')))
  const workspace = join(home, 'workspace')
  const config = join(home, 'config')
  try {
    await Promise.all([mkdir(workspace), mkdir(config)])
    const child = Bun.spawn([
      process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW',
      new URL('./backgroundAgentStop.fixture.ts', import.meta.url).pathname, scenario,
    ], {
      cwd: workspace, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
        HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: config,
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', ENABLE_TOOL_SEARCH: 'false',
      },
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout))
    if (code !== 0) throw new Error(`Background agent stop fixture failed (${code})\n${stderr}\n${stdout}`)
    const forceSend = scenario === 'force-send'
    expect(JSON.parse(stdout)).toMatchObject({
      statusesBefore: { earlier: 'running', current: 'running' },
      statusesAfterStop: { earlier: 'running', current: forceSend ? 'running' : 'killed' },
      finalEarlierStatus: 'completed',
      finalCurrentStatus: forceSend ? 'completed' : 'killed',
      currentMarker: forceSend ? 'fixture' : null,
      ...(scenario === 'approval'
        ? { earlierApprovalSurvived: true, earlierApprovalAccepted: true }
        : { earlierMarker: 'fixture' }),
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
