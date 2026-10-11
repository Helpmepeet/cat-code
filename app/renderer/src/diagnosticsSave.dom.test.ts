import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import { App } from './App.js'
import { SessionPane } from './SessionPane.js'
import { ToastHost } from './ToastHost.js'
import { createDomTestHarness, type DomTestHarness, type MountedTree } from './domTestHarness.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'
import { PROTOCOL_VERSION, type SaveDiagnosticsResult, type ServerFrame } from '../../shared/protocol.js'

let harness: DomTestHarness
let previousBridge: typeof window.catcode | undefined
let save: () => Promise<SaveDiagnosticsResult>
let saves = 0

beforeAll(async () => {
  harness = await createDomTestHarness()
  previousBridge = window.catcode
  const bridge: Pick<typeof window.catcode,
    'recordRenderCommit' | 'subscribe' | 'rendererReady' | 'subscribeHost' |
    'readProjectRoutes' | 'listSessions' | 'readSessionsCatalog' |
    'reportVisibleSessions' | 'readSettingsInventory' | 'saveDiagnosticsBundle'
  > = {
    recordRenderCommit() {},
    subscribe: () => () => {},
    rendererReady() {},
    subscribeHost: () => () => {},
    readProjectRoutes: async () => [],
    listSessions: async () => [],
    readSessionsCatalog: async () => null,
    reportVisibleSessions() {},
    readSettingsInventory: async () => ({
      ok: true,
      inventory: {
        cwd: '/isolated-test', extensions: { mcp: [], plugins: [], skills: [], hooks: [] },
        agents: { definitions: [], failedFiles: [], availableMcpServers: [] },
        settings: null, memory: null,
      },
    }),
    saveDiagnosticsBundle: () => { saves += 1; return save() },
  }
  window.catcode = bridge as typeof window.catcode
})
afterEach(async () => {
  await harness.unmountAll()
  window.localStorage.clear()
  saves = 0
})
afterAll(async () => {
  if (previousBridge) window.catcode = previousBridge
  else delete (window as unknown as Record<string, unknown>).catcode
  await harness.teardown()
})

function button(tree: MountedTree, label: string): HTMLButtonElement {
  const found = [...tree.container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

const failureFrame = {
  kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1',
  event: { type: 'message', message: {
    type: 'result', subtype: 'error_during_execution', is_error: true,
    duration_ms: 1, uuid: '00000000-0000-4000-8000-000000000003',
  } },
} as ServerFrame

async function mountRoute(route: 'settings' | 'transcript'): Promise<MountedTree> {
  if (route === 'settings') {
    const tree = await harness.mount(createElement(ToastHost, null, createElement(App)))
    await act(async () => button(tree, 'Settings').click())
    await act(async () => button(tree, 'Diagnostics').click())
    return tree
  }
  const ready: ServerFrame = {
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'session-1',
    engineSessionId: 'engine-session-1', payload: {
      type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
      abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
    },
  }
  const transcript = projectServerFrame(projectServerFrame(createTranscriptState(), ready), failureFrame)
  return harness.mount(createElement(ToastHost, null, createElement(SessionPane, {
    ...idleSessionPaneProps(), transcript,
  })))
}

// These mounted production consumers own the callback wiring risk; the main
// suite separately exercises real filesystem writes and the native-picker boundary.
for (const route of ['settings', 'transcript'] as const) {
  test(`${route} diagnostics action keeps cancellation quiet, reports failures and retries`, async () => {
    save = async () => 'cancelled'
    const tree = await mountRoute(route)
    const control = button(tree, 'Save diagnostics bundle')
    await act(async () => control.click())
    expect(saves).toBe(1)
    expect(tree.container.querySelector('[aria-label="Notifications"]')).toBeNull()

    for (const response of [
      async () => 'failed' as const,
      async () => { throw new Error('/private/write-failure-marker') },
      async () => false as unknown as SaveDiagnosticsResult,
    ]) {
      save = response
      await act(async () => control.click())
      const notification = tree.container.querySelector<HTMLElement>('[aria-label="Notifications"]')
      expect(notification?.textContent).toContain('Could not save the diagnostics bundle. Try again.')
      expect(notification?.textContent).not.toContain('private/write-failure-marker')
      await act(async () => notification!.querySelector<HTMLButtonElement>('button')!.click())
    }
    expect(saves).toBe(4)
    expect(control.disabled).toBe(false)
    save = async () => 'saved'
    await act(async () => control.click())
    expect(saves).toBe(5)
    expect(tree.container.querySelector('[aria-label="Notifications"]')?.textContent).toContain('Diagnostics bundle saved.')
  })
}
