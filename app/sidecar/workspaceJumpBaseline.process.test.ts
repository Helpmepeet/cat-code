import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Host } from '../host/host.js'
import { ManagedStorage } from '../host/managedStorage.js'
import { SessionRegistry } from '../host/registry.js'
import { SidecarSupervisor } from '../supervisor/supervisor.js'
import { resolveSidecarLaunch, type SidecarMode } from '../main/mainDecisions.js'
import { runSessionRelocationWorker } from '../main/sessionRelocationRunner.js'
import { runWorkspaceListingWorker } from '../main/workspaceListingRunner.js'
import { WorkspaceJumpCoordinator } from '../main/workspaceJumpCoordinator.js'
import { WorkspaceHandoffControl } from '../main/workspaceHandoffControl.js'
import { validateHostRequest, type WorkspaceHostRequest } from '../main/peerRequestPlane.js'
import type { OperationalRecordInput } from '../shared/operationalLog.js'
import type { WorkspaceHandoffSnapshot } from '../shared/workspaceHandoff.js'
import type { WorkerTiming } from '../shared/workerTiming.js'
import type { ServerFrame } from '../shared/protocol.js'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TranscriptRowsView } from '../renderer/src/TranscriptView.js'
import { TranscriptModeContext } from '../renderer/src/transcriptMode.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows } from '../renderer/src/transcriptProjector.js'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.js'

const launch = resolveSidecarLaunch({ packaged: false, mainDir: resolve('app/main') })
function launchArgs(blocker: string, mode: SidecarMode, fixture?: string) {
  const args = launch.argsFor(mode)
  // Fixture wrappers replace only the entrypoint, retaining session features.
  if (fixture) args[args.length - 1] = resolve(fixture)
  return [`--preload=${blocker}`, ...args]
}

test('baseline launch policy keeps session features off listing and relocation workers', () => {
  for (const [mode, file] of [['workspace-listing', 'workspaceListingWorker.ts'], ['relocation', 'sessionRelocationWorker.ts']] as const) {
    expect(launchArgs('network.ts', mode)).toEqual(['--preload=network.ts', 'run', resolve('app/sidecar', file)])
  }
  const session = launchArgs('network.ts', 'session')
  expect(session.some(arg => arg.startsWith('--feature='))).toBe(true)
  for (const fixture of ['optionalInstallation.fixture.ts', 'workspaceJumpBaseline.fixture.ts']) {
    expect(launchArgs('network.ts', 'session', `app/sidecar/${fixture}`)).toEqual([...session.slice(0, -1), resolve('app/sidecar', fixture)])
  }
})

async function until(read: () => boolean, timeout = 60_000) {
  const deadline = performance.now() + timeout
  while (!read()) {
    if (performance.now() > deadline) throw new Error('Isolated baseline boundary timed out')
    await Bun.sleep(10)
  }
}
function sse(toolHandle?: string, readPath?: string) {
  const content = readPath ? { type: 'tool_use', id: 'baseline-read', name: 'Read', input: {} }
    : toolHandle ? { type: 'tool_use', id: 'baseline-jump', name: 'JumpToProject', input: {} } : { type: 'text', text: '' }
  const events = [
    { type: 'message_start', message: { id: 'baseline-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta: readPath ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: readPath }) }
      : toolHandle ? { type: 'input_json_delta', partial_json: JSON.stringify({ destination: toolHandle }) } : { type: 'text_delta', text: 'Fixture complete.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: toolHandle ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}
const samples = Number(process.env.CATCODE_JUMP_BASELINE_SAMPLES ?? 1)
// An undefined overlay removes inherited launch keys even from runners that
// merge process.env. Supervisor-authored identity keys are installed afterward.
function withoutInheritedLaunchKeys() {
  return Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('CATCODE_')).map(key => [key, undefined])) as unknown as Record<string, string>
}
for (const fixture of ['short', 'queued_human', 'many_rows', 'retained', 'unresolved_installation', 'lost_continue_command', 'lost_continue_ack', 'exhausted_snapshot_window']) for (let sample = 0; sample < (fixture.startsWith('lost_') || fixture === 'exhausted_snapshot_window' ? 1 : samples); sample++) test(`isolated real workspace jump baseline ${fixture} sample ${sample + 1}`, async () => {
  const unresolved = fixture === 'unresolved_installation'
  const retained = fixture === 'retained'
  const queuedHuman = fixture === 'queued_human'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jump-baseline-')))
  const config = join(root, 'config'), cwd = join(root, 'project')
  mkdirSync(config); mkdirSync(cwd); mkdirSync(join(root, 'home'))
  const previousConfig = process.env.CLAUDE_CONFIG_DIR, previousLaunch = process.env.CATCODE_OPERATIONAL_LAUNCH_ID
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CATCODE_OPERATIONAL_LAUNCH_ID = randomUUID()
  const roots = [cwd, ...Array.from({ length: 3 }, (_, i) => join(root, `other-${i}`))]
  for (const path of roots.slice(1)) mkdirSync(path)
  const savedRows = Array.from({ length: fixture === 'many_rows' ? 20_000 : 4 }, (_, i) => ({ path: roots[i % roots.length]!, lastUsedAt: 20_000 - i,
    ...(i % roots.length === 0 ? { name: 'P1_gaming' } : {}) }))
  writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: Object.fromEntries(roots.map(path => [path, { hasTrustDialogAccepted: true }])) }))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: queuedHuman ? ['JumpToProject', 'Read'] : ['JumpToProject'] } }))
  if (fixture === 'short' || retained) {
    const hook = join(root, 'resume-hook.ts')
    writeFileSync(hook, `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'FRESH_HANDOFF_REQUIRED_RESUME_POLICY' } }))`)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['JumpToProject'] },
      hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] } }))
  }
  writeFileSync(join(cwd, 'CLAUDE.md'), 'BASELINE_DESTINATION_INSTRUCTIONS\n')
  if (queuedHuman) writeFileSync(join(root, 'queued-read.txt'), 'Read completed before the queued workspace request.\n')
  const hookLog = join(root, 'instructions.jsonl')
  const probeLog = join(root, 'probes.txt')
  const include = join(cwd, 'included.md')
  if (unresolved) {
    writeFileSync(include, 'DESTINATION_INCLUDED_INSTRUCTIONS\n')
    writeFileSync(join(cwd, 'CLAUDE.md'), 'BASELINE_DESTINATION_INSTRUCTIONS\n@included.md\n')
    const hook = join(root, 'instruction-hook.ts')
    writeFileSync(hook, `const input = await new Response(Bun.stdin.stream()).text(); require('node:fs').appendFileSync(${JSON.stringify(hookLog)}, input.trim() + '\\n')`)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['JumpToProject'] },
      hooks: { InstructionsLoaded: [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${hook}"` }] }] } }))
  }
  let sourceRequests = 0, destinationRequests = 0, retainedReplayCount = 0, validationCalls = 0
  const destinationCommands: string[] = []
  const peerRosterHolds: boolean[] = []
  let dropped = false, sawNullAdmission = false, destinationPermission = false, destinationReady = false
  let initialSnapshot: WorkspaceHandoffSnapshot | undefined
  const queuedText = 'Oh, work in cat-code workspace. use peer sesion feature'
  let queuedUuid: string | undefined
  let releaseSource: (() => void) | undefined
  const sourceHeld = new Promise<void>(resolve => { releaseSource = resolve })
  const frames: ServerFrame[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/messages')) return new Response('{}', { status: 503 })
    const body = await request.text()
    if (JSON.parse(body).stream !== true) return Response.json({ id: 'baseline-auxiliary', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'Fixture' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    const destination = body.includes('BASELINE_DESTINATION_INSTRUCTIONS')
    if (fixture === 'short' && destination) {
      expect(body).toContain('Jump to P1_gaming')
      expect(body).toContain('Current project metadata')
      expect(body).toContain('P1_gaming')
      expect(body).not.toContain('Continue from where you left off.')
      expect(body).not.toContain('Continue the existing user request')
      expect(body).not.toContain('Work will continue after the conversation moves.')
    }
    if ((fixture === 'short' || retained) && destination) expect(body).toContain('FRESH_HANDOFF_REQUIRED_RESUME_POLICY')
    if (retained && destination) expect(body).toContain('RETAINED_PARTIAL_TOOL_TRAJECTORY')
    if (unresolved && destination) {
      expect(body).toContain('DESTINATION_INCLUDED_INSTRUCTIONS')
      expect(existsSync(probeLog) && readFileSync(probeLog, 'utf8').split('\n').includes(cwd)).toBe(false)
    }
    const handle = body.match(/\\"handle\\":\\"([a-f0-9-]+)\\"/)?.[1] ?? body.match(/"handle":"([a-f0-9-]+)"/)?.[1]
    if (destination) destinationRequests++; else if (handle) sourceRequests++
    if (queuedHuman && !destination && handle && sourceRequests === 1) {
      // A tool round drains the busy prompt into an attachment. Ending this
      // response would instead exercise an ordinary between-turn submission.
      await sourceHeld
      return new Response(sse(handle, join(root, 'queued-read.txt')), { headers: { 'content-type': 'text/event-stream', 'request-id': 'baseline-read' } })
    }
    if (queuedHuman && !destination && handle) expect(body).toContain(queuedText)
    await Bun.sleep(30)
    return new Response(sse(destination ? undefined : handle), { headers: { 'content-type': 'text/event-stream', 'request-id': 'baseline' } })
  } })
  const blocker = join(root, 'network.ts')
  writeFileSync(blocker, `const original = globalThis.fetch; globalThis.fetch = (async (input, init) => { const url = String(input instanceof Request ? input.url : input); if (new URL(url).origin !== ${JSON.stringify(server.url.origin)}) throw new Error('External network disabled'); return original(input, init) }) as typeof fetch\n`)
  const env = { ...withoutInheritedLaunchKeys(), CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'sk-ant-isolated-baseline', ANTHROPIC_BASE_URL: server.url.origin,
    OPTIONAL_PROBE_LOG: probeLog,
    HOME: join(root, 'home'), ANTHROPIC_MODEL: 'claude-sonnet-4-6', CAT_CODE_MODEL: 'claude-sonnet-4-6',
    CATCODE_SIDECAR_MODEL: '', CATCODE_SIDECAR_PREFER_SPAWN_MODEL: '', CATCODE_SIDECAR_FRESH_SESSION_ID: '',
    CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '',
    CLAUDE_CODE_USE_OPENAI: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '',
    CLAUDE_CODE_SIMPLE: '', DISABLE_TELEMETRY: '1', NODE_ENV: 'development', TEST_ENABLE_SESSION_PERSISTENCE: '1' }
  const timings: OperationalRecordInput[] = []
  const requestContext = new AsyncLocalStorage<string>()
  const workerInvocations: Array<{
    invocationId: string; kind: 'listing' | 'relocation'; request: string;
    startBoundary: number; endBoundary?: number; durationMs?: number;
    outcome?: 'completed' | 'failed'; childStages: WorkerTiming[];
  }> = []
  let workerBoundary = 0
  async function observeWorker<T>(kind: 'listing' | 'relocation', run: (onTiming: (measurement: WorkerTiming) => void) => Promise<T>): Promise<T> {
    const invocation: typeof workerInvocations[number] = {
      invocationId: randomUUID(), kind, request: requestContext.getStore() ?? 'host.relocation',
      startBoundary: ++workerBoundary, childStages: [],
    }
    workerInvocations.push(invocation)
    const started = performance.now()
    invocation.outcome = 'failed'
    try {
      const result = await run(measurement => {
        invocation.childStages.push(measurement)
        timings.push({ process: 'main', level: 'info', event: 'workspace.jump.timing',
          fields: { ...measurement, invocationId: invocation.invocationId } })
      })
      invocation.outcome = 'completed'
      return result
    } finally {
      invocation.durationMs = performance.now() - started
      invocation.endBoundary = ++workerBoundary
      if (kind === 'listing') timings.push({ process: 'main', level: 'info', event: 'workspace.jump.timing',
        fields: { phase: 'listing_worker', outcome: invocation.outcome, durationMs: invocation.durationMs, invocationId: invocation.invocationId } })
    }
  }
  const registry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
  let coordinator: WorkspaceJumpCoordinator | undefined
  let control: WorkspaceHandoffControl | undefined
  const diagnostics: string[] = []
  const observations: unknown[] = []
  const supervisor = new SidecarSupervisor({ socketDir: join(root, 's'), sidecarCommand: launch.command, sidecarArgs: launchArgs(blocker, 'session', unresolved ? 'app/sidecar/optionalInstallation.fixture.ts' : undefined), sidecarEnv: env,
    projectNameForCwd: folder => folder === cwd ? 'P1_gaming' : undefined,
    log: line => { diagnostics.push(line) }, onOperationalRecord: record => {
      if (record.event !== 'workspace.jump.timing') return
      timings.push(record)
      if (record.fields.phase === 'continuation_to_provider_request' && record.fields.outcome === 'completed') coordinator?.observeProviderRequest(record.appSessionId!, record.engineSessionId!, String(record.fields.operationId), String(record.fields.generation))
    } })
  try {
    await registry.launch()
    const host = new Host({ supervisor, registry, timing: input => { timings.push(input) }, log: () => {},
      managedStorage: new ManagedStorage({ appDataBase: join(root, 'app'), ownershipDir: join(config, 'chat-workspaces') }),
      validateCwd: path => { try { return { ok: true, realpath: realpathSync(path) } } catch { return { ok: false } } },
      relocate: request => observeWorker('relocation', onTiming => runSessionRelocationWorker({ command: launch.command, args: launchArgs(blocker, 'relocation'), cwd: request.source.cwd, request: { type: 'session-relocation', version: 1, ...request }, env, onTiming })),
    })
    coordinator = new WorkspaceJumpCoordinator({ host, row: id => registry.findSession(id), knownProjects: () => savedRows,
      validateCwd: path => { validationCalls++; try { return { ok: true, realpath: realpathSync(path) } } catch { return { ok: false } } },
      trustedProjectRoots: roots => observeWorker('listing', onTiming => runWorkspaceListingWorker({ command: launch.command, args: launchArgs(blocker, 'workspace-listing'),
        cwd: root, request: { type: 'workspace-list', version: 1, roots: [...roots] }, env, onTiming })),
      timing: input => { timings.push(input) },
      verifyReady: async (identity, boundary, state) => {
        const delivery = await control!.request(identity.appSessionId, state.operationId, { action: 'verify', ...boundary })
        return delivery.kind === 'result' && delivery.result.disposition === 'accepted'
      }, control: (state, action) => control!.request(state.appSessionId, state.operationId, action),
      waitForControlSlot: (id, operationId, generation) => control!.waitForSlot(id, operationId, generation),
      controlSlotOccupied: (id, operationId) => control!.isSlotOccupied(id, operationId),
      onStateChanged: state => { observations.push({ phase: state.phase, location: state.location, dispatch: state.continuation.dispatch, outcome: state.continuation.outcome }); host.publishWorkspaceJumpDisplay(state) },
    })
    control = new WorkspaceHandoffControl({ generation: id => supervisor.getSessionGeneration(id),
      send: (id, message) => {
        if (registry.findSession(id)?.cwd === cwd) {
          destinationCommands.push(message.action)
          if (message.action === 'continue') {
            expect(destinationReady).toBe(true)
            expect(destinationPermission).toBe(true)
            expect(coordinator!.snapshot(id)).toMatchObject({ location: 'destination',
              continuation: { admissionGeneration: supervisor.getSessionGeneration(id) } })
            if (fixture === 'lost_continue_command' && !dropped) { dropped = true; return true }
            if (fixture === 'exhausted_snapshot_window' && !dropped) {
              expect(initialSnapshot).toBeDefined()
              // Replay genuine attachment evidence to exhaust the receiving window.
              for (let index = 0; index < 33; index++) control!.receiveState(id, initialSnapshot!)
              dropped = true
              return false
            }
          }
        }
        supervisor.send(id, message); return true
      },
      acceptsStatus: (id, status) => registry.findSession(id)?.engineSessionId === status.engineSessionId,
      observe: (id, status) => { coordinator!.observe(id, status) }, recover: id => coordinator!.requestFreshEvidence(id) })
    const pending = new Set<Promise<void>>()
    supervisor.subscribe(event => {
      if (event.type !== 'frame') return
      const { deliveryTrace: _trace, ...frame } = event.frame
      if (queuedHuman) {
        frames.push(frame)
        if (frame.kind === 'queued-prompts.snapshot') queuedUuid ??= frame.prompts.find(prompt => prompt.text === queuedText)?.id
      }
      if (registry.findSession(event.sessionId)?.cwd === cwd) {
        if (frame.kind === 'ready') destinationReady = true
        if (frame.kind === 'permission.context') destinationPermission = true
        if (frame.kind === 'workspace.handoff.state' && frame.status.admissionGeneration === null) {
          sawNullAdmission = true
          initialSnapshot = frame.status
        }
        if (fixture === 'lost_continue_ack' && frame.kind === 'workspace.handoff.result' &&
            frame.action === 'continue' && !dropped) { dropped = true; return }
      }
      if (frame.kind === 'event' && frame.replay && frame.event.type === 'message' &&
          'parent_tool_use_id' in frame.event.message && frame.event.message.parent_tool_use_id === 'baseline-agent-tool' &&
          registry.findSession(event.sessionId)?.cwd === cwd) retainedReplayCount++
      if (frame.kind === 'workspace.handoff.result') observations.push({ action: frame.action, disposition: frame.disposition, reason: frame.reason, execution: frame.status?.execution })
      control!.receiveFrame(event.sessionId, frame)
      if (frame.kind === 'ready' && coordinator!.snapshot(event.sessionId)) coordinator!.queryStatus(event.sessionId, true)
      if (frame.kind !== 'host.request') return
      // Same main-local frame-receive boundary as the production adapter,
      // captured before validating the request. No wire clock is consumed.
      const receivedAt = performance.now()
      const validated = validateHostRequest(frame)
      if (validated.ok && validated.request.verb === 'peers.list') {
        const blocked = coordinator!.isPeerAccessBlocked(event.sessionId)
        peerRosterHolds.push(blocked)
        supervisor.send(event.sessionId, {
          type: 'host.result', requestId: validated.requestId,
          ...(blocked
            ? { ok: false as const, error: { code: 'session_not_found' as const, message: 'this session is changing workspace' } }
            : { ok: true as const, value: { peers: [] } }),
        })
        return
      }
      if (!validated.ok || !['workspaces.list', 'workspace.jump', 'workspace.ready', 'workspace.cancel'].includes(validated.request.verb)) throw new Error('Unexpected baseline host request')
      const request = validated.request as WorkspaceHostRequest
      const task = (async () => {
        const result = await requestContext.run(request.verb, () => coordinator!.handleRequest(event.sessionId, request, receivedAt))
        supervisor.send(event.sessionId, { type: 'host.result', requestId: validated.requestId, ...result })
        coordinator!.afterResponse(event.sessionId, request, true)
      })()
      pending.add(task); void task.finally(() => pending.delete(task))
    })
    const created = await host.createManagedChat()
    if (!created.ok) throw new Error(created.error.message)
    const id = created.value.appSessionId
    await until(() => supervisor.listSessions().some(row => row.sessionId === id && row.status === 'ready'))
    await until(() => registry.findSession(id)?.engineSessionId != null)
    expect(supervisor.getSessionSocketPath(id)?.startsWith(`${join(root, 's')}/`)).toBe(true)
    if (retained) {
      supervisor.send(id, { type: 'app.park', requestId: randomUUID() })
      await until(() => registry.findSession(id)?.shutdown === 'parked')
      const original = registry.findSession(id)!
      const minter = Bun.spawn([launch.command, ...launchArgs(blocker, 'session', 'app/sidecar/workspaceJumpBaseline.fixture.ts'), 'mint', original.engineSessionId!],
        { cwd: original.cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
      const [code, error] = await Promise.all([minter.exited, new Response(minter.stderr).text(), new Response(minter.stdout).text()])
      expect(code, error).toBe(0)
      expect((await host.restoreSession(id)).ok).toBe(true)
      await until(() => supervisor.listSessions().some(row => row.sessionId === id && row.status === 'ready'))
    }
    supervisor.send(id, { type: 'app.submit', requestId: randomUUID(), prompt: fixture === 'short' ? 'Jump to P1_gaming' : 'Run the isolated jump fixture.' })
    if (queuedHuman) {
      await until(() => sourceRequests === 1)
      supervisor.send(id, { type: 'app.submit', requestId: randomUUID(), prompt: queuedText })
      await until(() => queuedUuid !== undefined)
      releaseSource!()
    }
    await until(() => destinationRequests === 1)
    await until(() => coordinator!.snapshot(id)?.continuation.outcome === 'success')
    expect(supervisor.getSessionSocketPath(id)?.startsWith(`${join(root, 's')}/`)).toBe(true)
    await Promise.all(pending)
    await coordinator.waitForSettlement(id)
    if (unresolved) {
      await until(() => existsSync(probeLog) && readFileSync(probeLog, 'utf8').split('\n').includes(cwd))
      expect(readFileSync(probeLog, 'utf8').split('\n').filter(path => path === cwd)).toHaveLength(1)
      await until(() => existsSync(hookLog) && readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).length >= 2)
      const hooks = readFileSync(hookLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(input => [join(cwd, 'CLAUDE.md'), include].includes(input.file_path))
      expect(hooks).toHaveLength(2)
      expect(hooks.find(input => input.file_path === join(cwd, 'CLAUDE.md'))).toMatchObject({ load_reason: 'session_start', memory_type: 'Project' })
      expect(hooks.find(input => input.file_path === include)).toMatchObject({ load_reason: 'include', parent_file_path: join(cwd, 'CLAUDE.md') })
    }
    expect(sourceRequests).toBe(queuedHuman ? 2 : 1)
    expect(destinationRequests).toBe(1)
    expect(peerRosterHolds).toEqual([true])
    expect(sawNullAdmission).toBe(true)
    expect(destinationCommands[0]).toBe('continue')
    expect(destinationCommands.filter(action => action === 'continue')).toHaveLength(fixture === 'lost_continue_command' || fixture === 'exhausted_snapshot_window' ? 2 : 1)
    if (fixture.startsWith('lost_')) expect(dropped).toBe(true)
    if (retained) expect(retainedReplayCount).toBeGreaterThanOrEqual(100)
    expect(registry.findSession(id)?.cwd).toBe(cwd)
    const completed = timings.filter(record => record.fields?.outcome === 'completed')
    const providerResponses = completed.filter(record => record.fields?.phase === 'provider_request_to_response')
    expect(providerResponses).toHaveLength(queuedHuman ? 3 : 2)
    expect(Number(providerResponses.at(-1)?.fields?.durationMs)).toBeGreaterThanOrEqual(25)
    for (const phase of ['first_submit_to_catalog', 'first_submit_to_provider_response', 'accepted_to_source_boundary', 'park_to_clean_exit', 'relocation_worker', 'resume', 'controller', 'display_history', 'subagent_history', 'listening_to_ready_frame', 'ready_to_controls', 'admission_to_continuation', 'continuation_to_provider_request', 'provider_request_to_response', 'accepted_to_provider_request_observed', 'request_received_to_acceptance', 'request_received_to_provider_request_observed', 'startup_validation', 'runtime_initialize_body', 'replacement_to_runtime_init', 'listing_worker', 'worker_bootstrap_imports', 'build_metadata', 'build_provenance_git', 'configuration_prepare', 'trust_evaluation', 'relocation_module_load', 'relocation_work']) {
      // This stage observes the acknowledgement, deliberately absent in this fault case.
      expect(completed.some(record => record.fields?.phase === phase), phase).toBe(!(fixture === 'lost_continue_ack' && phase === 'admission_to_continuation'))
    }
    const listingInvocations = workerInvocations.filter(invocation => invocation.kind === 'listing')
    expect(listingInvocations.map(invocation => invocation.request)).toEqual(['workspaces.list', 'workspace.jump', 'workspace.ready'])
    expect(workerInvocations.filter(invocation => invocation.kind === 'relocation')).toHaveLength(1)
    expect(new Set(workerInvocations.map(invocation => invocation.invocationId)).size).toBe(4)
    for (const invocation of workerInvocations) {
      expect(invocation.outcome).toBe('completed')
      expect(invocation.durationMs).toBeGreaterThanOrEqual(0)
      expect(invocation.endBoundary!).toBeGreaterThan(invocation.startBoundary)
      expect(invocation.childStages.map(stage => stage.phase)).toEqual([
        'worker_bootstrap_imports', 'build_provenance_git', 'build_metadata', 'configuration_prepare',
        ...(invocation.kind === 'listing' ? ['trust_evaluation'] as const : ['relocation_module_load', 'relocation_work'] as const),
      ])
      expect(invocation.childStages.every(stage => stage.outcome === 'completed' && stage.durationMs >= 0)).toBe(true)
    }
    for (let index = 1; index < workerInvocations.length; index++) {
      expect(workerInvocations[index]!.startBoundary).toBeGreaterThan(workerInvocations[index - 1]!.endBoundary!)
    }
    const oneCompletion = (phase: string) => {
      const records = completed.filter(record => record.fields?.phase === phase)
      expect(records, phase).toHaveLength(1)
      return records[0]!
    }
    const acceptance = oneCompletion('request_received_to_acceptance')
    const requestedProvider = oneCompletion('request_received_to_provider_request_observed')
    const acceptedProvider = oneCompletion('accepted_to_provider_request_observed')
    expect(acceptance.fields?.operationId).toBe(acceptedProvider.fields?.operationId)
    expect(requestedProvider.fields?.operationId).toBe(acceptedProvider.fields?.operationId)
    expect(timings.indexOf(acceptance)).toBeLessThan(timings.indexOf(acceptedProvider))
    expect(timings.indexOf(acceptedProvider)).toBeLessThan(timings.indexOf(requestedProvider))
    // These three durations all use the coordinator's own monotonic clock.
    // No child timestamps or enclosing/overlapping spans are subtracted.
    expect(Number(requestedProvider.fields?.durationMs)).toBeGreaterThanOrEqual(Number(acceptedProvider.fields?.durationMs))
    expect(Number(requestedProvider.fields?.durationMs)).toBeGreaterThanOrEqual(Number(acceptance.fields?.durationMs))
    if (queuedHuman) {
      const live = frames.find(frame => frame.kind === 'event' && !frame.replay && frame.event.type === 'message' &&
        frame.event.message.type === 'user' && frame.event.message.uuid === queuedUuid)
      if (live?.kind !== 'event' || live.event.type !== 'message' || live.event.message.type !== 'user') throw new Error('Missing live queued prompt')
      const timestamp = live.event.message.timestamp
      expect(typeof timestamp).toBe('string')
      expect(live).toMatchObject({ event: { message: { uuid: queuedUuid, timestamp, message: { content: queuedText } } } })
      const transcriptPath = join(config, 'projects', sanitizePath(cwd), `${registry.findSession(id)!.engineSessionId}.jsonl`)
      const saved = readFileSync(transcriptPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      expect(saved.filter(entry => entry.type === 'attachment' && entry.attachment?.source_uuid === queuedUuid))
        .toMatchObject([{ timestamp, attachment: { type: 'queued_command', prompt: queuedText, commandMode: 'prompt' } }])
      expect(saved.filter(entry => entry.type === 'user' && entry.uuid === queuedUuid)).toHaveLength(0)
      const checkRestored = (replayed: ServerFrame[], repeated = false) => {
        const messages = replayed.filter(frame => frame.kind === 'event' && frame.replay && frame.event.type === 'message')
        expect(messages.filter(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.uuid === queuedUuid)).toHaveLength(repeated ? 2 : 1)
        expect(messages.find(frame => frame.kind === 'event' && frame.event.type === 'message' && frame.event.message.uuid === queuedUuid))
          .toMatchObject({ event: { message: { uuid: queuedUuid, timestamp, message: { role: 'user', content: queuedText } } } })
        let projected = createTranscriptState()
        for (const frame of replayed) projected = projectServerFrame(projected, frame)
        const rows = selectNestedTranscriptRows(projected, id)
        const promptIndex = rows.findIndex(row => row.kind === 'user-text' && row.content === queuedText)
        const readIndex = rows.findIndex(row => row.kind === 'tool-use' && row.toolUseId === 'baseline-read')
        const jumpIndex = rows.findIndex(row => row.kind === 'tool-use' && row.toolName === 'JumpToProject')
        expect(readIndex).toBeGreaterThan(0)
        expect(promptIndex).toBeGreaterThan(readIndex)
        expect(jumpIndex).toBeGreaterThan(promptIndex)
        expect(rows.filter(row => row.kind === 'user-text' && row.content === queuedText)).toHaveLength(1)
        expect(rows[promptIndex]).toMatchObject({ messageId: queuedUuid, frameId: queuedUuid, timestamp })
        for (const mode of ['full', 'focused'] as const) {
          const html = renderToStaticMarkup(createElement(TranscriptModeContext.Provider, { value: { mode, setMode() {} } },
            createElement(TranscriptRowsView, { rows })))
          expect(html.split(queuedText)).toHaveLength(2)
        }
      }
      const replacementStart = frames.findLastIndex(frame => frame.kind === 'ready')
      checkRestored(frames.slice(replacementStart))
      // A second process reads the relocated transcript again, rather than
      // retaining the live producer's in-memory replay frames.
      supervisor.send(id, { type: 'app.park', requestId: randomUUID() })
      await until(() => registry.findSession(id)?.shutdown === 'parked')
      const coldStart = frames.length
      expect((await host.restoreSession(id)).ok).toBe(true)
      await until(() => frames.slice(coldStart).some(frame => frame.kind === 'ready'))
      await until(() => supervisor.listSessions().some(row => row.sessionId === id && row.status === 'ready'))
      await until(() => frames.slice(coldStart).some(frame => frame.kind === 'history.replay.complete'))
      checkRestored(frames.slice(coldStart))
      const earlierStart = frames.length, earlierId = randomUUID()
      supervisor.send(id, { type: 'history.loadEarlier', requestId: earlierId, viewTruncated: true })
      await until(() => frames.slice(earlierStart).some(frame => frame.kind === 'history.loadEarlier.result' && frame.requestId === earlierId))
      expect(frames.find(frame => frame.kind === 'history.loadEarlier.result' && frame.requestId === earlierId)).toMatchObject({ ok: true, complete: true })
      expect(frames.slice(earlierStart).find(frame => frame.kind === 'event' && frame.recovered && frame.event.type === 'message' && frame.event.message.uuid === queuedUuid))
        .toMatchObject({ recovered: true, event: { message: { uuid: queuedUuid, timestamp, message: { content: queuedText } } } })
      checkRestored(frames.slice(coldStart), true)
    }
    process.stdout.write(JSON.stringify({ fixture, savedRows: savedRows.length, folders: roots.length, validationCalls, pairs: retained ? 200 : 0, subagentMessages: retained ? 100 : 0, sample: sample + 1,
      workerInvocations,
      stages: completed.map(record => ({ stage: record.fields!.phase, ms: Math.round(Number(record.fields!.durationMs) * 100) / 100,
        ...(record.fields!.generation ? { generation: record.fields!.generation } : {}),
        ...(record.fields!.invocationId ? { invocationId: record.fields!.invocationId } : {}),
        ...(record.fields!.operationId ? { operationId: record.fields!.operationId } : {}) })) }) + '\n')
  } catch (error) {
    process.stderr.write(JSON.stringify({ sourceRequests, destinationRequests, observations, timings: timings.filter(record => record.fields?.outcome === 'completed').map(record => record.fields) }) + '\n')
    process.stderr.write(diagnostics.slice(-12).join('\n') + '\n')
    throw error
  } finally {
    coordinator?.dispose()
    control?.dispose()
    supervisor.shutdown()
    releaseSource?.()
    server.stop(true)
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig
    if (previousLaunch === undefined) delete process.env.CATCODE_OPERATIONAL_LAUNCH_ID; else process.env.CATCODE_OPERATIONAL_LAUNCH_ID = previousLaunch
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)

for (const delay of [200, -1]) test(`normal controller installation baseline ${delay < 0 ? 'never' : 'delayed'}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jump-install-baseline-')))
  const config = join(root, 'config'), cwd = join(root, 'project'), home = join(root, 'home')
  mkdirSync(config); mkdirSync(cwd); mkdirSync(home)
  writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
  const blocker = join(root, 'network.ts')
  writeFileSync(blocker, 'globalThis.fetch = (async () => new Response("Network disabled", { status: 503 })) as typeof fetch')
  const child = Bun.spawn([launch.command, ...launchArgs(blocker, 'session', 'app/sidecar/workspaceJumpBaseline.fixture.ts'), 'diagnostics', String(delay)], {
    cwd, env: { ...process.env, ...withoutInheritedLaunchKeys(), CLAUDE_CONFIG_DIR: config, HOME: home, ANTHROPIC_API_KEY: 'sk-ant-isolated-baseline',
      CATCODE_SIDECAR_MODEL: '', CATCODE_SIDECAR_PREFER_SPAWN_MODEL: '', CATCODE_SIDECAR_FRESH_SESSION_ID: '',
      CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '',
      CAT_CODE_MODEL: 'claude-sonnet-4-6', CLAUDE_CODE_USE_OPENAI: '', CLAUDE_CODE_SIMPLE: '', DISABLE_TELEMETRY: '1' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const observations: Array<{ fields?: { phase?: string; outcome?: string; durationMs?: number }; controllerCompletedMs?: number; installationCalls?: number }> = []
  const output = (async () => {
    let pending = ''
    const decoder = new TextDecoder()
    for await (const bytes of child.stdout) {
      pending += decoder.decode(bytes, { stream: true })
      const lines = pending.split('\n'); pending = lines.pop()!
      for (const line of lines) if (line) observations.push(JSON.parse(line))
    }
  })()
  const stderr = new Response(child.stderr).text()
  try {
    const code = await child.exited
    await output
    expect(code, await stderr).toBe(0)
    expect(observations.some(record => record.fields?.phase === 'diagnostics' && record.fields.outcome === 'completed')).toBe(true)
    expect(observations.some(record => record.controllerCompletedMs !== undefined)).toBe(true)
    expect(observations.find(record => record.controllerCompletedMs !== undefined)?.installationCalls).toBe(0)
    process.stdout.write(JSON.stringify({ fixture: delay < 0 ? 'installation_never' : 'installation_delayed_200ms', sample: 1,
      observations: observations.map(record => record.fields ?? record) }) + '\n')
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
    await Promise.all([output, stderr])
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
