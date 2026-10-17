import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'

test('desktop installation subprocess branches receive the owned remaining budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'installation-budget-'))
  const config = join(root, 'config')
  mkdirSync(config)
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CATCODE_')))
  const child = Bun.spawn(['bun', ...SIDECAR_RUNTIME_ARGS, resolve('app/sidecar/installationBudget.fixture.ts')], {
    cwd: root, env: { ...inherited, HOME: root, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SIMPLE: '1',
      DISABLE_INSTALLATION_CHECKS: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout.trim()).calls).toHaveLength(11)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
