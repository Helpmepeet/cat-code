import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Auto script admission does not transfer across a real MCP canonical-principal collision', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-auto-mcp-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=TRANSCRIPT_CLASSIFIER', '--feature=AUTO_MODE_UPSTREAM_PORT', new URL('./codeModeAutoMcp.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        NODE_ENV: 'test', CLAUDE_CODE_AUTO_MODE_MODEL: 'sonnet', CODE_MODE_TEST_ROOT: root },
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (exit !== 0) throw new Error(`Auto MCP fixture failed (${exit}): ${stderr}\n${stdout}`)
    const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
    expect(results).toHaveLength(1)
    expect(evidence.classifierBodies.length, JSON.stringify({ results, reviews: evidence.reviews })).toBeGreaterThanOrEqual(2)
    expect(evidence.reviews).toContainEqual(expect.objectContaining({ toolUseId: 'auto-mcp-script', outcome: 'reviewing' }))
    expect(evidence.reviews).toContainEqual(expect.objectContaining({ toolUseId: 'auto-mcp-script', outcome: 'allowed' }))
    expect(await readFile(join(root, 'workspace', 'mcp-effect.txt'), 'utf8')).toBe('saved-by-real-mcp')
    expect(results[0].calls[0]).toMatchObject({ name: 'mcp__fixture_a__save', status: 'completed' })
    expect(evidence.reviews.some((review: any) => review.toolUseId === results[0].calls[0].toolUseId)).toBe(false)
    expect(evidence.refreshed).toBe(true)
    expect(evidence.originalPool).toContainEqual({ name: 'mcp__fixture_a__records', mcpInfo: { serverName: 'fixture.a', toolName: 'records' } })
    expect(evidence.replacementPool).toContainEqual({ name: 'mcp__fixture_a__records', mcpInfo: { serverName: 'fixture_a', toolName: 'records' } })
    const calls = (await readFile(join(root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls.map(call => ({ name: call.name, principal: call.serverPrincipal })), JSON.stringify({ results, reviews: evidence.reviews, permissions: evidence.permissions })).toEqual([{ name: 'save', principal: 'fixture.a' }])
    expect(results[0].status).not.toBe('completed')
    // A host principal fence or an explicit fresh authorization request is valid.
    // Unavailable-classifier failure is not: the outer review and old-principal
    // effect above must both succeed, and a no-prompt stop must name the fence.
    if (evidence.permissions.length === 0) expect(JSON.stringify(results[0])).toContain('principal')
    else expect(evidence.permissions).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 35_000)
