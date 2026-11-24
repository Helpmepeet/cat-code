import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.skipIf(process.platform === 'win32')('Stop during shell preparation closes output without starting the command', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-shell-cancellation-')))
  try {
    const fixture = fileURLToPath(new URL('./Shell.cancellation.fixture.ts', import.meta.url))
    const child = Bun.spawn([process.execPath, fixture], {
      cwd: root, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, CLAUDE_CODE_TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        CLAUDE_CODE_SHELL: '/bin/bash', CATCODE_SHELL_CANCEL_TEST_ROOT: root,
        NODE_ENV: 'test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    })
    const deadline = setTimeout(() => child.kill(), 10_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(deadline))
    if (code !== 0) throw new Error(`Cancellation fixture exited ${code}\n${stderr}\n${stdout}`)
    expect(JSON.parse(stdout)).toEqual({
      code: 145, interrupted: true, spawned: false, markerExists: false, outputExists: false, outputClosed: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 12_000)
