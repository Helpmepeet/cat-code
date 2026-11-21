import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('the guide provider request exposes feature states without raw settings', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'guide-request-')))
  const config = join(root, 'config')
  const workspace = join(root, 'workspace')
  const envMarker = 'isolated-guide-env-marker'
  const unrelatedMarker = 'isolated-guide-unrelated-setting-marker'
  try {
    await Promise.all([mkdir(config), mkdir(workspace)])
    await writeFile(join(config, 'settings.json'), JSON.stringify({
      env: { GUIDE_FIXTURE_ENV: envMarker },
      guideFixtureUnrelatedSetting: unrelatedMarker,
      disableAllHooks: true,
      alwaysThinkingEnabled: true,
      autoMemoryEnabled: false,
    }))
    const child = Bun.spawn([
      process.execPath,
      fileURLToPath(new URL('./guideAgentRequest.fixture.ts', import.meta.url)),
    ], {
      cwd: workspace,
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
        HOME: root,
        TMPDIR: root,
        CLAUDE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: config,
        ANTHROPIC_BASE_URL: 'https://guide-request.invalid',
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, request, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`Guide fixture exited with ${code}\n${stderr}`)
      expect(request).toContain('You are the Claude guide agent')
      expect([envMarker, unrelatedMarker].filter(marker => request.includes(marker))).toEqual([])
      expect(request).toContain('Hooks: disabled')
      expect(request).toContain('Always thinking: enabled')
      expect(request).toContain('Auto memory: disabled')
    } finally {
      clearTimeout(timeout)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
