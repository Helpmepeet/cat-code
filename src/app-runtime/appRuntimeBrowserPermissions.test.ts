import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../../app/main/mainDecisions.js'

test('desktop browser tools use the real permission path with resolved classifier descriptions and no worker capability', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'app-browser-permissions-')))
  try {
    await mkdir(join(root, 'config')); await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, ...SIDECAR_RUNTIME_ARGS,
      new URL('./appRuntimeBrowserPermissions.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-4-5',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', BROWSER_PERMISSIONS_TEST_ROOT: root },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Browser permission fixture failed (${code}): ${stderr}\n${stdout}`)
    const value = JSON.parse(stdout) as { results: Array<{ name: string; decision: string; description: string; bodies: string[] }>; dispatches: number; workerTools: string[] }
    expect(value.results).toHaveLength(4)
    for (const result of value.results) {
      expect(result.bodies.length).toBeGreaterThan(0)
      for (const body of result.bodies) { expect(body).toContain(result.description); expect(body).not.toContain('g1-e12') }
      expect(result.decision).not.toBe('allow')
      expect(value.workerTools).not.toContain(result.name)
    }
    expect(value.dispatches).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
