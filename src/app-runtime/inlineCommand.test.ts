import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveInlineCommandSource } from './inlineCommand.js'
import { createAssistantMessage } from '../utils/messages.js'
import { AppSessionController } from './AppSessionController.js'
import { createBashShellProvider } from '../utils/shell/bashProvider.js'

async function fixture(input: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'inline-run-')))
  try {
    await mkdir(join(root, 'config'))
    await mkdir(join(root, 'workspace'))
    const child = Bun.spawn([process.execPath, new URL('./inlineCommand.fixture.ts', import.meta.url).pathname], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin', HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        ANTHROPIC_API_KEY: 'isolated-fixture-not-a-credential', CLAUDE_CODE_USE_OPENAI: input.provider === 'codex' ? '1' : '0',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        ...(input.timeout ? { BASH_DEFAULT_TIMEOUT_MS: String(input.timeout) } : {}),
        INLINE_TEST_ROOT: root, INLINE_TEST_INPUT: JSON.stringify(input) },
    })
    const timer = setTimeout(() => child.kill(), 25_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timer)
    if (code !== 0) throw new Error(`Inline fixture failed (${code}): ${stderr}\n${stdout}`)
    return { ...JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8')), workspace: join(root, 'workspace') }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('authoritative source rejects foreign, removed, unfinished and non-shell content', () => {
  const message = createAssistantMessage({ content: '```js\nno\n```\n```sh\nprintf exact\n```' })
  message.message.stop_reason = 'end_turn'
  const source = { engineSessionId: 'session', messageUuid: message.uuid, contentBlockIndex: 0, fenceOrdinal: 1 }
  expect(resolveInlineCommandSource([message], 'session', source)).toBe('printf exact')
  expect(() => resolveInlineCommandSource([message], 'other', source)).toThrow('another conversation')
  expect(() => resolveInlineCommandSource([], 'session', source)).toThrow('no longer available')
  expect(() => resolveInlineCommandSource([message], 'session', { ...source, fenceOrdinal: 0 })).toThrow('unavailable')
  message.message.stop_reason = null
  expect(() => resolveInlineCommandSource([message], 'session', source)).toThrow('incomplete')
})

test('completion cannot cross foreign provider groups, requests or errors', () => {
  const first = createAssistantMessage({ content: '```sh\nprintf exact\n```' })
  first.message.stop_reason = null
  first.requestId = 'request'
  const last = createAssistantMessage({ content: 'Done' })
  last.message.id = first.message.id
  last.requestId = 'request'
  last.message.stop_reason = 'end_turn'
  const source = { engineSessionId: 'session', messageUuid: first.uuid, contentBlockIndex: 0, fenceOrdinal: 0 }
  expect(resolveInlineCommandSource([first, last], 'session', source)).toBe('printf exact')
  expect(() => resolveInlineCommandSource([last, first], 'session', source)).toThrow('incomplete')
  const foreign = createAssistantMessage({ content: 'Other response' })
  foreign.message.id = 'foreign'
  foreign.message.stop_reason = 'end_turn'
  expect(() => resolveInlineCommandSource([first, foreign], 'session', source)).toThrow('incomplete')
  expect(() => resolveInlineCommandSource([first, foreign, last], 'session', source)).toThrow('incomplete')
  last.requestId = 'another-request'
  expect(() => resolveInlineCommandSource([first, last], 'session', source)).toThrow('incomplete')
  last.requestId = 'request'
  last.error = 'invalid_request'
  expect(() => resolveInlineCommandSource([first, last], 'session', source)).toThrow('incomplete')
})

test('actual provider multi-block assembly runs an earlier completed fence and explains its result', async () => {
  const command = 'printf executed >> counter; printf multi-block-output'
  const result = await fixture({ command, multiBlock: true })
  expect(result.error).toBeUndefined()
  const chunks = result.sourceSnapshot.filter((message: any) => message.type === 'assistant')
  expect(chunks).toHaveLength(2)
  expect(chunks[0].uuid).not.toBe(chunks[1].uuid)
  expect(chunks[0].message.id).toBe(chunks[1].message.id)
  expect(chunks[0].message.stop_reason).toBeNull()
  expect(chunks[1].message.stop_reason).toBe('end_turn')
  expect(result.restoredSourceCommand).toBe(command)
  expect(result.counter).toBe('executed')
  expect(result.restored[0]).toMatchObject({ command, status: 'success', exitCode: 0 })
  expect(result.requests).toHaveLength(2)
  expect(JSON.stringify(result.requests[1])).toContain('multi-block-output')
  expect(result.transcript.some((message: any) => message.type === 'assistant' &&
    message.message.content.some((block: any) => block.text === 'Here is the command result explanation.'))).toBe(true)
}, 30_000)

test('controller reserves synchronously, rejects overlap and releases scoped Stop before explanation', async () => {
  let release!: () => void
  let finish!: () => void
  let commandSignal!: AbortSignal
  let turnSignal!: AbortSignal
  const source = { engineSessionId: 'session', messageUuid: 'assistant', contentBlockIndex: 0, fenceOrdinal: 0 }
  const controller = new AppSessionController({
    async *runTurn(args) {
      const operation = args.options!.inlineCommand!
      commandSignal = operation.signal
      turnSignal = args.signal
      operation.onProgress({ runId: operation.runId, source, command: 'pwd', cwd: '/tmp', status: 'running', output: '', exitCode: null })
      await new Promise<void>(resolve => { release = resolve })
      operation.onProgress({ runId: operation.runId, source, command: 'pwd', cwd: '/tmp', status: 'stopped', output: '', exitCode: null })
      await new Promise<void>(resolve => { finish = resolve })
    },
  })
  let runId = ''
  const pending = controller.submitInlineCommand(source, run => { runId = run.runId })
  expect(controller.isTurnActive()).toBe(true)
  await expect(controller.submitInlineCommand(source, () => {})).rejects.toThrow('busy')
  expect(controller.stopInlineCommand('foreign')).toBe(false)
  expect(controller.stopInlineCommand(runId)).toBe(true)
  expect(commandSignal.aborted).toBe(true)
  expect(turnSignal.aborted).toBe(false)
  release()
  await Promise.resolve()
  expect(controller.isTurnActive()).toBe(true)
  expect(controller.stopInlineCommand(runId)).toBe(false)
  controller.abort('Agent Stop')
  expect(turnSignal.aborted).toBe(true)
  finish()
  await pending
  expect(controller.isTurnActive()).toBe(false)
})

test('backend normalization refuses changed commands instead of disabling hardening', async () => {
  const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
  await expect(provider.buildExecCommand('printf hello 2>nul', {
    id: 'inline-normalization', useSandbox: false, workerScoped: true, requireExactCommand: true,
  })).rejects.toThrow('cannot run unchanged')
})

test('an error result from automatic continuation updates the originating run', async () => {
  const source = { engineSessionId: 'session', messageUuid: 'assistant', contentBlockIndex: 0, fenceOrdinal: 0 }
  const runs: Array<{ error?: string }> = []
  const controller = new AppSessionController({
    async *runTurn({ options }) {
      const operation = options!.inlineCommand!
      operation.onProgress({ runId: operation.runId, source, command: 'pwd', cwd: '/tmp', status: 'success', output: '/tmp', exitCode: 0 })
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Fixture model failure'] } as never
    },
  })
  await expect(controller.submitInlineCommand(source, run => runs.push(run))).rejects.toThrow('Fixture model failure')
  expect(runs.at(-1)?.error).toContain('Agent response failed: Fixture model failure')
})

for (const provider of ['claude', 'codex']) {
  test(`${provider}: real runner persists associated result and automatically explains it without tool pair`, async () => {
    const result = await fixture({ provider, command: "printf executed >> counter; printf 'actual-output'; exit 3" })
    expect(result.error).toBeUndefined()
    expect(result.counter).toBe('executed')
    expect(result.permissions).toBeGreaterThan(0)
    expect(result.requests).toHaveLength(1)
    expect(result.restored).toHaveLength(1)
    expect(result.restored[0]).toMatchObject({ status: 'failed', exitCode: 3, command: "printf executed >> counter; printf 'actual-output'; exit 3" })
    expect(result.restored[0].output).toContain('actual-output')
    expect(result.restored[0].cwd).toBe(result.workspace)
    const outgoing = JSON.stringify(provider === 'codex' ? result.codexRequests : result.requests)
    expect(outgoing).toContain('actual-output')
    expect(outgoing).not.toContain('"type":"tool_result"')
    expect(result.frames.some((frame: any) => frame.type === 'assistant')).toBe(true)
    expect(result.frames.some((frame: any) => frame.type === 'user' && frame.isSynthetic)).toBe(true)
  }, 30_000)
}

test('denied, hook-edited and permission-edited commands cannot execute substitutions', async () => {
  for (const mode of ['deny', 'edit', 'hookEdit']) {
    const result = await fixture({ command: 'printf executed >> counter', [mode]: true })
    expect(result.error).toBeUndefined()
    expect(result.counter).toBe('')
    expect(result.restored[0].status).toBe('failed')
    expect(result.requests).toHaveLength(1)
  }
}, 60_000)

test('normal sandbox allows workspace writes and denies configured sibling access', async () => {
  const result = await fixture({ sandbox: true, command: 'printf executed >> counter; cat \"$HOME/secret\"; printf denied > \"$HOME/forbidden\"' })
  expect(result.error).toBeUndefined()
  expect(result.counter).toBe('executed')
  expect(result.restored[0].status).toBe('failed')
  expect(result.restored[0].output).not.toContain('private-sandbox-fixture')
  expect(result.restored[0].output).toContain('Operation not permitted')
}, 30_000)

test('timeout remains foreground and retains bounded large output', async () => {
  const result = await fixture({ timeout: 500, command: "printf TIMEOUT-START; head -c 50000 /dev/zero | tr '\\0' x; sleep 20; printf after >> counter" })
  expect(result.error).toBeUndefined()
  expect(result.counter).toBe('')
  expect(result.requests).toHaveLength(1)
  expect(result.restored[0].status).not.toBe('success')
  expect(result.restored[0].output.length).toBeLessThan(24_100)
  expect(result.restored[0].exitCode).not.toBe(0)
}, 30_000)

test('fresh scoped cwd, heredoc and EOF use ordinary finite runner', async () => {
  const result = await fixture({ command: "cd /; cat <<'END'\nmultiline-data\nEND\nread line; pwd" })
  expect(result.error).toBeUndefined()
  expect(result.restored[0].status).toBe('success')
  expect(result.restored[0].output).toContain('multiline-data')
  expect(result.cwd).toBe(result.workspace)
}, 30_000)

test('separate deliberate fences get fresh environments and workspace cwd on the same controller', async () => {
  const command = 'export INLINE_CLICK_LEAK=first; cd /; printf first >> "$HOME/workspace/counter"; pwd'
  const secondCommand = 'printf "env=%s\\ncwd=%s\\n" "${INLINE_CLICK_LEAK-unset}" "$PWD"; printf second >> counter'
  const result = await fixture({ command, secondCommand, disk: true })
  expect(result.error).toBeUndefined()
  expect(result.counter).toBe('firstsecond')
  expect(result.requests).toHaveLength(2)
  expect(result.restored).toHaveLength(2)
  const [first, second] = result.restored
  expect(first).toMatchObject({ command, status: 'success', source: { fenceOrdinal: 0 } })
  expect(second).toMatchObject({ command: secondCommand, status: 'success', source: { fenceOrdinal: 1 } })
  expect(first.runId).not.toBe(second.runId)
  expect(first.source.messageUuid).toBe(second.source.messageUuid)
  expect(second.output).toContain('env=unset')
  expect(second.output).toContain(`cwd=${result.workspace}`)
  expect(second.cwd).toBe(result.workspace)
  expect(JSON.stringify(result.requests[0])).toContain('INLINE_CLICK_LEAK=first')
  expect(JSON.stringify(result.requests[1])).toContain('env=unset')
  expect(result.diskSourceCommand).toBe(command)
  expect(result.diskMessages.length).toBeGreaterThan(3)
  expect(result.restoreIdle).toEqual({
    active: false, requestsBefore: 2, requestsAfter: 2,
    counterBefore: 'firstsecond', counterAfter: 'firstsecond',
  })
}, 30_000)

test('successful large output retains a usable readable production artifact before cleanup', async () => {
  const result = await fixture({ artifact: true, command: "printf ARTIFACT-BEGIN; head -c 200000 /dev/zero | tr '\\0' x; printf ARTIFACT-END" })
  expect(result.error).toBeUndefined()
  expect(result.restored[0]).toMatchObject({ status: 'success', exitCode: 0 })
  expect(result.restored[0].output.length).toBeLessThan(24_100)
  expect(result.artifact).toBeDefined()
  expect(result.artifact.isolated).toBe(true)
  expect(result.artifact.content).toBe('ARTIFACT-BEGIN' + 'x'.repeat(200000) + 'ARTIFACT-END')
  expect(result.restored[0].output).toContain(`Full output: ${result.artifact.path}`)
  expect(JSON.stringify(result.requests)).toContain(result.artifact.path)
}, 30_000)

test('real sidecar queues a human frame during inline execution and drains after its explanation', async () => {
  const result = await fixture({ queued: true, command: 'printf executed >> counter; printf QUEUE-WINDOW; sleep 1; printf QUEUE-DONE' })
  expect(result.error).toBeUndefined()
  expect(result.counter).toBe('executed')
  expect(result.requestsWhenQueued).toBe(0)
  expect(result.queueDuringOperation).toHaveLength(1)
  expect(JSON.stringify(result.queueDuringOperation)).toContain('QUEUED-HUMAN-PROMPT')
  expect(result.queueAfterOperation).toEqual([])
  expect(result.requests).toHaveLength(2)
  expect(JSON.stringify(result.requests[0])).toContain('QUEUE-DONE')
  expect(JSON.stringify(result.requests[0])).not.toContain('QUEUED-HUMAN-PROMPT')
  expect(JSON.stringify(result.requests[1])).toContain('Here is the command result explanation.')
  expect(JSON.stringify(result.requests[1]).match(/QUEUED-HUMAN-PROMPT/g)).toHaveLength(1)
  const humans = result.transcript.filter((message: any) => message.type === 'user' && !message.isSynthetic &&
    JSON.stringify(message.message.content).includes('QUEUED-HUMAN-PROMPT'))
  expect(humans).toHaveLength(1)
  expect(JSON.stringify(result.transcript)).toContain('Queued human response.')
  expect(result.restored).toHaveLength(1)
  expect(result.serverFrames.filter((frame: any) => frame.kind === 'error')).toEqual([])
}, 30_000)

for (const agentStop of [false, true]) {
  test(`${agentStop ? 'Agent Stop' : 'inline Stop'} retains partial output and ${agentStop ? 'suppresses' : 'allows'} continuation`, async () => {
    const result = await fixture({ command: 'sleep 20 & child=$!; printf \"%s\" \"$child\" > child-pid; printf BEFORE-STOP; wait \"$child\"; printf after >> counter', stop: !agentStop, agentStop })
    expect(result.error).toBeUndefined()
    expect(result.counter).toBe('')
    expect(result.childAlive).toBe(false)
    expect(result.restored[0].status).toBe(agentStop ? 'interrupted' : 'stopped')
    expect(result.restored[0].output).toContain('BEFORE-STOP')
    expect(result.requests).toHaveLength(agentStop ? 0 : 1)
  }, 30_000)
}

test('persistence failure keeps available output and reports follow-up failure without dispatch', async () => {
  const result = await fixture({ command: 'printf retained', failPersistence: true })
  expect(result.error).toContain('Fixture persistence failure')
  expect(result.requests).toHaveLength(0)
  expect(result.runs.at(-1).output).toContain('retained')
  expect(result.runs.at(-1).error).toContain('Agent response failed')
}, 30_000)

for (const hookStop of ['PreToolUse', 'PostToolUse']) {
  test(`${hookStop} stop persists the actual result without automatic response`, async () => {
    const result = await fixture({ command: 'printf executed >> counter; printf hook-output', hookStop })
    expect(result.error).toBeUndefined()
    expect(result.counter).toBe('executed')
    expect(result.requests).toHaveLength(0)
    expect(result.restored).toHaveLength(1)
    expect(result.restored[0]).toMatchObject({ status: 'success', exitCode: 0, error: 'Fixture hook stopped automatic response' })
    expect(result.restored[0].output).toContain('hook-output')
    expect(result.transcript.some((message: any) => message.type === 'attachment' &&
      message.attachment.type === 'hook_stopped_continuation' && message.attachment.hookEvent === hookStop)).toBe(true)
    expect(JSON.stringify(result.transcript)).not.toContain('"type":"tool_use"')
    expect(JSON.stringify(result.transcript)).not.toContain('"type":"tool_result"')
  }, 30_000)
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: genuine hook context reaches the provider without a synthetic tool pair`, async () => {
    const result = await fixture({ provider, command: 'printf hook-output', hookContext: true })
    expect(result.error).toBeUndefined()
    expect(result.requests).toHaveLength(1)
    const outgoing = JSON.stringify(provider === 'codex' ? result.codexRequests : result.requests)
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(outgoing).toContain(`${event} isolated additional context`)
      expect(result.transcript.some((message: any) => message.type === 'attachment' &&
        message.attachment.type === 'hook_additional_context' && message.attachment.hookEvent === event)).toBe(true)
    }
    expect(outgoing).not.toContain('"type":"tool_use"')
    expect(outgoing).not.toContain('"type":"tool_result"')
  }, 30_000)
}
