import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withCodingEvidence(scenario: string, check: (evidence: any, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-host-')))
  try {
    await mkdir(join(root, 'config'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeMode.fixture.ts', import.meta.url).pathname], {
      cwd: workspace, stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CODE_MODE_TEST_ROOT: root,
        CODE_MODE_TEST_SCENARIO: scenario },
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Code Mode fixture failed (${code}): ${stderr}\n${stdout}`)
    await check(JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')), workspace)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('real-engine Code Mode catches Bash failure, executes the next effect, and retains variables', async () => {
  await withCodingEvidence('coding', async (evidence, workspace) => {
    const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
    expect(results).toHaveLength(2)
    expect(results[0].status).toBe('completed')
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).caught).toBe(true)
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).failedDiagnostic).toContain('diagnostic-from-failed-test')
    expect(JSON.parse(results[0].output.split('\n\n[Code Mode]')[0]).failed).toBe(true)
    expect(results[0].calls.map((call: any) => call.status)).toEqual(['completed', 'completed', 'completed', 'failed', 'failed', 'completed'])
    expect(await readFile(join(workspace, 'sample.txt'), 'utf8')).toBe('after\n')
    expect(results[0].changedFiles).toContainEqual({ path: join(workspace, 'sample.txt') })
    expect(await readFile(join(workspace, 'survived.txt'), 'utf8')).toBe('survived')
    expect(results[1].error).toBeUndefined()
    expect(results[1].status).toBe('completed')
    const retained = JSON.parse(results[1].output.split('\n\n[Code Mode]')[0])
    expect(retained.retained).toBe(true)
    expect(retained.discovery.schemaComplete).toBe(true)
    expect(retained.discovery.inputSchema.properties.command).toBeDefined()
    for (const message of evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode')) {
      expect(message.message.content.find((block: any) => block.type === 'tool_result').content).toBe(message.toolUseResult.output)
    }
    expect(evidence.transcript.filter((message: any) => message.codeMode).every((message: any) => message.isVirtual)).toBe(true)
    expect(evidence.transcript.filter((message: any) => message.codeMode)).toHaveLength(12)
    expect(evidence.transcript.findIndex((message: any) => message.codeMode)).toBeLessThan(
      evidence.transcript.findIndex((message: any) => message.toolUseResult?.kind === 'code-mode'),
    )
  })
}, 35_000)

test('partial Code Mode receipt lists the real notebook edit and excludes the failed one', async () => {
  await withCodingEvidence('notebook', async (evidence, workspace) => {
    const notebookPath = join(workspace, 'analysis.ipynb')
    expect(JSON.parse(await readFile(notebookPath, 'utf8')).cells[0].source).toBe('After')
    expect(JSON.parse(await readFile(join(workspace, 'unread.ipynb'), 'utf8')).cells[0].source).toBe('Before')
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode')?.toolUseResult
    expect(result).toMatchObject({
      status: 'failed', error: expect.stringContaining('Notebook fixture stopped'),
      calls: [{ name: 'NotebookEdit', status: 'completed' }, { name: 'NotebookEdit', status: 'failed' }],
      changedFiles: [{ path: notebookPath }],
    })
  })
}, 35_000)
