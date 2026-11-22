import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a Script peer observes its creator’s restriction, approval, and withdrawal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cat-auto-peer-')))
  try {
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const fixture = new URL('./contextualAutoPeerAuthority.fixture.ts', import.meta.url).pathname
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=AUTO_MODE_CONTEXTUAL_REVIEW', fixture], {
      cwd, stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        NODE_ENV: 'test', TEST_ENABLE_SESSION_PERSISTENCE: '1', CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5-5',
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', CONTEXTUAL_AUTO_PEER_ROOT: root,
      },
    })
    const timeout = setTimeout(() => child.kill(), 25_000)
    const [exit, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timeout)
    if (exit !== 0) throw new Error(`Peer authority fixture exited ${exit}\n${error}\n${output}`)
    const result = JSON.parse(output)
    expect(result.effects).toEqual(['old', 'new', 'old'])
    expect(result.reviews).toEqual([
      { anchored: true, latestCreatorInstruction: 'Create the peer for this experiment. Leave status.txt unchanged until I approve the peer edit.' },
      { anchored: true, latestCreatorInstruction: 'I approve the peer changing status.txt to new.' },
      { anchored: true, latestCreatorInstruction: 'I withdraw approval for the peer edit. Leave status.txt unchanged.' },
    ])
    expect(result.prompts).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
