/**
 * Manual Chat relocation through the real host, sidecar and persistence owners.
 * The fixture uses isolated state and never sends a prompt to a model.
 *
 * Run alone: bun test app/host/chatRelocation.feasibility.probe.test.ts
 */
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Host } from './host.js'
import { ManagedStorage } from './managedStorage.js'
import { SessionRegistry, defaultTranscriptPath } from './registry.js'
import { SidecarSupervisor, type SupervisorEvent } from '../supervisor/supervisor.js'
import { PARKED_EXIT_CODE } from '../shared/limits.js'
import { SPAWN_RATE_WINDOW_MS } from '../shared/hostApi.js'
import type { ReadyFrame, ServerFrame } from '../shared/protocol.js'
import { runSessionRelocationWorker } from '../main/sessionRelocationRunner.js'
import { SIDECAR_RUNTIME_ARGS } from '../main/mainDecisions.js'
import { readSessionRelocation, writeSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import { resolveOpenHistorySession } from '../main/openHistorySession.js'
import type { SessionsCatalogSnapshot } from '../shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const sidecarEntry = join(here, '..', 'sidecar', 'index.ts')
const minter = join(here, '..', 'sidecar', 'mintTranscript.fixture.ts')
const resumeProbe = join(here, '..', 'sidecar', 'resumeProbe.fixture.ts')
const readPermissionProbe = join(here, '..', 'sidecar', 'relocationReadPermission.probe.fixture.ts')
const outputProbe = join(here, '..', 'sidecar', 'relocationOutput.probe.fixture.ts')
const relocationWorker = join(here, '..', 'sidecar', 'sessionRelocationWorker.ts')
const roots: string[] = []
const supervisors: SidecarSupervisor[] = []
const priorConfigDir = process.env.CLAUDE_CONFIG_DIR

// Successive lifecycle scenarios use separate admission windows. Host rate-cap
// tests cover bursts; this process probe must not depend on startup taking 10 s.
function lifecycleAdmissionClock(): () => number {
  let clock = 0
  return () => { clock += SPAWN_RATE_WINDOW_MS; return clock }
}

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.shutdown()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfigDir
})

function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000
    const poll = (): void => {
      const value = read()
      if (value !== undefined) return resolve(value)
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(poll, 25)
    }
    poll()
  })
}

async function child(command: string[], cwd: string, configHome: string) {
  const process = Bun.spawn(['bun', `--preload=${join(dirname(configHome), 'block-network.ts')}`, 'run', ...command], {
    cwd,
    env: {
      ...globalThis.process.env,
      CLAUDE_CONFIG_DIR: configHome,
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
      NODE_ENV: 'development',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function value(output: string, key: string): string {
  const line = output.split('\n').find(item => item.startsWith(`${key}=`))
  if (!line) throw new Error(`missing ${key}: ${output}`)
  return line.slice(key.length + 1)
}

async function readPermission(
  sessionId: string,
  filePath: string,
  cwd: string,
  configHome: string,
  deniedPath?: string,
): Promise<string> {
  const probe = await child(
    [readPermissionProbe, sessionId, filePath, ...(deniedPath ? [deniedPath] : [])],
    cwd,
    configHome,
  )
  if (probe.code !== 0) throw new Error(probe.stderr)
  return value(probe.stdout, 'READ_PERMISSION')
}

test('manual Chat to trusted project and back keeps one conversation and both output paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-chat-relocation-'))
  roots.push(root)
  const configHome = join(root, 'config')
  const projectFolder = join(root, 'project')
  mkdirSync(configHome)
  mkdirSync(projectFolder)
  const networkBlocker = join(root, 'block-network.ts')
  writeFileSync(networkBlocker, 'globalThis.fetch = (async () => new Response("Network disabled in relocation probe", { status: 503 })) as typeof fetch\n')
  const projectCwd = realpathSync(projectFolder)
  process.env.CLAUDE_CONFIG_DIR = configHome
  writeFileSync(join(configHome, '.config.json'), JSON.stringify({
    projects: { [projectCwd]: { hasTrustDialogAccepted: true } },
  }))
  const hookMarker = join(root, 'project-resume-hook')
  mkdirSync(join(projectCwd, '.cat-code'))
  writeFileSync(join(projectCwd, '.cat-code', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ matcher: 'resume', hooks: [{
      type: 'command', command: `printf project-resume > '${hookMarker}'`,
    }] }] },
    permissions: { deny: ['Bash(rm:*)'] },
  }))
  writeFileSync(join(projectCwd, 'CLAUDE.md'), 'PROJECT_CONTEXT_MARKER\n')
  mkdirSync(join(projectCwd, '.cat-code', 'skills', 'project-only'), { recursive: true })
  writeFileSync(join(projectCwd, '.cat-code', 'skills', 'project-only', 'SKILL.md'),
    '---\nname: project-only\ndescription: Project context marker\n---\nPROJECT_SKILL_MARKER\n')

  const managedStorage = new ManagedStorage({
    appDataBase: join(root, 'app-data'),
    ownershipDir: join(configHome, 'chat-workspaces'),
  })
  const registry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
  await registry.launch()
  const supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: [`--preload=${networkBlocker}`, ...SIDECAR_RUNTIME_ARGS, sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'sk-ant-local-probe', CLAUDE_CODE_USE_OPENAI: '1', NODE_ENV: 'development' },
  })
  supervisors.push(supervisor)
  const host = new Host({
    supervisor, registry, managedStorage,
    now: lifecycleAdmissionClock(),
    validateCwd: cwd => {
      try { return { ok: true, realpath: realpathSync(cwd) } }
      catch { return { ok: false } }
    },
    relocate: request => runSessionRelocationWorker({
      command: 'bun', args: [`--preload=${networkBlocker}`, 'run', relocationWorker], cwd: request.source.cwd,
      request: { type: 'session-relocation', version: 1, ...request },
      env: { CLAUDE_CONFIG_DIR: configHome, NODE_ENV: 'development' },
    }),
    log: line => process.stderr.write(`${line}\n`),
  })
  const readyFrames: ReadyFrame[] = []
  const frames: ServerFrame[] = []
  const exits: Array<{ sessionId: string; code: number | null }> = []
  supervisor.subscribe((event: SupervisorEvent) => {
    if (event.type === 'frame') {
      frames.push(event.frame)
      if (event.frame.kind === 'ready') readyFrames.push(event.frame)
    }
    if (event.type === 'exit') exits.push({ sessionId: event.sessionId, code: event.code })
  })

  const created = await host.createManagedChat()
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const appSessionId = created.value.appSessionId
  const firstReady = await waitFor(() => {
    if (exits.some(item => item.sessionId === appSessionId)) throw new Error('managed sidecar exited before ready')
    return readyFrames.find(frame => frame.sessionId === appSessionId)
  }, 'managed ready')
  const engineSessionId = firstReady.engineSessionId
  const original = registry.findSession(appSessionId)
  if (!original || original.binding.kind !== 'managed') throw new Error('managed binding missing')
  writeFileSync(join(original.cwd, 'CLAUDE.md'), 'CHAT_CONTEXT_MARKER\n')
  mkdirSync(join(original.cwd, '.cat-code', 'skills', 'chat-only'), { recursive: true })
  writeFileSync(join(original.cwd, '.cat-code', 'skills', 'chat-only', 'SKILL.md'),
    '---\nname: chat-only\ndescription: Chat context marker\n---\nCHAT_SKILL_MARKER\n')
  expect(managedStorage.hasSessionIdentity(original.binding, appSessionId, engineSessionId)).toBe(true)

  supervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  expect((await waitFor(() => exits.find(item => item.sessionId === appSessionId), 'initial park')).code).toBe(PARKED_EXIT_CODE)
  const marker = `before-relocation-${randomUUID()}`
  const minted = await child([minter, engineSessionId, marker, '--saved-output', '--relocation-skills'], original.cwd, configHome)
  if (minted.code !== 0) throw new Error(minted.stderr)
  writeFileSync(join(configHome, '.config.json'), JSON.stringify({
    projects: { [projectCwd]: { hasTrustDialogAccepted: true } },
    codexOAuth: {
      accessToken: 'isolated-probe-token', refreshToken: 'isolated-probe-refresh',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, accountId: 'isolated-probe', credentialGeneration: 0,
    },
  }))
  const oldTranscript = defaultTranscriptPath(original.cwd, engineSessionId)
  const oldOutput = value(minted.stdout, 'MINTED_OUTPUT_PATH')
  expect(existsSync(oldTranscript)).toBe(true)
  expect(existsSync(oldOutput)).toBe(true)

  const restored = await host.restoreSession(appSessionId)
  if (!restored.ok) throw new Error(JSON.stringify(restored.error))
  await waitFor(() => readyFrames.find(frame => frame.sessionId === appSessionId && frame !== firstReady), 'saved Chat ready')
  await waitFor(() => frames.filter(frame => frame.kind === 'run-controls.snapshot').length >= readyFrames.length &&
    frames.filter(frame => frame.kind === 'permission.context').length >= readyFrames.length ? true : undefined, 'saved Chat controls')
  const untrustedFolder = join(root, 'untrusted')
  mkdirSync(untrustedFolder)
  const refused = await host.moveSession(appSessionId, realpathSync(untrustedFolder))
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.message).toContain('Open and trust')
  expect(registry.findSession(appSessionId)?.cwd).toBe(original.cwd)
  expect(readSessionRelocation(engineSessionId)).toBeNull()
  expect(existsSync(oldTranscript)).toBe(true)
  await waitFor(() => readyFrames.filter(frame => frame.sessionId === appSessionId).length >= 3 ? true : undefined, 'Chat ready after refusal')
  await waitFor(() => frames.filter(frame => frame.kind === 'run-controls.snapshot').length >= readyFrames.length &&
    frames.filter(frame => frame.kind === 'permission.context').length >= readyFrames.length ? true : undefined, 'Chat controls after refusal')
  const controls = await waitFor(() => frames.slice().reverse().find(
    (frame): frame is Extract<ServerFrame, { kind: 'run-controls.snapshot' }> => frame.kind === 'run-controls.snapshot',
  ), 'run controls')
  const selection = controls.runControls.model.options.find(option =>
    (option.value === 'gpt-6-sol' || option.value === 'gpt-6-luna' || option.value === 'gpt-5.6-terra') &&
    option.value !== controls.runControls.model.selected && option.effortOptions.length > 0)
  if (!selection?.value) throw new Error(`No selectable GPT model in process probe: ${JSON.stringify(controls.runControls.model.options.map(option => option.value))}`)
  const chosenModel = selection.value
  const chosenEffort = selection.effortOptions[0]!
  supervisor.send(appSessionId, { type: 'model.set', requestId: randomUUID(), model: chosenModel })
  await waitFor(() => frames.some(frame => frame.kind === 'run-controls.snapshot' && frame.runControls.model.selected === chosenModel) ? true : undefined, 'selected model')
  supervisor.send(appSessionId, { type: 'effort.set', requestId: randomUUID(), effort: chosenEffort })
  await waitFor(() => frames.some(frame => frame.kind === 'run-controls.snapshot' && frame.runControls.effort.selected === chosenEffort) ? true : undefined, 'selected effort')
  supervisor.send(appSessionId, { type: 'permission.setMode', requestId: randomUUID(), mode: 'auto' })
  await waitFor(() => frames.some(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto' &&
    frame.context.permissionClassifierEnabled) ? true : undefined, 'classifier-backed Auto mode')
  supervisor.send(appSessionId, { type: 'fast.set', requestId: randomUUID(), active: true })
  await waitFor(() => frames.some(frame => frame.kind === 'run-controls.snapshot' && frame.runControls.fast.active) ? true : undefined, 'Fast enabled')
  const closed = await host.closeSession(appSessionId)
  if (!closed.ok) throw new Error(JSON.stringify(closed.error))
  const closedProject = await host.moveSession(appSessionId, projectCwd)
  if (!closedProject.ok) throw new Error(JSON.stringify(closedProject.error))
  expect(closedProject.value).toMatchObject({ appSessionId, engineSessionId, cwd: projectCwd })
  expect(supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready')).toBe(false)
  const closedReturned = await host.moveSession(appSessionId, null)
  if (!closedReturned.ok) throw new Error(JSON.stringify(closedReturned.error))
  expect(closedReturned.value).toMatchObject({ appSessionId, engineSessionId, cwd: original.cwd })
  expect(supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready')).toBe(false)
  const reopenedAfterClosedMove = await host.restoreSession(appSessionId)
  if (!reopenedAfterClosedMove.ok) throw new Error(JSON.stringify(reopenedAfterClosedMove.error))
  await waitFor(() => frames.some(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto') &&
    supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready') ? true : undefined, 'saved Chat reopened after closed moves')
  const autoFramesBeforeMove = frames.filter(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto').length
  const moved = await host.moveSession(appSessionId, projectCwd)
  if (!moved.ok) throw new Error(JSON.stringify(moved.error))
  expect(moved.value.appSessionId).toBe(appSessionId)
  expect(moved.value.engineSessionId).toBe(engineSessionId)
  expect(moved.value.binding?.kind).toBe('project')
  expect(moved.value.cwd).toBe(projectCwd)
  await waitFor(() => frames.filter(frame => frame.kind === 'run-controls.snapshot' &&
    frame.runControls.model.selected === chosenModel && frame.runControls.effort.selected === chosenEffort).length > 1 ? true : undefined, 'project model and effort')
  await waitFor(() => frames.filter(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto' &&
    frame.context.permissionClassifierEnabled).length > autoFramesBeforeMove ? true : undefined, 'project classifier-backed Auto mode')
  expect(frames.filter(frame => frame.kind === 'permission.context').at(-1)).toMatchObject({
    context: { alwaysDenyRules: { projectSettings: ['Bash(rm:*)'] } },
  })
  expect(readSessionRelocation(engineSessionId)?.controls.mode).toBe('auto')
  expect(readSessionRelocation(engineSessionId)?.controls.fastMode).toBe(true)
  expect(exits.some(item => item.sessionId === appSessionId && item.code === PARKED_EXIT_CODE)).toBe(true)
  expect(readSessionRelocation(engineSessionId)?.phase).toBe('complete')
  const projectTranscript = defaultTranscriptPath(projectCwd, engineSessionId)
  expect(existsSync(projectTranscript)).toBe(true)
  expect(existsSync(oldTranscript)).toBe(false)
  expect(existsSync(oldOutput)).toBe(true)
  expect(lstatSync(join(dirname(oldTranscript), engineSessionId)).isSymbolicLink()).toBe(true)
  await waitFor(() => frames.some(frame => frame.kind === 'event' && frame.replay === true && JSON.stringify(frame).includes(marker)) ? true : undefined, 'project replay')
  expect(JSON.stringify(frames.filter(frame => frame.kind === 'event' && frame.replay === true))).toContain(oldOutput)
  await waitFor(() => existsSync(hookMarker) ? true : undefined, 'project resume hook')
  expect(readFileSync(hookMarker, 'utf8')).toBe('project-resume')
  expect(await readPermission(engineSessionId, oldOutput, projectCwd, configHome)).toBe('ask')

  supervisor.send(appSessionId, { type: 'permission.setMode', requestId: randomUUID(), mode: 'plan' })
  await waitFor(() => readSessionRelocation(engineSessionId)?.controls.mode === 'plan' ? true : undefined, 'saved Plan selection')
  supervisor.send(appSessionId, { type: 'permission.setMode', requestId: randomUUID(), mode: 'auto' })
  await waitFor(() => readSessionRelocation(engineSessionId)?.controls.mode === 'auto' ? true : undefined, 'saved Auto selection')

  const exitsBeforeProjectPark = exits.length
  supervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > exitsBeforeProjectPark ? true : undefined, 'project park')
  const readyCountBeforeWake = readyFrames.length
  const wake = await host.restoreSession(appSessionId)
  if (!wake.ok) throw new Error(JSON.stringify(wake.error))
  await waitFor(() => readyFrames.length > readyCountBeforeWake &&
    frames.filter(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto' &&
      frame.context.permissionClassifierEnabled).length > autoFramesBeforeMove + 1 ? true : undefined, 'Auto after wake')
  const readyCountBeforeRestart = readyFrames.length
  const restart = await host.restartSession(appSessionId)
  if (!restart.ok) throw new Error(JSON.stringify(restart.error))
  await waitFor(() => readyFrames.length > readyCountBeforeRestart ? true : undefined, 'Auto restart ready')
  expect(frames.filter(frame => frame.kind === 'permission.context').at(-1)).toMatchObject({
    context: { mode: 'auto', permissionClassifierEnabled: true },
  })
  const exitsBeforeRestartPark = exits.length
  supervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > exitsBeforeRestartPark ? true : undefined, 'project park after restart')
  const projectContextProbe = await child([resumeProbe, engineSessionId, marker, '--catalog'], projectCwd, configHome)
  if (projectContextProbe.code !== 0) throw new Error(projectContextProbe.stderr)
  const projectContext = JSON.parse(value(projectContextProbe.stdout, 'RESUME_RESULT')) as {
    instructionContext: string; invokedSkillPaths: string[]; discoveredSkillNames: string[]; hasHistoricalSkillListing: boolean
    historyCwd: string; historyBinding: string; catalog: SessionsCatalogSnapshot
  }
  expect(projectContext.instructionContext).toContain('PROJECT_CONTEXT_MARKER')
  expect(projectContext.instructionContext).not.toContain('CHAT_CONTEXT_MARKER')
  expect(projectContext.invokedSkillPaths.some(path => path.startsWith(original.cwd))).toBe(false)
  expect(projectContext.invokedSkillPaths.some(path => path.startsWith(configHome))).toBe(true)
  expect(projectContext.discoveredSkillNames).toContain('project-only')
  expect(projectContext.discoveredSkillNames).not.toContain('chat-only')
  expect(projectContext.hasHistoricalSkillListing).toBe(false)
  expect(projectContext.historyCwd).toBe(projectCwd)
  expect(projectContext.historyBinding).toBe('project')
  expect(resolveOpenHistorySession(engineSessionId, [], projectContext.catalog)).toMatchObject({
    kind: 'spawn', cwd: projectCwd, binding: { kind: 'project' },
  })
  const afterMarker = `after-relocation-${randomUUID()}`
  const persistedAfter = await child([outputProbe, engineSessionId, afterMarker], projectCwd, configHome)
  if (persistedAfter.code !== 0) throw new Error(persistedAfter.stderr)
  const projectOutput = value(persistedAfter.stdout, 'OUTPUT_PATH')
  expect(readFileSync(projectOutput, 'utf8')).toBe(afterMarker)

  // Simulate registry eviction while history and the managed ownership ledger
  // remain. The project-side history open must recover the original app id.
  const reopenedRegistry = new SessionRegistry({ storageDir: join(root, 'reopened-registry'), log: () => {} })
  await reopenedRegistry.launch()
  const reopenedSupervisor = new SidecarSupervisor({
    sidecarCommand: 'bun', sidecarArgs: [`--preload=${networkBlocker}`, ...SIDECAR_RUNTIME_ARGS, sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'sk-ant-local-probe', CLAUDE_CODE_USE_OPENAI: '1', NODE_ENV: 'development' },
  })
  supervisors.push(reopenedSupervisor)
  const reopenedFrames: ServerFrame[] = []
  reopenedSupervisor.subscribe((event: SupervisorEvent) => {
    if (event.type === 'frame') {
      reopenedFrames.push(event.frame)
      frames.push(event.frame)
      if (event.frame.kind === 'ready') readyFrames.push(event.frame)
    }
    if (event.type === 'exit') exits.push({ sessionId: event.sessionId, code: event.code })
  })
  const reopenedHost = new Host({
    supervisor: reopenedSupervisor, registry: reopenedRegistry, managedStorage,
    now: lifecycleAdmissionClock(),
    validateCwd: cwd => {
      try { return { ok: true, realpath: realpathSync(cwd) } }
      catch { return { ok: false } }
    },
    relocate: request => runSessionRelocationWorker({
      command: 'bun', args: [`--preload=${networkBlocker}`, 'run', relocationWorker], cwd: request.source.cwd,
      request: { type: 'session-relocation', version: 1, ...request },
      env: { CLAUDE_CONFIG_DIR: configHome, NODE_ENV: 'development' },
    }),
  })
  const projectReadyCount = readyFrames.length
  const reopenedProject = await reopenedHost.openRelocatedHistorySession(engineSessionId)
  if (!reopenedProject) throw new Error('relocated history identity missing')
  if (!reopenedProject.ok) throw new Error(JSON.stringify(reopenedProject.error))
  expect(reopenedProject.value.appSessionId).toBe(appSessionId)
  expect(reopenedProject.value.engineSessionId).toBe(engineSessionId)
  await waitFor(() => readyFrames.length > projectReadyCount ? true : undefined, 'project Chat reopened')
  await waitFor(() => reopenedFrames.some(frame => frame.kind === 'run-controls.snapshot') &&
    reopenedFrames.some(frame => frame.kind === 'permission.context') ? true : undefined, 'reopened project controls')
  const reopenedControls = reopenedFrames.filter(
    (frame): frame is Extract<ServerFrame, { kind: 'run-controls.snapshot' }> => frame.kind === 'run-controls.snapshot',
  ).at(-1)
  expect(reopenedControls?.runControls.model.selected).toBe(chosenModel)
  expect(reopenedControls?.runControls.effort.selected).toBe(chosenEffort)
  expect(reopenedControls?.runControls.fast.active).toBe(true)
  expect(reopenedFrames.filter(frame => frame.kind === 'permission.context').at(-1)).toMatchObject({
    context: { mode: 'auto', permissionClassifierEnabled: true },
  })

  const peer = await reopenedHost.createSessionInWorkspace(appSessionId, { createdBy: appSessionId })
  if (!peer.ok) throw new Error(JSON.stringify(peer.error))
  const peerId = peer.value.appSessionId
  const peerReady = await waitFor(() => readyFrames.find(frame => frame.sessionId === peerId), 'project peer ready')
  const activePeerRefusal = await reopenedHost.moveSession(appSessionId, null)
  expect(activePeerRefusal.ok).toBe(false)
  if (!activePeerRefusal.ok) expect(activePeerRefusal.error.message).toContain('active peer work')
  const closedPeer = await reopenedHost.closeSession(peerId)
  if (!closedPeer.ok) throw new Error(JSON.stringify(closedPeer.error))
  const peerMarker = `project-peer-${randomUUID()}`
  const peerHistory = await child([minter, peerReady.engineSessionId, peerMarker], projectCwd, configHome)
  if (peerHistory.code !== 0) throw new Error(peerHistory.stderr)
  expect(existsSync(defaultTranscriptPath(projectCwd, peerReady.engineSessionId))).toBe(true)

  const matchingControlsBeforeReturn = frames.filter(frame => frame.kind === 'run-controls.snapshot' &&
    frame.runControls.model.selected === chosenModel && frame.runControls.effort.selected === chosenEffort).length
  const returned = await reopenedHost.moveSession(appSessionId, null)
  if (!returned.ok) throw new Error(JSON.stringify(returned.error))
  expect(returned.value.appSessionId).toBe(appSessionId)
  expect(returned.value.engineSessionId).toBe(engineSessionId)
  expect(returned.value.binding?.kind).toBe('managed')
  expect(returned.value.cwd).toBe(original.cwd)
  expect(readSessionRelocation(engineSessionId)?.controls.fastMode).toBe(true)
  expect(reopenedRegistry.findSession(peerId)?.cwd).toBe(projectCwd)
  expect(reopenedRegistry.findSession(peerId)?.createdBy).toBe(appSessionId)
  expect(existsSync(defaultTranscriptPath(projectCwd, peerReady.engineSessionId))).toBe(true)
  await waitFor(() => frames.filter(frame => frame.kind === 'run-controls.snapshot' &&
    frame.runControls.model.selected === chosenModel && frame.runControls.effort.selected === chosenEffort).length > matchingControlsBeforeReturn ? true : undefined, 'returned model and effort')
  await waitFor(() => frames.filter(frame => frame.kind === 'permission.context' && frame.context.mode === 'auto' &&
    frame.context.permissionClassifierEnabled).length > autoFramesBeforeMove + 2 ? true : undefined, 'returned Auto mode')
  expect(existsSync(oldTranscript)).toBe(true)
  expect(existsSync(projectTranscript)).toBe(false)
  expect(readFileSync(oldOutput, 'utf8')).toContain(marker)
  expect(readFileSync(projectOutput, 'utf8')).toBe(afterMarker)
  expect(lstatSync(join(dirname(projectTranscript), engineSessionId)).isSymbolicLink()).toBe(true)
  expect(await readPermission(engineSessionId, projectOutput, original.cwd, configHome)).toBe('ask')
  expect(readSessionRelocation(engineSessionId)?.target.binding.kind).toBe('managed')
  const validRecord = readSessionRelocation(engineSessionId)
  if (!validRecord) throw new Error('move record missing')
  expect(() => writeSessionRelocation({ ...validRecord, controls: null } as unknown as typeof validRecord)).toThrow('Invalid conversation move controls')
  expect(readSessionRelocation(engineSessionId)?.controls.mode).toBe('auto')

  mkdirSync(join(root, 'project-b'))
  const projectB = realpathSync(join(root, 'project-b'))
  writeFileSync(join(projectB, 'CLAUDE.md'), 'PROJECT_B_CONTEXT_MARKER\n')
  const projectBHook = join(root, 'project-b-resume-hook')
  mkdirSync(join(projectB, '.cat-code', 'skills', 'b-only'), { recursive: true })
  writeFileSync(join(projectB, '.cat-code', 'skills', 'b-only', 'SKILL.md'),
    '---\nname: b-only\ndescription: Project B context marker\n---\nPROJECT_B_SKILL_MARKER\n')
  writeFileSync(join(projectB, '.cat-code', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ matcher: 'resume', hooks: [{
      type: 'command', command: `printf project-b-resume > '${projectBHook}'`,
    }] }] },
    permissions: { deny: ['Bash(echo:*)'] },
  }))
  const isolatedConfig = JSON.parse(readFileSync(join(configHome, '.config.json'), 'utf8')) as { projects: Record<string, unknown> }
  isolatedConfig.projects[projectB] = { hasTrustDialogAccepted: true }
  writeFileSync(join(configHome, '.config.json'), JSON.stringify(isolatedConfig))
  reopenedSupervisor.send(appSessionId, { type: 'permission.setMode', requestId: randomUUID(), mode: 'plan' })
  await waitFor(() => readSessionRelocation(engineSessionId)?.controls.prePlanMode === 'auto' ? true : undefined, 'saved Plan return mode')
  const beforeProjectB = readyFrames.length
  const movedToB = await reopenedHost.moveSession(appSessionId, projectB)
  if (!movedToB.ok) throw new Error(JSON.stringify(movedToB.error))
  expect(movedToB.value.appSessionId).toBe(appSessionId)
  expect(movedToB.value.engineSessionId).toBe(engineSessionId)
  expect(movedToB.value.contextTransitions?.map(item => item.cwd)).toEqual([projectCwd, original.cwd, projectCwd, original.cwd, projectB])
  await waitFor(() => readyFrames.length > beforeProjectB ? true : undefined, 'project B ready')
  expect(reopenedFrames.filter(frame => frame.kind === 'permission.context').at(-1)).toMatchObject({
    context: { mode: 'plan', prePlanMode: 'auto' },
  })
  expect(reopenedFrames.filter(frame => frame.kind === 'run-controls.snapshot').at(-1)).toMatchObject({
    runControls: { fast: { active: true } },
  })
  expect(existsSync(projectBHook)).toBe(true)
  expect(reopenedFrames.filter(frame => frame.kind === 'permission.context').at(-1)).toMatchObject({
    context: { alwaysDenyRules: { projectSettings: ['Bash(echo:*)'] } },
  })
  const exitsBeforeBPark = exits.length
  reopenedSupervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > exitsBeforeBPark ? true : undefined, 'project B park')
  const projectBProbe = await child([resumeProbe, engineSessionId, marker, '--catalog'], projectB, configHome)
  if (projectBProbe.code !== 0) throw new Error(projectBProbe.stderr)
  const projectBContext = JSON.parse(value(projectBProbe.stdout, 'RESUME_RESULT')) as typeof projectContext
  expect(projectBContext.instructionContext).toContain('PROJECT_B_CONTEXT_MARKER')
  expect(projectBContext.instructionContext).not.toContain('PROJECT_CONTEXT_MARKER')
  expect(projectBContext.discoveredSkillNames).toContain('b-only')
  expect(projectBContext.discoveredSkillNames).not.toContain('project-only')
  expect(projectBContext.historyCwd).toBe(projectB)
  const wokeB = await reopenedHost.restoreSession(appSessionId)
  if (!wokeB.ok) throw new Error(JSON.stringify(wokeB.error))
  await waitFor(() => readyFrames.length > beforeProjectB + 1 ? true : undefined, 'project B wake')
  await waitFor(() => reopenedFrames.filter(frame => frame.kind === 'permission.context').at(-1)?.context.prePlanMode === 'auto' &&
    reopenedFrames.filter(frame => frame.kind === 'run-controls.snapshot').at(-1)?.runControls.fast.active === true ? true : undefined, 'woken Plan and Fast')
  reopenedSupervisor.send(appSessionId, { type: 'permission.setMode', requestId: randomUUID(), mode: 'auto' })
  await waitFor(() => readSessionRelocation(engineSessionId)?.controls.mode === 'auto' &&
    readSessionRelocation(engineSessionId)?.controls.prePlanMode === undefined ? true : undefined, 'returned Auto after Plan')
  const returnedFromB = await reopenedHost.moveSession(appSessionId, null)
  if (!returnedFromB.ok) throw new Error(JSON.stringify(returnedFromB.error))
  expect(returnedFromB.value.contextTransitions?.map(item => item.cwd)).toEqual([projectCwd, original.cwd, projectCwd, original.cwd, projectB, original.cwd])
  expect(existsSync(defaultTranscriptPath(projectB, engineSessionId))).toBe(false)
  expect(readSessionRelocation(engineSessionId)?.controls.fastMode).toBe(true)

  writeFileSync(join(projectCwd, '.cat-code', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(rm:*)'], disableAutoMode: 'disable' },
  }))
  const unavailable = await reopenedHost.moveSession(appSessionId, projectCwd)
  expect(unavailable.ok).toBe(false)
  if (!unavailable.ok) expect(unavailable.error.message).toContain('destination settings disable it')
  expect(reopenedRegistry.findSession(appSessionId)?.cwd).toBe(original.cwd)
  expect(readSessionRelocation(engineSessionId)?.target.cwd).toBe(original.cwd)
  expect(existsSync(oldTranscript)).toBe(true)
  expect(existsSync(projectTranscript)).toBe(false)
  expect(reopenedHost.canResume(appSessionId)).toBe(true)
  const exitsBeforeFinalPark = exits.length
  reopenedSupervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > exitsBeforeFinalPark ? true : undefined, 'returned Chat park')
  const chatContextProbe = await child([resumeProbe, engineSessionId, marker, '--catalog'], original.cwd, configHome)
  if (chatContextProbe.code !== 0) throw new Error(chatContextProbe.stderr)
  const chatContext = JSON.parse(value(chatContextProbe.stdout, 'RESUME_RESULT')) as typeof projectContext
  expect(chatContext.instructionContext).toContain('CHAT_CONTEXT_MARKER')
  expect(chatContext.instructionContext).not.toContain('PROJECT_CONTEXT_MARKER')
  expect(chatContext.invokedSkillPaths.some(path => path.startsWith(original.cwd))).toBe(true)
  expect(chatContext.invokedSkillPaths.some(path => path.startsWith(configHome))).toBe(true)
  expect(chatContext.discoveredSkillNames).toContain('chat-only')
  expect(chatContext.discoveredSkillNames).not.toContain('project-only')
  expect(chatContext.hasHistoricalSkillListing).toBe(false)
  expect(chatContext.historyCwd).toBe(original.cwd)
  expect(chatContext.historyBinding).toBe('managed')
  expect(resolveOpenHistorySession(engineSessionId, [], chatContext.catalog)).toMatchObject({
    kind: 'spawn', cwd: original.cwd, binding: original.binding,
  })

  // A crash after the first rename must not become a resumable half-move when
  // the lease owner dies. The durable record blocks the normal resume owner
  // before it can run the destination's SessionStart hook.
  const complete = readSessionRelocation(engineSessionId)
  if (!complete) throw new Error('move record missing')
  expect(existsSync(join(complete.backup, `${engineSessionId}.jsonl`))).toBe(true)
  expect(existsSync(join(complete.backup, engineSessionId))).toBe(true)
  writeSessionRelocation({ ...complete, phase: 'moving' })
  renameSync(oldTranscript, projectTranscript)
  unlinkSync(hookMarker)
  expect(reopenedHost.canResume(appSessionId)).toBe(false)
  expect(reopenedHost.listSessions().some(row => row.appSessionId === appSessionId)).toBe(true)
  expect(reopenedHost.canPreview(appSessionId)).toBe(false)
  const blockedRestore = await reopenedHost.restoreSession(appSessionId)
  expect(blockedRestore.ok).toBe(false)
  if (!blockedRestore.ok) expect(blockedRestore.error.message).toContain('unfinished')
  const incomplete = await child([resumeProbe, engineSessionId, marker], projectCwd, configHome)
  expect(incomplete.code).not.toBe(0)
  expect(incomplete.stdout).not.toContain('RESUME_RESULT=')
  expect(incomplete.stderr).toContain('unfinished move')
  expect(existsSync(hookMarker)).toBe(false)
}, 180_000)

test('empty Chat moves live, parked and closed without losing its identity or startup artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'catcode-empty-chat-move-'))
  roots.push(root)
  const configHome = join(root, 'config')
  const projectFolder = join(root, 'project')
  mkdirSync(configHome)
  mkdirSync(projectFolder)
  const projectCwd = realpathSync(projectFolder)
  const startupMarker = join(root, 'project-startup-hook')
  mkdirSync(join(projectCwd, '.cat-code'))
  writeFileSync(join(projectCwd, '.cat-code', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [{
      type: 'command', command: `printf project-startup > '${startupMarker}'`,
    }] }] },
  }))
  const networkBlocker = join(root, 'block-network.ts')
  writeFileSync(networkBlocker, 'globalThis.fetch = (async () => new Response("Network disabled in relocation probe", { status: 503 })) as typeof fetch\n')
  process.env.CLAUDE_CONFIG_DIR = configHome
  writeFileSync(join(configHome, '.config.json'), JSON.stringify({
    projects: { [projectCwd]: { hasTrustDialogAccepted: true } },
  }))
  const managedStorage = new ManagedStorage({ appDataBase: join(root, 'app-data'), ownershipDir: join(configHome, 'chat-workspaces') })
  const registry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
  await registry.launch()
  const supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun', sidecarArgs: [`--preload=${networkBlocker}`, ...SIDECAR_RUNTIME_ARGS, sidecarEntry],
    sidecarEnv: { CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_API_KEY: 'sk-ant-local-probe', NODE_ENV: 'development' },
  })
  supervisors.push(supervisor)
  const host = new Host({
    supervisor, registry, managedStorage,
    now: lifecycleAdmissionClock(),
    validateCwd: cwd => { try { return { ok: true, realpath: realpathSync(cwd) } } catch { return { ok: false } } },
    relocate: request => runSessionRelocationWorker({
      command: 'bun', args: [`--preload=${networkBlocker}`, 'run', relocationWorker], cwd: request.source.cwd,
      request: { type: 'session-relocation', version: 1, ...request },
      env: { CLAUDE_CONFIG_DIR: configHome, NODE_ENV: 'development' },
    }),
    log: line => process.stderr.write(`${line}\n`),
  })
  const ready: ReadyFrame[] = []
  const exits: Array<{ sessionId: string; code: number | null }> = []
  supervisor.subscribe(event => {
    if (event.type === 'frame' && event.frame.kind === 'ready') ready.push(event.frame)
    if (event.type === 'exit') exits.push({ sessionId: event.sessionId, code: event.code })
  })
  const created = await host.createManagedChat()
  if (!created.ok) throw new Error(JSON.stringify(created.error))
  const appSessionId = created.value.appSessionId
  const initial = await waitFor(() => ready.find(frame => frame.sessionId === appSessionId), 'empty Chat ready')
  const engineSessionId = initial.engineSessionId
  const original = registry.findSession(appSessionId)
  if (!original || original.binding.kind !== 'managed') throw new Error('managed Chat missing')
  const originalTranscript = defaultTranscriptPath(original.cwd, engineSessionId)
  expect(existsSync(originalTranscript)).toBe(false)
  const untrusted = join(root, 'untrusted')
  mkdirSync(untrusted)
  const refusedEmpty = await host.moveSession(appSessionId, realpathSync(untrusted))
  expect(refusedEmpty.ok).toBe(false)
  if (!refusedEmpty.ok) expect(refusedEmpty.error.message).toContain('Open and trust')
  expect(readSessionRelocation(engineSessionId)).toBeNull()
  expect(registry.findSession(appSessionId)?.cwd).toBe(original.cwd)
  const movedLive = await host.moveSession(appSessionId, projectCwd)
  if (!movedLive.ok) throw new Error(JSON.stringify(movedLive.error))
  expect(movedLive.value).toMatchObject({ appSessionId, engineSessionId, cwd: projectCwd, binding: { kind: 'project' } })
  await waitFor(() => existsSync(startupMarker) ? true : undefined, 'project startup context')
  expect(readSessionRelocation(engineSessionId)?.empty).toBe(true)
  expect(existsSync(defaultTranscriptPath(projectCwd, engineSessionId))).toBe(false)

  const exitCount = exits.length
  supervisor.send(appSessionId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > exitCount ? true : undefined, 'empty project park')
  const movedParked = await host.moveSession(appSessionId, null)
  if (!movedParked.ok) throw new Error(JSON.stringify(movedParked.error))
  expect(movedParked.value).toMatchObject({ appSessionId, engineSessionId, cwd: original.cwd, binding: original.binding })
  expect(supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready')).toBe(false)

  await host.closeSession(appSessionId)
  const visibleEvents: string[] = []
  const unsubscribe = host.subscribe(event => {
    if (event.type === 'session-added' && event.session.appSessionId === appSessionId) visibleEvents.push('opened')
  })
  const movedClosed = await host.moveSession(appSessionId, projectCwd)
  if (!movedClosed.ok) throw new Error(JSON.stringify(movedClosed.error))
  expect(movedClosed.value).toMatchObject({ appSessionId, engineSessionId, cwd: projectCwd, binding: { kind: 'project' } })
  expect(visibleEvents).toEqual([])
  expect(supervisor.listSessions().some(item => item.sessionId === appSessionId && item.status === 'ready')).toBe(false)
  const relaunchedRegistry = new SessionRegistry({ storageDir: join(root, 'registry'), log: () => {} })
  await relaunchedRegistry.launch()
  expect(relaunchedRegistry.findSession(appSessionId)).toMatchObject({ engineSessionId, cwd: projectCwd })
  unsubscribe()

  const readyBeforeOpen = ready.length
  const opened = await host.restoreSession(appSessionId)
  if (!opened.ok) throw new Error(JSON.stringify(opened.error))
  await waitFor(() => ready.length > readyBeforeOpen ? true : undefined, 'empty project reopen')
  expect(ready.at(-1)?.engineSessionId).toBe(engineSessionId)
  expect(registry.findSession(appSessionId)?.cwd).toBe(projectCwd)
  // The first actual submit runs in the new process rooted at the project.
  // Network is blocked by the preload, so this cannot contact a model/account.
  supervisor.send(appSessionId, { type: 'app.submit', requestId: randomUUID(), prompt: 'Reply with one word.' })
  const projectTranscript = defaultTranscriptPath(projectCwd, engineSessionId)
  await waitFor(() => existsSync(projectTranscript) && readFileSync(projectTranscript, 'utf8').includes('Reply with one word.') ? true : undefined, 'first project submit')
  expect(existsSync(originalTranscript)).toBe(false)
  await waitFor(() => registry.findSession(appSessionId)?.hasAcceptedInput === true &&
    readSessionRelocation(engineSessionId)?.empty !== true ? true : undefined, 'first input recorded')

  const unallocated = managedStorage.create()
  if (!unallocated.ok) throw new Error('could not allocate empty Chat folder')
  const preReadyAppId = randomUUID()
  await registry.upsertOnSpawn({ appSessionId: preReadyAppId, cwd: unallocated.cwd,
    binding: unallocated.binding, forked: false })
  await registry.markClean(preReadyAppId)
  expect(registry.findSession(preReadyAppId)?.engineSessionId).toBeNull()
  const movedBeforeId = await host.moveSession(preReadyAppId, projectCwd)
  if (!movedBeforeId.ok) throw new Error(JSON.stringify(movedBeforeId.error))
  expect(movedBeforeId.value.engineSessionId).not.toBe(preReadyAppId)
  expect(movedBeforeId.value.engineSessionId).toMatch(/^[0-9a-f]{8}-/)
  expect(supervisor.listSessions().some(item => item.sessionId === preReadyAppId && item.status === 'ready')).toBe(false)
  const returnedBeforeMessage = await host.moveSession(preReadyAppId, null)
  if (!returnedBeforeMessage.ok) throw new Error(JSON.stringify(returnedBeforeMessage.error))
  expect(returnedBeforeMessage.value.engineSessionId).toBe(movedBeforeId.value.engineSessionId)

  const artifactChat = await host.createManagedChat()
  if (!artifactChat.ok) throw new Error(JSON.stringify(artifactChat.error))
  const artifactAppId = artifactChat.value.appSessionId
  const artifactReady = await waitFor(() => ready.find(frame => frame.sessionId === artifactAppId), 'artifact Chat ready')
  const artifactRow = registry.findSession(artifactAppId)
  if (!artifactRow) throw new Error('artifact Chat row missing')
  const artifactTranscript = defaultTranscriptPath(artifactRow.cwd, artifactReady.engineSessionId)
  mkdirSync(dirname(artifactTranscript), { recursive: true })
  writeFileSync(artifactTranscript, `${JSON.stringify({ type: 'tag', sessionId: artifactReady.engineSessionId, tag: 'startup-state' })}\n`)
  const companion = join(dirname(artifactTranscript), artifactReady.engineSessionId)
  mkdirSync(companion)
  writeFileSync(join(companion, 'startup-artifact'), 'kept')
  const artifactExitCount = exits.length
  supervisor.send(artifactAppId, { type: 'app.park', requestId: randomUUID() })
  await waitFor(() => exits.length > artifactExitCount ? true : undefined, 'artifact Chat park')
  const movedArtifact = await host.moveSession(artifactAppId, projectCwd)
  if (!movedArtifact.ok) throw new Error(JSON.stringify(movedArtifact.error))
  const projectArtifact = defaultTranscriptPath(projectCwd, artifactReady.engineSessionId)
  expect(readFileSync(projectArtifact, 'utf8')).toContain('startup-state')
  expect(readFileSync(join(dirname(projectArtifact), artifactReady.engineSessionId, 'startup-artifact'), 'utf8')).toBe('kept')
  const returnedArtifact = await host.moveSession(artifactAppId, null)
  if (!returnedArtifact.ok) throw new Error(JSON.stringify(returnedArtifact.error))
  expect(readFileSync(artifactTranscript, 'utf8')).toContain('startup-state')
}, 180_000)
