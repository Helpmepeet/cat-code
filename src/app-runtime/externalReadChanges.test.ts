import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the next turn reports outside edits to a fully read file', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'external-read-changes-')))
  const workspace = join(root, 'workspace')
  const config = join(root, 'config')
  try {
    await Promise.all([mkdir(workspace), mkdir(config)])
    const child = Bun.spawn([
      process.execPath,
      new URL('./externalReadChanges.fixture.ts', import.meta.url).pathname,
    ], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        CLAUDE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: config,
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential',
        CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        NODE_ENV: 'test',
        EXTERNAL_READ_CHANGES_TEST_ROOT: root,
      },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    if (exitCode !== 0) throw new Error(`External-read fixture failed (${exitCode}): ${stderr}\n${stdout}`)
    const evidence = JSON.parse(stdout) as { readResults: string[]; nextTurn: string }
    expect(evidence.readResults[0]).toContain('original-full-line')
    expect(evidence.readResults[1]).toContain('original-limited-line')
    expect(evidence.readResults[1]).not.toContain('hidden-line')
    expect(evidence.readResults[2]).toContain('original-offset-line')
    expect(evidence.readResults[2]).not.toContain('hidden-line')
    expect(evidence.readResults[3]).toContain('This is a partial view')
    expect(evidence.readResults[4]).toContain('original-grown-line')
    expect(evidence.readResults[4]).not.toContain('This is a partial view')

    expect(evidence.nextTurn).toContain(`Note: ${join(workspace, 'full.txt')} was modified`)
    expect(evidence.nextTurn).toContain('edited-full-line')
    for (const partial of ['limited', 'offset', 'truncated', 'grown']) {
      expect(evidence.nextTurn).not.toContain(`Note: ${join(workspace, `${partial}.txt`)} was modified`)
      expect(evidence.nextTurn).not.toContain(`edited-${partial}-line`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
