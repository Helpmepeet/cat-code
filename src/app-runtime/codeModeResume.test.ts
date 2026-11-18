import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

function launch(root: string, phase: string, sourcePath = '') {
  return Bun.spawn([process.execPath, '--feature=CODE_MODE', new URL('./codeModeResume.fixture.ts', import.meta.url).pathname], {
    cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
      CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
      ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      CODE_MODE_TEST_ROOT: root, CODE_MODE_RESUME_PHASE: phase, CODE_MODE_SOURCE_PATH: sourcePath },
  })
}

test('real persisted background receipt becomes uncertain after process death; resume and fork reset without replay', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-resume-')))
  let crashed: ReturnType<typeof launch> | undefined
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    crashed = launch(root, 'crash')
    const child = crashed
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    const ready = await Promise.race([
      (async () => {
        while (child.exitCode === null) {
          try { return JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
          catch { await Bun.sleep(20) }
        }
        throw new Error(`Crash fixture exited (${child.exitCode}) before its persisted audit was ready`)
      })(),
      child.exited.then(async code => { throw new Error(`Crash fixture exited (${code}): ${await new Response(child.stderr).text()}`) }),
    ])
    clearTimeout(timer)
    const source = await readFile(ready.sourcePath, 'utf8')
    expect(source).toContain('"status":"running"')
    const rows = source.trim().split('\n').map(line => JSON.parse(line))
    const writeRequest = rows.find(row => row.type === 'assistant' && row.codeMode &&
      row.message.content.some((block: any) => block.type === 'tool_use' && block.name === 'Write'))
    const writeReceipt = rows.find(row => row.sourceToolAssistantUUID === writeRequest?.uuid && row.type === 'user')
    expect(writeReceipt?.toolUseResult).toMatchObject({ omitted: true, reason: 'Cumulative Code Mode audit payload limit' })
    expect(await readFile(join(root, 'workspace', 'finished.txt'), 'utf8')).toBe('written before interruption '.repeat(1800))
    await mkdir(join(root, 'fork-source'))
    const forkSource = join(root, 'fork-source', basename(ready.sourcePath))
    await writeFile(forkSource, source)
    child.kill('SIGKILL')
    await child.exited
    crashed = undefined
    for (const phase of ['resume', 'fork']) {
      const restored = launch(root, phase, phase === 'resume' ? ready.sourcePath : forkSource)
      const stop = setTimeout(() => restored.kill('SIGKILL'), 20_000)
      const [code, stdout, stderr] = await Promise.all([restored.exited, new Response(restored.stdout).text(), new Response(restored.stderr).text()])
      clearTimeout(stop)
      if (code !== 0) throw new Error(`${phase} failed (${code}): ${stderr}\n${stdout}`)
      const evidence = JSON.parse(await readFile(join(root, `${phase}-evidence.json`), 'utf8'))
      const oldReceipts = evidence.restoredBeforeTurn.filter((message: any) => message.toolUseResult?.cellId === 'crash-cell')
      expect(oldReceipts.at(-1).toolUseResult.status).toBe('failed')
      expect(oldReceipts.at(-1).toolUseResult.output).toContain('final outcome is unknown')
      const attempt = oldReceipts.at(-1).toolUseResult.calls.find((call: any) => call.name === 'Bash')
      expect(attempt?.error).toContain('Outcome unknown')
      expect(oldReceipts.at(-1).toolUseResult.changedFiles).toEqual([{ path: join(root, 'workspace', 'finished.txt') }])
      expect(JSON.stringify(evidence.bodies[0].messages)).not.toContain(attempt.toolUseId)
      expect(JSON.stringify(evidence.bodies[0].messages)).toContain('empty interpreter variables and functions')
      const final = evidence.transcript.find((message: any) => message.toolUseResult?.cellId === 'restored-cell').toolUseResult
      expect(final.status).toBe('completed')
      expect(final.output).toContain('"prior":"undefined"')
      expect(evidence.bodies).toHaveLength(2)
      if (phase === 'resume') expect(evidence.sessionId).toBe(ready.sessionId)
      else expect(evidence.sessionId).not.toBe(ready.sessionId)
    }
  } finally {
    if (crashed) { crashed.kill('SIGKILL'); await crashed.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 65_000)

for (const phase of ['headless-eof-fault', 'headless-legacy']) {
  test(`structured headless ${phase === 'headless-legacy' ? 'replays legacy Script provenance' : 'ends with a failure when late receipt acknowledgement fails'}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-headless-')))
    try {
      await mkdir(join(root, 'config'))
      await mkdir(join(root, 'workspace'))
      const child = launch(root, phase)
      const timer = setTimeout(() => child.kill('SIGKILL'), 13_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      if (code !== 0) throw new Error(`${phase} failed (${code}): ${stderr}\n${stdout}`)
      const evidence = JSON.parse(await readFile(join(root, `${phase}-evidence.json`), 'utf8'))
      if (phase === 'headless-legacy') {
        const row = evidence.projected.find((frame: any) => frame.uuid === evidence.legacyUuid)
        expect(row.origin).toMatchObject({ kind: 'task-notification', summary: 'Background Script outcome unknown', toolUseId: 'legacy-script' })
      } else {
        expect(evidence.writeAttempts).toBeGreaterThan(0)
        const results = evidence.frames.filter((frame: any) => frame.type === 'result')
        expect(results.map((frame: any) => frame.subtype)).toEqual(['error_during_execution'])
        expect(results[0].errors[0]).toContain('Could not save all tool results before input closed')
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 16_000)
}

test('real resume preserves virtual child call/result and authenticated refusal ancestry', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-audit-resume-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    for (const phase of ['foreground', 'resume']) {
      const ready = phase === 'resume' ? JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) : undefined
      const child = launch(root, phase, ready?.sourcePath)
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      if (code !== 0) throw new Error(`Audit ${phase} failed (${code}): ${stderr}\n${stdout}`)
    }
    const seed = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8'))
    expect(seed.transcript.filter((message: any) => message.codeMode)).toHaveLength(2)
    const restored = JSON.parse(await readFile(join(root, 'resume-evidence.json'), 'utf8'))
    expect(restored.restoredBeforeTurn.filter((message: any) => message.codeMode)).toHaveLength(2)
    const refusal = restored.restoredBeforeTurn.find((message: any) => message.permissionDecision?.toolName === 'Bash')
    expect(refusal?.isVirtual).toBe(true)
    expect(restored.restoredBeforeTurn.some((message: any) => message.uuid === refusal.permissionDecision.assistantUuid && message.codeMode)).toBe(true)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 45_000)

test('real loader retains interleaved background audits only on selected ancestry through rewind and fork', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-history-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    async function run(phase: string, source = '') {
      const child = launch(root, phase, source)
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      clearTimeout(timer)
      if (code !== 0) throw new Error(`History ${phase} failed (${code}): ${stderr}\n${stdout}`)
      return JSON.parse(await readFile(join(root, `${phase}-evidence.json`), 'utf8'))
    }
    const history = await run('history')
    function assertSelected(messages: any[], decisions: any[], normalized: any) {
      expect(messages.filter(message => message.codeMode).map(message => message.uuid)).toEqual(history.selectedAuditIds)
      expect(messages.some(message => history.abandonedAuditIds.includes(message.uuid))).toBe(false)
      expect(decisions).toHaveLength(1)
      expect(decisions[0].toolUseId).toBe('refusal-selected')
      const refusal = messages.find(message => message.permissionDecision)
      expect(refusal.isVirtual).toBe(true)
      expect(refusal.sourceToolAssistantUUID).toBe(decisions[0].assistantUuid)
      expect(messages.some(message => message.uuid === decisions[0].assistantUuid && message.codeMode && message.isVirtual)).toBe(true)
      for (const provider of ['firstParty', 'openai']) {
        const text = JSON.stringify(normalized[provider])
        expect(text).toContain('ordinary visible result')
        expect(text).toContain('selected background output')
        expect(text).not.toContain('hidden-payload')
        expect(text).not.toContain('hidden-command')
      }
    }
    assertSelected(history.restored, history.decisions, history.normalized)
    expect(history.rewound.filter((message: any) => message.codeMode)).toEqual([])
    const rows = (await readFile(history.sourcePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const ordinaryResult = rows.find(row => row.uuid === history.ordinaryResultUuid)
    const outerResult = rows.find(row => row.uuid === history.completionUuid)
    expect(ordinaryResult.parentUuid).toBe(history.selectedAuditIds[1])
    expect(ordinaryResult.sourceToolAssistantUUID).toBe(history.ordinaryCallUuid)
    expect(outerResult.parentUuid).toBe(history.ordinaryResultUuid)
    expect(outerResult.sourceToolAssistantUUID).toBe(history.outerUuid)
    const fork = await run('fork', history.sourcePath)
    expect(fork.sessionId).not.toBe(history.sessionId)
    assertSelected(fork.restoredBeforeTurn, fork.decisions, fork.normalized)
    expect(fork.bodies).toHaveLength(2)
    const resumedFork = await run('resume', fork.sourcePath)
    expect(resumedFork.sessionId).toBe(fork.sessionId)
    assertSelected(resumedFork.restoredBeforeTurn, resumedFork.decisions, resumedFork.normalized)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 65_000)
