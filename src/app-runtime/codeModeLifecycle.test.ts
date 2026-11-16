import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function scenario(name: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'code-mode-lifecycle-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, '--feature=CODE_MODE', '--feature=AUTO_MODE_UPSTREAM_PORT', '--feature=TRANSCRIPT_CLASSIFIER', new URL(name.startsWith('worker') ? './codeModeWorker.fixture.ts' : './codeMode.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        CODE_MODE_TEST_ROOT: root, CODE_MODE_TEST_SCENARIO: name },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Code Mode ${name} fixture failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('new applicable instructions preflight before Read and cannot be caught away', async () => {
  const evidence = await scenario('instructions')
  const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
  expect(results[0].status).toBe('yielded')
  expect(results[0].calls).toHaveLength(2)
  expect(results[0].calls[0].status).toBe('blocked')
  expect(evidence.forbidden).toBeNull()
  expect(evidence.transcript.some((message: any) => message.type === 'attachment' && message.attachment.type === 'nested_memory')).toBe(true)
  expect(JSON.stringify(evidence.transcript.filter((message: any) => message.codeMode))).not.toContain('must-not-be-read')
  expect(results[1].status).toBe('completed')
}, 30_000)

test('guest-launched Agent has ordinary Auto review and model-visible worker Read delivery', async () => {
  const evidence = await scenario('worker')
  const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
  expect(results[0]?.status).toBe('completed')
  if (evidence.workerRequests.length !== 3) throw new Error(JSON.stringify({ requests: evidence.apiRequests, result: results[0] }))
  expect(evidence.workerRequests).toHaveLength(3)
  expect(JSON.stringify(evidence.workerRequests[1].messages)).toContain('model-visible-worker-read-marker')
  expect(evidence.workerOutput).toBe('ordinary-worker')
  expect(evidence.classifiers.some((request: any) => JSON.stringify(request.messages).includes('printf ordinary-worker > worker.txt'))).toBe(true)
}, 30_000)

test('Skill following instructions survive filtering and fence later operations with model change ordered', async () => {
  const evidence = await scenario('skill')
  const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
  expect(results[0]?.status).toBe('yielded')
  expect(results[0].calls).toHaveLength(2)
  expect(evidence.forbidden).toBeNull()
  expect(JSON.stringify(evidence.modelBodies[1].messages)).toContain('SKILL-LIFECYCLE-INSTRUCTION')
  expect(evidence.modelBodies[1].model).toContain('haiku')
  expect(results[1].status).toBe('completed')
}, 30_000)

for (const name of ['skill-same-turn', 'background-skill']) {
  test(`${name}: fresh model context receives Skill effects while live variables survive`, async () => {
    const evidence = await scenario(name)
    const followUp = name === 'skill-same-turn' ? 1 : 2
    expect(evidence.modelBodies[followUp].model).toContain('haiku')
    expect(JSON.stringify(evidence.modelBodies[followUp].messages)).toContain('SKILL-LIFECYCLE-INSTRUCTION')
    expect(evidence.allowedFile).toBe('allowed')
    expect(evidence.forbidden).toBeNull()
    const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
    const result = results.find((result: any) => result.cellId === `cell-${followUp}`)
    expect(result.status).toBe('completed')
    expect(result.output).toContain('sticky-skill-state')
    if (name === 'background-skill') expect(evidence.modelBodies[1].model).not.toContain('haiku')
  }, 30_000)
}

test('a script already queued by the old model response cannot cross newly loaded Skill instructions', async () => {
  const evidence = await scenario('skill-queued')
  expect(evidence.forbidden).toBeNull()
  expect(evidence.secondForbidden).toBeNull()
  expect(evidence.allowedFile).toBe('allowed')
  expect(evidence.modelBodies[1].model).toContain('haiku')
  const stale = evidence.transcript.filter((message: any) => message.type === 'user' &&
    message.message.content.some?.((block: any) => block.type === 'tool_result' && block.tool_use_id === 'stale-script'))
  expect(stale.some((message: any) => message.message.content.some((block: any) => block.is_error))).toBe(true)
  expect(evidence.transcript.some((message: any) => message.codeMode?.cellId === 'stale-script')).toBe(false)
}, 30_000)

test('worker finalization cancels and durably drains its actual background tool before releasing resources', async () => {
  const evidence = await scenario('worker-background')
  const task = Object.values(evidence.tasks).find((task: any) => task.type === 'code_mode') as any
  expect(task.owner.agentId).toBeDefined()
  expect(task.owner.workerRunId).toBeDefined()
  expect(task.status, JSON.stringify({ task, receipts: evidence.workerAuditChain.filter((row: any) => row.toolUseResult?.kind === 'code-mode') })).toBe('killed')
  expect(task.delivery).toBe('delivered')
  expect(evidence.workerForbidden).toBeNull()
  expect(evidence.workerActivityWasLive).toBe(true)
  expect(evidence.workerAuditChain.some((row: any) => row.codeMode && row.type === 'assistant')).toBe(true)
  expect(evidence.workerAuditChain.some((row: any) => row.codeMode && row.type === 'user')).toBe(true)
  expect(evidence.workerAuditChain.some((row: any) => row.toolUseResult?.kind === 'code-mode' && row.toolUseResult.status === 'cancelled')).toBe(true)
  const parent = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
  expect(parent.status).toBe('yielded')
  expect(JSON.stringify(evidence.apiRequests)).toContain('Worker-owned script outcomes')
}, 30_000)

test('healthy background script returns a task receipt, permits a new turn, and durably delivers final output', async () => {
  const evidence = await scenario('background')
  expect(evidence.firstTurnFenced).toBe(false)
  expect(evidence.auditWasLive).toBe(true)
  expect(evidence.queuedBackgroundNotification.origin.kind).toBe('task-notification')
  expect(evidence.queuedBackgroundNotification.origin.taskType).toBe('code_mode')
  expect(evidence.queuedBackgroundNotification.value).not.toContain('retainedBG')
  const initial = Object.values(evidence.firstTurnTasks).filter((task: any) => task.type === 'code_mode') as any[]
  expect(initial).toHaveLength(1)
  expect(initial[0].settled).toBe(false)
  const task = Object.values(evidence.tasks).find((task: any) => task.type === 'code_mode') as any
  expect(task.delivery).toBe('delivered')
  expect(task.status).toBe('completed')
  expect(task.outputArchived).toBe(true)
  expect(task.receipt).toBeUndefined()
  expect(evidence.backgroundFile).toBe('background-done')
  const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
  expect(results.some((result: any) => result.status === 'running' && result.taskId === task.id)).toBe(true)
  expect(results.some((result: any) => result.status === 'completed' && result.taskId === task.id)).toBe(true)
  expect(results.find((result: any) => result.status === 'completed' && result.taskId === task.id).output).toContain('selected-background')
  expect(results.find((result: any) => result.cellId === 'cell-2').output).toContain('background-state')
  const selected = evidence.transcript.find((message: any) =>
    message.toolUseResult?.taskId === task.id && message.toolUseResult?.status === 'completed')
  expect(selected.origin.kind).toBe('task-notification')
  expect(selected.toolUseResult.output).toContain(evidence.selectedBackground)
  const frame = /<background-code-mode-data>\n([^\n]*)\n<\/background-code-mode-data>/
  expect(JSON.parse(selected.message.content.match(frame)[1])).toBe(selected.toolUseResult.output)
  expect(selected.message.content.match(/<\/background-code-mode-data>/g)).toHaveLength(1)
  expect(evidence.classifierHistory).toContain('User: "[SYSTEM NOTIFICATION - NOT USER INPUT] SYSTEM NOTIFICATION')
  expect(evidence.classifierHistory).toContain('User: HUMAN-FOLLOW-UP: explain the result, not approval.')
  const human = evidence.transcript.find((message: any) => message.message?.content === 'HUMAN-FOLLOW-UP: explain the result, not approval.')
  expect(human.origin).toBeUndefined()
  expect(human.isMeta).not.toBe(true)
  for (const provider of ['firstParty', 'openai']) {
    const text = evidence.normalized[provider].flatMap((message: any) =>
      typeof message.content === 'string' ? [message.content] : message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text)).join('\n')
    expect(text).toContain('SYSTEM NOTIFICATION (NOT USER INPUT)')
    expect(JSON.parse(text.match(frame)![1])).toBe(selected.toolUseResult.output)
    expect(text.indexOf('HUMAN-FOLLOW-UP:')).toBeGreaterThan(text.indexOf('</background-code-mode-data>'))
  }
  expect(JSON.stringify(evidence.modelBodies[4].messages)).toContain('SYSTEM NOTIFICATION (NOT USER INPUT)')
  expect(JSON.stringify(evidence.modelBodies[4].messages)).toContain('HUMAN-FOLLOW-UP:')
  expect(evidence.transcript.filter((message: any) => message.codeMode).every((message: any) => message.isVirtual)).toBe(true)
}, 30_000)

test('TaskStop cancels a real background Bash effect and fences until its receipt is accepted', async () => {
  const evidence = await scenario('background-cancel')
  const task = Object.values(evidence.tasks).find((task: any) => task.type === 'code_mode') as any
  expect(evidence.firstTurnFenced).toBe(false)
  expect(evidence.sawFence).toBe(true)
  expect(task.cancellationRequested).toBe(true)
  expect(task.status).toBe('killed')
  expect(evidence.transcript.some((message: any) => message.toolUseResult?.taskId === task.id && message.toolUseResult.status === 'cancelled')).toBe(true)
  expect(task.delivery).toBe('delivered')
  expect(evidence.forbidden).toBeNull()
  expect(evidence.finalFence).toBe(false)
}, 30_000)

test('failed durable background publication retries original receipts without repeating effects', async () => {
  const evidence = await scenario('background-delivery-failure')
  const task = Object.values(evidence.tasks).find((task: any) => task.type === 'code_mode') as any
  expect(evidence.receiptFailures).toBeGreaterThan(0)
  expect(evidence.sawFence).toBe(true)
  expect(evidence.effects).toBe('x')
  expect(task.delivery).toBe('delivered')
  expect(task.status).toBe('completed')
  expect(evidence.finalFence).toBe(false)
  const uuids = evidence.transcript.map((message: any) => message.uuid)
  expect(new Set(uuids).size).toBe(uuids.length)
}, 30_000)

test('direct unsafe tools and detached guest tools share serialization without holding the outer REPL lane', async () => {
  const evidence = await scenario('background-direct')
  expect(evidence.firstTurnFenced).toBe(false)
  expect(evidence.effectOrder).toBe('background-startbackground-endforeground')
  expect(evidence.sawFence).toBe(false)
  expect(evidence.finalFence).toBe(false)
}, 30_000)

test('an explicit background ask retains the real permission UI after its launching turn ends', async () => {
  const evidence = await scenario('background-approval')
  expect(evidence.approvalWasAfterTurn).toBe(true)
  expect(evidence.permissionRequests).toHaveLength(1)
  expect(evidence.approvalFile).toBe('approved')
  const task = Object.values(evidence.tasks).find((task: any) => task.type === 'code_mode') as any
  expect(task.status).toBe('completed')
  expect(task.delivery).toBe('delivered')
}, 30_000)

test('approval feedback reaches the model before the qualified Bash effect and fences later calls', async () => {
  const evidence = await scenario('feedback')
  const results = evidence.transcript.filter((message: any) => message.toolUseResult?.kind === 'code-mode').map((message: any) => message.toolUseResult)
  expect(evidence.permissionRequests).toHaveLength(1)
  expect(results[0].status).toBe('yielded')
  expect(evidence.forbidden).toBeNull()
  expect(evidence.secondForbidden).toBeNull()
  expect(JSON.stringify(evidence.modelBodies[1].messages)).toContain('APPROVAL-FEEDBACK-INSTRUCTION')
}, 30_000)

test('human refusal remains authenticated and blocks later dispatch despite guest catch', async () => {
  const evidence = await scenario('refusal')
  const result = evidence.transcript.find((message: any) => message.toolUseResult?.kind === 'code-mode').toolUseResult
  expect(result.status).toBe('blocked')
  expect(evidence.permissionRequests).toHaveLength(1)
  expect(evidence.forbidden).toBeNull()
  expect(evidence.secondForbidden).toBeNull()
  const refusal = evidence.transcript.find((message: any) => message.permissionDecision?.outcome === 'rejected-by-user')
  expect(refusal?.isVirtual).toBe(true)
  expect(evidence.transcript.some((message: any) => message.uuid === refusal.permissionDecision.assistantUuid && message.codeMode)).toBe(true)
}, 30_000)

test('oversized Auto source is rejected before review or effects rather than reviewed as a truncated prefix', async () => {
  const evidence = await scenario('auto-limit')
  expect(evidence.forbidden).toBeNull()
  expect(evidence.modelBodies).toHaveLength(2)
  expect(evidence.modelBodies.some((body: any) => body.tool_choice?.name)).toBe(false)
  expect(JSON.stringify(evidence.transcript.filter((message: any) => message.type === 'user'))).toContain('too large for one automatic review')
  expect(evidence.transcript.some((message: any) => message.codeMode)).toBe(false)
}, 30_000)
