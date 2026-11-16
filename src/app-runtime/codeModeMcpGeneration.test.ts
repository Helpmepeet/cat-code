import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const scenario of ['compatible', 'narrow', 'principal'] as const) {
const narrowing = scenario === 'narrow'
const principal = scenario === 'principal'
test(principal ? 'a colliding model-facing name cannot inherit a different MCP principal grant' : `a current MCP schema ${narrowing ? 'surfaces server validation without performing a stale-input effect' : 'accepts still-valid input after a compatible refresh'}`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-mcp-generation-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeModeMcpIntegration.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CODE_MODE_TEST_ROOT: root,
        CODE_MODE_MCP_GENERATION: '1', CODE_MODE_MCP_NARROW: narrowing ? '1' : '0', CODE_MODE_MCP_PRINCIPAL: principal ? '1' : '0' },
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (exit !== 0) throw new Error(`MCP generation fixture failed (${exit}): ${stderr}\n${stdout}`)
    const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
    expect(evidence.refreshed).toBe(true)
    expect(evidence.refreshedSchema.properties.key.enum).toEqual(narrowing ? ['replacement'] : ['sample', 'replacement'])
    const calls = (await readFile(join(root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const outer = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
    if (principal) {
      expect(evidence.tools.find((tool: any) => tool.mcpInfo.toolName === 'records')).toMatchObject({ name: 'mcp__fixture_a__records', mcpInfo: { serverName: 'fixture.a', toolName: 'records' } })
      expect(evidence.refreshedPrincipal).toEqual({ serverName: 'fixture_a', toolName: 'records' })
      expect(calls.map(call => ({ name: call.name, principal: call.serverPrincipal })), JSON.stringify({ outer, permissions: evidence.permissions })).toEqual([{ name: 'save', principal: 'fixture.a' }])
      expect(outer.status).not.toBe('completed')
      if (evidence.permissions.length === 0) expect(JSON.stringify(outer)).toContain('principal')
      else expect(evidence.permissions).toHaveLength(1)
      expect(JSON.stringify(outer)).not.toContain('CURRENT_SCHEMA_VALIDATION')
      return
    }
    expect(calls.map(call => call.name), JSON.stringify({ outer, permissions: evidence.permissions })).toEqual(narrowing ? ['save'] : ['save', 'records'])
    expect(outer.status).toBe(narrowing ? 'failed' : 'completed')
    if (narrowing) expect(JSON.stringify(outer)).toContain('CURRENT_SCHEMA_VALIDATION')
    else {
      const selected = JSON.parse(outer.output.split('\n\n[Code Mode]')[0])
      expect(selected.reviewed.inputSchema.properties.key.enum).toEqual(['sample'])
      expect(selected.replacement.isError).toBe(false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 35_000)
}
