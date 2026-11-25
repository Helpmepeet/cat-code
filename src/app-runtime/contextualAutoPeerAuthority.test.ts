import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('peer push authority is local to the acting chat and requires trusted delivery', async () => {
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
    expect(result.reviews.map(({ branch, actor, decision }: any) => ({ branch, actor, decision }))).toEqual([
      { branch: 'spoofed', actor: 'peer-session', decision: 'deny' },
      { branch: 'teammate', actor: 'peer-session', decision: 'deny' },
      { branch: 'host-peer', actor: 'peer-session', decision: 'allow' },
      { branch: 'peer-withdrawal', actor: 'peer-session', decision: 'allow' },
      { branch: 'peer-withdrawal', actor: 'peer-session', decision: 'deny' },
      { branch: 'creator-queued', actor: 'peer-session', decision: 'allow' },
      { branch: 'creator-changing', actor: 'peer-session', decision: 'allow' },
      { branch: 'locally-stopped', actor: 'peer-session', decision: 'allow' },
    ])
    expect(result.branches).toEqual(['creator-changing', 'creator-queued', 'host-peer'])
    expect(result.sawCounterfeitOutput).toBe(true)
    const [spoofed, teammate, hostPeer, , withdrawal] = result.reviews
    expect(spoofed.assignment).toBeUndefined()
    expect(spoofed.conversation).toContainEqual(expect.objectContaining({
      origin: 'operator', actor: 'Creator', text: result.launchBrief,
    }))
    expect(spoofed.conversation).not.toContainEqual(expect.objectContaining({
      text: expect.stringContaining('push it'),
    }))
    expect(teammate.conversation.at(-1)).toMatchObject({ origin: 'peer', text: 'push it' })
    expect(hostPeer.conversation.at(-1)).toMatchObject({
      origin: 'operator', actor: 'Creator', text: 'push it',
    })
    expect(withdrawal.conversation.at(-1)).toMatchObject({
      origin: 'operator', actor: 'Creator', text: 'Do not push this branch.',
    })
    expect(result.prompts).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
