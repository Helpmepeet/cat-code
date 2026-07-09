import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import { BRIDGE_SAFE_COMMANDS, type Command } from '../../src/commands.js'
import {
  buildBridgeStatusSnapshot,
  buildCommandFilterSnapshot,
  createSidecarRemoteSettingsDomain,
  type RemoteSettingsCommandExecutor,
} from './remoteSettingsDomain.js'

function makeStore(overrides: Partial<ReturnType<typeof getDefaultAppState>> = {}) {
  return createStore({ ...getDefaultAppState(), ...overrides })
}

function promptCommand(name: string): Command {
  return { type: 'prompt', name, description: name } as unknown as Command
}
function localCommand(name: string): Command {
  return {
    type: 'local',
    name,
    description: name,
    supportsNonInteractive: false,
    load: async () => ({ call: async () => ({ type: 'text' as const, value: '' }) }),
  } as unknown as Command
}
function localJsxCommand(name: string): Command {
  return {
    type: 'local-jsx',
    name,
    description: name,
    load: async () => ({ call: async () => null }),
  } as unknown as Command
}

function fakeExecutor(
  overrides: Partial<RemoteSettingsCommandExecutor> = {},
): RemoteSettingsCommandExecutor {
  return {
    checkBridgePrerequisites: async () => null,
    directConnect: async (serverUrl, cwd) => ({
      sessionId: `sess-for-${serverUrl}-${cwd}`,
      wsUrl: `ws://${serverUrl}`,
    }),
    ...overrides,
  }
}

/* ── pure builders ─────────────────────────────────────────────────────── */

test('buildBridgeStatusSnapshot reads enabled/error straight off AppState', () => {
  const snap = buildBridgeStatusSnapshot({
    replBridgeEnabled: true,
    replBridgeError: 'disabled after repeated failures',
  })
  expect(snap.enabled).toBe(true)
  expect(snap.error).toBe('disabled after repeated failures')
})

test('buildBridgeStatusSnapshot maps a missing error to null', () => {
  const snap = buildBridgeStatusSnapshot({
    replBridgeEnabled: false,
    replBridgeError: undefined,
  })
  expect(snap.error).toBeNull()
})

test('buildCommandFilterSnapshot buckets by real command type, not a copied list', () => {
  const commands: Command[] = [
    promptCommand('summarize'),
    localCommand('compact'), // BRIDGE_SAFE_COMMANDS member (real import identity required)
    localCommand('not-opted-in'), // local but NOT in BRIDGE_SAFE_COMMANDS
    localJsxCommand('model'),
  ]
  const filter = buildCommandFilterSnapshot(commands, cmd => cmd.name)
  expect(filter.skillSafe).toEqual(['summarize'])
  expect(filter.blocked).toEqual(['model'])
  // 'compact' is a fresh fixture object here, not the real BRIDGE_SAFE_COMMANDS
  // member, so isBridgeSafeCommand (identity-based Set membership) rejects it —
  // proving the bucketing goes through the REAL predicate, not a name match.
  expect(filter.optIn).toEqual([])
  expect(filter.skillSafe.length + filter.optIn.length + filter.blocked.length).toBe(2)
})

test('buildCommandFilterSnapshot buckets a REAL BRIDGE_SAFE_COMMANDS member as opt-in', () => {
  const realSafeCommand = [...BRIDGE_SAFE_COMMANDS][0]
  expect(realSafeCommand).toBeDefined()
  const filter = buildCommandFilterSnapshot([realSafeCommand!], cmd => cmd.name)
  expect(filter.optIn).toEqual([realSafeCommand!.name])
  expect(filter.skillSafe).toEqual([])
  expect(filter.blocked).toEqual([])
})

test('buildCommandFilterSnapshot sorts each bucket', () => {
  const commands: Command[] = [promptCommand('zebra'), promptCommand('alpha')]
  const filter = buildCommandFilterSnapshot(commands, cmd => cmd.name)
  expect(filter.skillSafe).toEqual(['alpha', 'zebra'])
})

/* ── domain: snapshot ──────────────────────────────────────────────────── */

test('getSnapshot reflects the live store, not a frozen read', () => {
  const store = makeStore({ replBridgeEnabled: false })
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor(),
  })
  expect(domain.getSnapshot()?.bridge.enabled).toBe(false)
  store.setState(prev => ({ ...prev, replBridgeEnabled: true }))
  expect(domain.getSnapshot()?.bridge.enabled).toBe(true)
})

/* ── domain: bridgeToggle verb ────────────────────────────────────────── */

test('bridgeToggle enable runs prerequisites then flips the real flag', async () => {
  const store = makeStore({ replBridgeEnabled: false })
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor(),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.bridgeToggle',
    requestId: 'r1',
    enable: true,
  })

  expect(result.ok).toBe(true)
  expect(flagChanged).toBe(true)
  expect(store.getState().replBridgeEnabled).toBe(true)
  expect(store.getState().replBridgeExplicit).toBe(true)
})

test('bridgeToggle enable fails closed when prerequisites reject, and does not flip the flag', async () => {
  const store = makeStore({ replBridgeEnabled: false })
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor({
      checkBridgePrerequisites: async () => 'Remote Control is disabled by policy.',
    }),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.bridgeToggle',
    requestId: 'r2',
    enable: true,
  })

  expect(result.ok).toBe(false)
  expect(result.message).toBe('Remote Control is disabled by policy.')
  expect(flagChanged).toBe(false)
  expect(store.getState().replBridgeEnabled).toBe(false)
})

test('bridgeToggle disable flips the flag off without running prerequisites', async () => {
  const store = makeStore({ replBridgeEnabled: true })
  let prereqCalls = 0
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor({
      checkBridgePrerequisites: async () => {
        prereqCalls++
        return null
      },
    }),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.bridgeToggle',
    requestId: 'r3',
    enable: false,
  })

  expect(result.ok).toBe(true)
  expect(flagChanged).toBe(true)
  expect(store.getState().replBridgeEnabled).toBe(false)
  expect(prereqCalls).toBe(0)
})

test('bridgeToggle is idempotent — no-op when already in the requested state', async () => {
  const store = makeStore({ replBridgeEnabled: true })
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor(),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.bridgeToggle',
    requestId: 'r4',
    enable: true,
  })

  expect(result.ok).toBe(true)
  expect(flagChanged).toBe(false)
})

/* ── domain: directConnect verb ───────────────────────────────────────── */

test('directConnect success returns the redacted target (no token)', async () => {
  const store = makeStore()
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor(),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.directConnect',
    requestId: 'r5',
    serverUrl: 'cc://host:8200',
  })

  expect(result.ok).toBe(true)
  expect(flagChanged).toBe(false)
  expect(result.directConnect?.sessionId).toBe('sess-for-cc://host:8200-/tmp/proj')
  expect(JSON.stringify(result)).not.toContain('token')
})

test('directConnect uses the SESSION cwd, never a renderer-supplied one (HC1)', async () => {
  const store = makeStore()
  let receivedCwd: string | undefined
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/real/session/cwd',
    commands: [],
    executor: fakeExecutor({
      directConnect: async (serverUrl, cwd) => {
        receivedCwd = cwd
        return { sessionId: 's', wsUrl: 'ws://x' }
      },
    }),
  })

  await domain.runVerb({
    type: 'remoteSettings.directConnect',
    requestId: 'r6',
    serverUrl: 'cc://host:8200',
  })

  expect(receivedCwd).toBe('/real/session/cwd')
})

test('directConnect failure degrades to an ok:false result, never a thrown error', async () => {
  const store = makeStore()
  const domain = createSidecarRemoteSettingsDomain({
    appStateStore: store,
    cwd: '/tmp/proj',
    commands: [],
    executor: fakeExecutor({
      directConnect: async () => {
        throw new Error('Failed to connect to server at cc://bad: ECONNREFUSED')
      },
    }),
  })

  const { result, flagChanged } = await domain.runVerb({
    type: 'remoteSettings.directConnect',
    requestId: 'r7',
    serverUrl: 'cc://bad',
  })

  expect(result.ok).toBe(false)
  expect(result.message).toContain('ECONNREFUSED')
  expect(flagChanged).toBe(false)
})
