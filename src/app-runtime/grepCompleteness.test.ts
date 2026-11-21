import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skipIf(process.platform === 'win32')('Grep discloses incomplete searches in the model request, including empty later pages', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grep-completeness-')))
  const workspace = join(root, 'workspace')
  const config = join(root, 'config')
  try {
    const small = join(workspace, 'small')
    await Promise.all([mkdir(small, { recursive: true }), mkdir(config)])
    await Promise.all([
      writeFile(join(small, 'first.txt'), 'killed-match\ntimeout-match\n'),
      writeFile(join(small, 'second.txt'), 'killed-match\ntimeout-match\n'),
      writeFile(join(workspace, 'large.txt'),
        `over-limit ${'x'.repeat(230)}\n`.repeat(110_000) + 'over-limit-final\n'),
      // Let real rg emit the matches, then make the subprocess fail with a
      // signal or block through the search deadline. Other searches use real rg.
      writeFile(join(root, 'rg'), `#!/bin/sh
case " $* " in
  *" killed-match "*) "$REAL_RG" "$@"; kill -KILL "$$" ;;
  *" timeout-match "*) "$REAL_RG" "$@"; exec /bin/sleep 30 ;;
  *" timeout-before-match "*) exec /bin/sleep 30 ;;
  *) exec "$REAL_RG" "$@" ;;
esac
`, { mode: 0o755 }),
    ])
    const realRg = Bun.which('rg') ?? join(import.meta.dir, '..', 'vendor', 'ripgrep', `${process.arch}-${process.platform}`, 'rg')
    const child = Bun.spawn([process.execPath, new URL('./grepCompleteness.fixture.ts', import.meta.url).pathname], {
      cwd: workspace,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        CLAUDE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: config,
        ANTHROPIC_API_KEY: 'isolated-credential-fixture',
        CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_GLOB_TIMEOUT_SECONDS: '3',
        USE_BUILTIN_RIPGREP: '0',
        REAL_RG: realRg,
        GREP_COMPLETENESS_TEST_ROOT: root,
      },
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    if (exit !== 0) throw new Error(`Grep fixture failed (${exit}): ${stderr}\n${stdout}`)

    const results = JSON.parse(stdout) as Record<string, string>
    expect(results).toEqual({
      killed: expect.stringContaining('Search incomplete.'),
      timeout: expect.stringContaining('Search incomplete.'),
      emptyTimeout: expect.stringMatching(/did not complete|\bincomplete\b/i),
      capped: expect.stringMatching(/(?=[\s\S]*over-limit x)(?=[\s\S]*reached its output limit)/i),
      laterPage: expect.stringMatching(/reached its output limit[\s\S]*No results were captured for this page\./i),
      finalLine: '110001:over-limit-final',
      noMatch: 'No files found',
    })
    expect(results.killed).toContain('small/first.txt')
    expect(results.killed).toContain('small/second.txt')
    expect(results.timeout).toContain('small/first.txt:1')
    expect(results.timeout).toContain('small/second.txt:1')
    expect(results.laterPage).not.toContain('No matches found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 25_000)
