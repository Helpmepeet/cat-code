import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const hooked of [false, true]) {
  test(`real MCP Code Mode preserves ${hooked ? 'PostToolUse replacement' : 'bounded structured output'} and current-pool discovery`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-mcp-')))
    try {
      await mkdir(join(root, 'config'))
      await mkdir(join(root, 'workspace'))
      const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeModeMcpIntegration.fixture.ts', import.meta.url).pathname], {
        cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
        env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
          ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CODE_MODE_TEST_ROOT: root,
          CODE_MODE_MCP_HOOK: hooked ? '1' : '0' },
      })
      const timer = setTimeout(() => child.kill(), 30_000)
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      if (exit !== 0) throw new Error(`MCP integration fixture failed (${exit}): ${stderr}\n${stdout}`)
      const evidence = JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
      const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode')
      expect(results).toHaveLength(2)
      expect(JSON.parse(results[1].toolUseResult.output.split('\n\n[Code Mode]')[0])).toEqual({ revoked: [true, true] })
      expect(results[0].toolUseResult.status, JSON.stringify(results[0].toolUseResult)).toBe('completed')
      const selected = JSON.parse(results[0].toolUseResult.output.split('\n\n[Code Mode]')[0])
      expect(selected.search).toMatchObject({ complete: true, matchingTools: 2, discoveryScope: 'current-executable-pool' })
      expect(selected.search.matches.map((match: any) => match.name).sort()).toEqual(['mcp__fixture__records', 'mcp__fixture__save'])
      expect(selected.descriptionSearch).toMatchObject({ complete: false, matchingTools: 2, returned: 1, discoveryScope: 'current-executable-pool' })
      expect(selected.descriptionSearch.matches).toHaveLength(1)
      const capability = selected.descriptionSearch.matches[0]
      expect(['mcp__fixture__records', 'mcp__fixture__save']).toContain(capability.name)
      expect(capability.about).toContain('integration')
      expect(capability.about).not.toBe(capability.name)
      expect(capability.about.length).toBeLessThanOrEqual(512)
      expect(selected.schema).toMatchObject({ schemaComplete: true, inputSchema: { type: 'object', properties: { key: { type: 'string', enum: ['sample'] } }, required: ['key'], additionalProperties: false } })
      expect(selected.rejected).toEqual([true, true, true])
      expect(evidence.permissions).toEqual([])
      expect(await readFile(join(root, 'workspace', 'mcp-effect.txt'), 'utf8')).toBe('saved-by-real-mcp')
      const calls = (await readFile(join(root, 'mcp-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(calls.map(call => call.name)).toEqual(['records', 'save'])
      expect(JSON.stringify(selected)).not.toContain('MCP_META_PRIVATE')
      for (const result of [selected.record, selected.saved]) {
        expect(result.isError).toBe(false)
        if (hooked) {
          expect(JSON.stringify(result)).toContain('EFFECTIVE_SELECTED_MARKER')
          expect(JSON.stringify(result)).not.toContain('PRE_HOOK_PRIVATE')
        } else {
          expect(result.structuredContent).toEqual({ marker: 'PRE_HOOK_PRIVATE_DATA', rows: ['one', 'two'], count: 2 })
          expect(result.structuredContentComplete).toBe(true)
        }
      }
      const wire = JSON.stringify(evidence.modelBodies)
      const restoredWire = JSON.stringify(evidence.restoredProjection.map((message: any) => message.message))
      const children = evidence.transcript.filter((message: any) => message.codeMode)
      expect(children.length).toBeGreaterThan(0)
      for (const projected of [wire, restoredWire]) {
        expect(projected).not.toContain('MCP_META_PRIVATE')
        for (const message of children) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') expect(projected).not.toContain(block.id)
          }
        }
        if (hooked) {
          expect(projected).not.toContain('PRE_HOOK_PRIVATE')
          expect(projected).toContain('EFFECTIVE_SELECTED_MARKER')
        }
      }
      expect(children.every((message: any) => message.isVirtual)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 35_000)
}
