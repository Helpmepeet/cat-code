/** Cold production startup proof: saved input is review-only, never user history or an executable queue. */
import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { type ServerFrame, type SidecarClientMessage } from '../shared/protocol.js'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'
import { readTailRecoveryState, RECOVERY_WARNING, RECOVERY_CONTEXT } from '../../src/utils/transcriptTailRecovery.js'

const here = dirname(fileURLToPath(import.meta.url))
const minter = join(here, 'mintTranscript.fixture.ts')
const resumeProbe = join(here, 'resumeProbe.fixture.ts')
const entry = join(here, 'index.ts')
const networkGuard = join(here, 'denyNetwork.fixture.ts')
const TEST_TIMEOUT_MS = 120_000
const tempDirs: string[] = []
const running: Array<{ supervisor: SidecarSupervisor; pids: number[] }> = []

afterEach(async () => {
  for (const item of running.splice(0)) {
    item.supervisor.shutdown()
    for (const pid of item.pids) await waitForExit(pid)
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
function isolatedEnv(configHome: string) {
  const launch = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('CATCODE_')).map(key => [key, '']))
  return { ...launch, CLAUDE_CONFIG_DIR: configHome, CODEX_HOME: join(configHome, 'codex'),
    NODE_ENV: 'development', TEST_ENABLE_SESSION_PERSISTENCE: '1',
    ANTHROPIC_API_KEY: 'isolated-recovery-probe', OPENAI_API_KEY: 'isolated-recovery-probe',
    ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
    // The supported Unix transport skips init's automatic TCP preconnect.
    // No provider socket exists; fetch is independently denied by the preload.
    ANTHROPIC_UNIX_SOCKET: join(configHome, 'no-provider.sock'),
    CLAUDE_CODE_SIMPLE: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CATCODE_SIDECAR_PROBE: '', CATCODE_PROBE_NETWORK_AUDIT: join(configHome, 'network-attempts') }
}
function mintedValue(stdout: string, key: string): string {
  const line = stdout.split('\n').find(entry => entry.startsWith(`${key}=`))
  if (!line) throw new Error(`mint did not report ${key}: ${stdout}`)
  return line.slice(key.length + 1)
}
async function run(command: string[], cwd: string, configHome: string): Promise<string> {
  const child = Bun.spawn([process.execPath, `--preload=${networkGuard}`, ...SIDECAR_RUNTIME_ARGS, ...command], {
    cwd, env: { ...process.env, ...isolatedEnv(configHome) }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`${command[0]} failed (exit ${code}): ${stderr}`)
  expect(existsSync(join(configHome, 'network-attempts'))).toBe(false)
  return stdout
}
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
    await Bun.sleep(10)
  }
  throw new Error(`Owned recovery probe process ${pid} did not exit`)
}
async function startRecovery(configHome: string, cwd: string, engineSessionId: string) {
  const appSessionId = randomUUID()
  const frames: ServerFrame[] = [], logs: string[] = []
  const exits: Array<{ code: number | null; signal: string | null }> = []
  const audit = join(configHome, 'network-attempts')
  const readAudit = () => existsSync(audit) ? readFileSync(audit, 'utf8') : ''
  const auditBefore = readAudit()
  const supervisor = new SidecarSupervisor({ sidecarCommand: process.execPath,
    sidecarArgs: [`--preload=${networkGuard}`, ...SIDECAR_RUNTIME_ARGS, entry], sidecarEnv: isolatedEnv(configHome),
    killGraceMs: 1000, log: message => logs.push(message) })
  const owned = { supervisor, pids: [] as number[] }
  running.push(owned)
  supervisor.subscribe(event => {
    if (event.type === 'frame') frames.push(event.frame)
    else if (event.type === 'exit') exits.push({ code: event.code, signal: event.signal })
  })
  const wait = async (predicate: (frame: ServerFrame) => boolean): Promise<ServerFrame> => {
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const frame = frames.find(predicate)
      if (frame) return frame
      if (supervisor.listSessions().some(session => ['failed', 'exited'].includes(session.status))) break
      await Bun.sleep(10)
    }
    throw new Error(`Recovery sidecar did not produce its expected frame: ${logs.slice(-12).join('\n')}`)
  }
  supervisor.spawnSession(appSessionId, { cwd, resumeEngineSessionId: engineSessionId })
  const pid = supervisor.getSessionProcessId(appSessionId)
  if (pid !== undefined) owned.pids.push(pid)
  const ready = await wait(frame => frame.kind === 'ready')
  await wait(frame => frame.kind === 'history.replay.complete')
  expect(ready).toMatchObject({ engineSessionId, payload: { activeTurn: false } })
  const snapshot = () => {
    const frame = frames.findLast(frame => frame.kind === 'queued-prompts.snapshot')
    if (frame?.kind !== 'queued-prompts.snapshot') throw new Error('No saved-input review snapshot')
    return frame
  }
  const recall = async (id: string) => {
    const requestId = randomUUID()
    supervisor.send(appSessionId, { type: 'prompt.recall', requestId, recoveredPromptId: id })
    const frame = await wait(frame => (frame.kind === 'prompt-recall.result' || frame.kind === 'error') && frame.requestId === requestId)
    if (frame.kind !== 'prompt-recall.result') throw new Error(`Review failed: ${JSON.stringify(frame)}`)
    expect(frame.ok).toBe(true)
    return frame
  }
  const stop = async (allowExplicitProviderDenial = false) => {
    supervisor.killSession(appSessionId)
    if (pid !== undefined) await waitForExit(pid)
    if (!allowExplicitProviderDenial) expect(readAudit()).toBe(auditBefore)
    else {
      expect(readAudit().slice(auditBefore.length).match(/Isolated recovery probe blocked a network request/g)).toHaveLength(1)
      // exit(91) intentionally bypasses cleanup. The tracked owner is dead;
      // advance only this isolated lease past the production stale interval.
      const leaseLock = join(configHome, 'transcript-leases', `${engineSessionId}.lease.lock`)
      if (existsSync(leaseLock)) {
        const expired = new Date(Date.now() - 121_000)
        utimesSync(leaseLock, expired, expired)
      }
    }
  }
  return { frames, ready, snapshot, recall, stop, wait,
    send: (message: SidecarClientMessage) => supervisor.send(appSessionId, message),
    waitForTermination: async () => {
      if (pid !== undefined) await waitForExit(pid)
      return exits.at(-1)
    },
  }
}
function assertNotOrdinaryHistory(frames: ServerFrame[], ids: string[]): void {
  for (const frame of frames) {
    if (frame.kind !== 'event' || frame.event.type !== 'message') continue
    const message = frame.event.message
    if (message.type === 'user') expect(ids).not.toContain(message.uuid)
  }
  expect(frames.some(frame => frame.kind === 'event' && frame.event.type === 'turn.status' && frame.event.activeTurn)).toBe(false)
}

test('production restore exposes waiting text/media for review, excludes explicit cancellation, and persists take-back across another restart', async () => {
  const configHome = tmp('catcode-review-cfg-'), cwd = tmp('catcode-review-cwd-')
  const engineSessionId = randomUUID(), marker = `review-${randomUUID()}`
  const minted = await run([minter, engineSessionId, marker, '--recalled-queued'], cwd, configHome)
  const recalled = mintedValue(minted, 'MINTED_RECALLED_UUID')
  const waiting = mintedValue(minted, 'MINTED_WAITING_UUID')
  const image = mintedValue(minted, 'MINTED_IMAGE_UUID')
  const transcriptPath = mintedValue(minted, 'MINTED_TRANSCRIPT_PATH')
  const first = await startRecovery(configHome, cwd, engineSessionId)
  expect(first.snapshot().prompts).toEqual([])
  expect(first.snapshot().recoveredPrompts?.map(item => item.id)).toEqual([waiting, image])
  expect(first.snapshot().recoveredPrompts?.map(item => item.id)).not.toContain(recalled)
  assertNotOrdinaryHistory(first.frames, [recalled, waiting, image])
  expect((await first.recall(image)).recalled).toEqual([{ id: image, prompt: [
    { type: 'text', text: `image caption ${marker}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ] }])
  const records = readFileSync(transcriptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(records.some(row => row.type === 'queue-operation' && row.uuid === image && row.operation === 'remove' && row.queueVersion === 2)).toBe(true)
  expect(records.some(row => row.type === 'queue-operation' && row.uuid === image && row.operation === 'enqueue')).toBe(true)
  await first.stop()
  const second = await startRecovery(configHome, cwd, engineSessionId)
  expect(second.snapshot().prompts).toEqual([])
  expect(second.snapshot().recoveredPrompts?.map(item => item.id)).toEqual([waiting])
  expect((await second.recall(waiting)).recalled).toEqual([{ id: waiting, prompt: `waiting input ${marker}` }])
  assertNotOrdinaryHistory(second.frames, [recalled, waiting, image])
  await second.stop()
}, TEST_TIMEOUT_MS)

test('legacy ambiguous dequeue and remove survive for explicit review rather than becoming user bubbles or queued work', async () => {
  const configHome = tmp('catcode-legacy-review-cfg-'), cwd = tmp('catcode-legacy-review-cwd-')
  const engineSessionId = randomUUID(), marker = `legacy-${randomUUID()}`
  const minted = await run([minter, engineSessionId, marker, '--legacy-removed-queued'], cwd, configHome)
  const recalled = mintedValue(minted, 'MINTED_RECALLED_UUID'), removed = mintedValue(minted, 'MINTED_LEGACY_REMOVED_UUID')
  const waiting = mintedValue(minted, 'MINTED_WAITING_UUID'), image = mintedValue(minted, 'MINTED_IMAGE_UUID')
  const restored = await startRecovery(configHome, cwd, engineSessionId)
  expect(restored.snapshot().prompts).toEqual([])
  expect(restored.snapshot().recoveredPrompts?.map(item => item.id)).toEqual([recalled, waiting, image, removed])
  assertNotOrdinaryHistory(restored.frames, [recalled, waiting, image, removed])
  expect((await restored.recall(recalled)).recalled).toEqual([{ id: recalled, prompt: `recalled input ${marker}` }])
  expect((await restored.recall(removed)).recalled).toEqual([{ id: removed, prompt: `legacy removed input ${marker}` }])
  await restored.stop()
}, TEST_TIMEOUT_MS)

test('cold intact interrupted startup retains the review hold through the real desktop construction path', async () => {
  const configHome = tmp('catcode-intact-review-cfg-'), cwd = tmp('catcode-intact-review-cwd-')
  const engineSessionId = randomUUID(), marker = `intact-${randomUUID()}`
  await run([minter, engineSessionId, marker, '--interrupted-queued'], cwd, configHome)
  const restored = await startRecovery(configHome, cwd, engineSessionId)
  const trustId = randomUUID()
  restored.send({ type: 'workspace.trust', requestId: trustId })
  expect(await restored.wait(frame => frame.kind === 'workspace.trust.result' && frame.requestId === trustId)).toMatchObject({ ok: true })
  const metaId = randomUUID()
  restored.send({ type: 'app.submit', requestId: metaId, prompt: 'Automatic work must remain held', options: { isMeta: true } })
  expect(await restored.wait(frame => frame.kind === 'error' && frame.requestId === metaId))
    .toMatchObject({ message: expect.stringContaining('genuine user message') })
  await restored.stop()
}, TEST_TIMEOUT_MS)

test('large compacted restore preserves accepted archive history while keeping queued review out of the model seed', async () => {
  const configHome = tmp('catcode-compact-review-cfg-'), cwd = tmp('catcode-compact-review-cwd-')
  const engineSessionId = randomUUID(), marker = `compact-${randomUUID()}`
  const minted = await run([minter, engineSessionId, marker, '--queued-before-compact'], cwd, configHome)
  const recalled = mintedValue(minted, 'MINTED_RECALLED_UUID'), waiting = mintedValue(minted, 'MINTED_WAITING_UUID')
  const image = mintedValue(minted, 'MINTED_IMAGE_UUID'), consumed = mintedValue(minted, 'MINTED_CONSUMED_UUID')
  expect(statSync(mintedValue(minted, 'MINTED_TRANSCRIPT_PATH')).size).toBeGreaterThan(5 * 1024 * 1024)
  const inspected = await run([resumeProbe, engineSessionId, marker], cwd, configHome)
  const line = inspected.split('\n').find(entry => entry.startsWith('RESUME_RESULT='))
  if (!line) throw new Error(`Missing cold resume result: ${inspected}`)
  expect(JSON.parse(line.slice('RESUME_RESULT='.length))).toMatchObject({ hasCompactBoundary: true, hasMarker: false })
  const restored = await startRecovery(configHome, cwd, engineSessionId)
  expect(restored.snapshot().prompts).toEqual([])
  expect(restored.snapshot().recoveredPrompts?.map(item => item.id)).toEqual([waiting, image])
  assertNotOrdinaryHistory(restored.frames, [recalled, waiting, image])
  expect(restored.frames.some(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.type === 'user' && frame.event.message.uuid === consumed)).toBe(true)
  expect((await restored.recall(image)).recalled[0]?.prompt).toEqual([
    { type: 'text', text: `image caption ${marker}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ])
  await restored.stop()
}, TEST_TIMEOUT_MS)

test('cold torn-tail startup discloses stable recovery once and holds until a genuine durable input receipt', async () => {
  const configHome = tmp('catcode-tail-review-cfg-'), cwd = tmp('catcode-tail-review-cwd-')
  const engineSessionId = randomUUID(), marker = `tail-${randomUUID()}`
  const minted = await run([minter, engineSessionId, marker, '--recalled-queued'], cwd, configHome)
  const path = mintedValue(minted, 'MINTED_TRANSCRIPT_PATH')
  const waiting = mintedValue(minted, 'MINTED_WAITING_UUID'), image = mintedValue(minted, 'MINTED_IMAGE_UUID')
  const damagedContent = `uncommitted-damaged-content-${randomUUID()}`
  appendFileSync(path, `{"type":"assistant","message":{"content":"${damagedContent}`)
  const first = await startRecovery(configHome, cwd, engineSessionId)
  const state = readTailRecoveryState(path, engineSessionId)
  expect(state?.reviewRequired).toBe(true)
  if (!state) throw new Error('Missing persisted tail recovery state')
  expect(first.snapshot().prompts).toEqual([])
  expect(first.snapshot().recoveredPrompts?.map(input => input.id)).toEqual([waiting, image])
  const disclosure = first.frames.filter(frame => frame.kind === 'event' && frame.event.type === 'message' &&
    frame.event.message.uuid === state.warningUuid)
  expect(disclosure).toHaveLength(1)
  expect(disclosure[0]).toMatchObject({ event: { message: {
    type: 'system', subtype: 'local_command_output', content: RECOVERY_WARNING,
  } } })
  expect(JSON.stringify(first.frames)).not.toContain(damagedContent)
  assertNotOrdinaryHistory(first.frames, [waiting, image])
  await first.stop()

  const second = await startRecovery(configHome, cwd, engineSessionId)
  expect(readTailRecoveryState(path, engineSessionId)).toEqual(state)
  expect(second.frames.filter(frame => frame.kind === 'event' && frame.event.type === 'message' &&
    frame.event.message.uuid === state.warningUuid)).toHaveLength(1)
  const trustId = randomUUID()
  second.send({ type: 'workspace.trust', requestId: trustId })
  expect(await second.wait(frame => frame.kind === 'workspace.trust.result' && frame.requestId === trustId)).toMatchObject({ ok: true })
  const metaId = randomUUID()
  second.send({ type: 'app.submit', requestId: metaId, prompt: 'Synthetic continuation must not start', options: { isMeta: true } })
  const refused = await second.wait(frame => frame.kind === 'error' && frame.requestId === metaId)
  expect(refused).toMatchObject({ message: expect.stringContaining('genuine user message') })
  expect(readTailRecoveryState(path, engineSessionId)?.reviewRequired).toBe(true)
  assertNotOrdinaryHistory(second.frames, [waiting, image])

  const genuine = `I reviewed the recovered progress. Continue with this new input ${marker}.`
  second.send({ type: 'app.submit', requestId: randomUUID(), prompt: genuine })
  // Any provider transport is still denied, after the real engine's durable
  // review receipt. No live response or synthetic provider reply is involved.
  expect(await second.waitForTermination()).toMatchObject({ code: 91 })
  expect(readTailRecoveryState(path, engineSessionId)).toEqual({ ...state, reviewRequired: false })
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  expect(rows.filter(row => row.uuid === state.warningUuid)).toHaveLength(1)
  expect(rows.find(row => row.uuid === state.contextUuid)).toMatchObject({
    type: 'user', isMeta: true, message: { content: RECOVERY_CONTEXT },
  })
  expect(rows.some(row => row.type === 'user' && !row.isMeta && !row.origin && row.message?.content === genuine)).toBe(true)
  await second.stop(true)

  const restarted = await startRecovery(configHome, cwd, engineSessionId)
  expect(readTailRecoveryState(path, engineSessionId)).toEqual({ ...state, reviewRequired: false })
  expect(restarted.frames.filter(frame => frame.kind === 'event' && frame.event.type === 'message' &&
    frame.event.message.uuid === state.warningUuid)).toHaveLength(1)
  expect(restarted.snapshot().prompts).toEqual([])
  assertNotOrdinaryHistory(restarted.frames, [waiting, image])
  await restarted.stop()
}, TEST_TIMEOUT_MS)
