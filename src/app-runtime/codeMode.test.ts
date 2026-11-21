import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function runCodingFixture(root: string, scenario: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeMode.fixture.ts', import.meta.url).pathname], {
    cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CODE_MODE_TEST_ROOT: root,
      CODE_MODE_TEST_SCENARIO: scenario, ...env },
  })
  const timer = setTimeout(() => child.kill(), 30_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`Code Mode fixture failed (${code}): ${stderr}\n${stdout}`)
  return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
}

async function withCodingEvidence(scenario: string, check: (evidence: any, workspace: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-host-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    await check(await runCodingFixture(root, scenario, env), join(root, 'workspace'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('Script discovery ranks exact names and aliases above text matches', async () => {
  await withCodingEvidence('search-exact', async evidence => {
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode')?.toolUseResult
    expect(result?.status).toBe('completed')
    expect(JSON.parse(result.output.split('\n\n[Code Mode]')[0])).toEqual({
      name: 'Bash',
      alias: 'SendUserMessage',
      partial: 'apply_patch',
    })
  })
}, 35_000)

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

for (const [setting, expectedPeak] of [[undefined, 10], ['2', 2], ['20', 10], ['0', 10]] as const) {
  test(`Script limits parallel Glob calls to ${expectedPeak} with concurrency setting ${setting ?? 'unset'}`, async () => {
    await withCodingEvidence('parallel-glob', async (evidence, workspace) => {
      expect(evidence.peakGlob).toBe(expectedPeak)
      expect(evidence.globTrace.slice(0, expectedPeak)).toEqual(Array.from(
        { length: expectedPeak }, (_, index) => index === 1 ? 'start:fail.txt' : `start:file-${index}.txt`,
      ))
      expect(evidence.globTrace.indexOf(`start:file-${expectedPeak}.txt`)).toBeGreaterThan(expectedPeak)
      expect(evidence.globTrace.at(-2)).toBe('start:created.txt')
      expect(await readFile(join(workspace, 'created.txt'), 'utf8')).toBe('created')
      const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
      expect(result.status).toBe('completed')
      expect(result.calls).toHaveLength(13)
      expect(result.calls.filter((call: any) => call.status !== 'completed')).toMatchObject([
        { name: 'Glob', input: { pattern: 'fail.txt' }, status: 'failed' },
      ])
      expect(JSON.parse(result.output.split('\n\n[Code Mode]')[0])).toEqual({ failed: true, found: ['created.txt'] })
      const audit = evidence.transcript.filter((message: any) => message.codeMode)
      const writeStart = audit.findIndex((message: any) => message.type === 'assistant' && message.message.content[0].name === 'Write')
      expect(audit.slice(0, writeStart).filter((message: any) => message.type === 'user')).toHaveLength(11)
    }, {
      CODE_MODE_TEST_EXPECTED_GLOB_OVERLAP: String(expectedPeak),
      ...(setting === undefined ? {} : { CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: setting }),
    })
  }, 35_000)
}

test('final-input instructions fence queued Glob and Write calls before their effects', async () => {
  await withCodingEvidence('parallel-glob-fence', async evidence => {
    expect(evidence.globTrace).toEqual([])
    expect(evidence.forbidden).toBeNull()
    const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
    expect(result.status).toBe('yielded')
    expect(result.calls.map((call: any) => call.status)).toEqual(['blocked', 'blocked', 'blocked'])
    expect(JSON.stringify(evidence.modelBodies)).toContain('PARALLEL-GLOB-INSTRUCTIONS')
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

test('a new chat starts in Code Mode and Script retains the real coding tools', async () => {
  await withCodingEvidence('code-first', async (evidence, workspace) => {
    const names = evidence.modelBodies.map((body: { tools: { name: string }[] }) =>
      body.tools.map(tool => tool.name))
    expect(names).toHaveLength(2)
    for (const request of names) {
      expect(request).toContain('REPL')
      expect(request).toContain('TaskStop')
      for (const name of ['Bash', 'Read', 'Write', 'Edit']) expect(request).not.toContain(name)
    }
    expect(await readFile(join(workspace, 'sample.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(workspace, 'survived.txt'), 'utf8')).toBe('survived')
  })
}, 35_000)

test('new Code Mode chats reopen in Code Mode without enabling it on older chats', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-restore-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const chat = crypto.randomUUID()
    const run = (id: string, fresh = false, ephemeral = false) => runCodingFixture(root, 'code-first-reopen', {
      CODE_MODE_TEST_CHAT_ID: id,
      CODE_MODE_TEST_FRESH: fresh ? '1' : '0',
      CODE_MODE_TEST_EPHEMERAL: ephemeral ? '1' : '0',
    })
    const names = (evidence: { modelBodies: { tools: { name: string }[] }[] }) =>
      evidence.modelBodies[0]!.tools.map(tool => tool.name)
    expect(names(await run(chat, true))).not.toContain('Bash')
    const saved = join(root, 'config', 'code-mode-preferences', `${chat}.mode`)
    expect((await stat(saved)).mode & 0o077).toBe(0)
    expect(names(await run(chat))).not.toContain('Bash')
    const other = crypto.randomUUID()
    expect(names(await run(other))).toContain('Bash')
    expect(names(await run(other, true, true))).not.toContain('Bash')
    expect(names(await run(other))).toContain('Bash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 35_000)

test('a new persistent chat keeps its direct tools when Code Mode enrollment cannot be saved', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-save-failed-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    await writeFile(join(root, 'config', 'code-mode-preferences'), 'not a directory')
    const evidence = await runCodingFixture(root, 'code-first-reopen', {
      CODE_MODE_TEST_CHAT_ID: crypto.randomUUID(),
      CODE_MODE_TEST_FRESH: '1',
    })
    expect(evidence.modelBodies[0].tools.map((tool: { name: string }) => tool.name)).toContain('Bash')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 35_000)
