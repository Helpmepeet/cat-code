/**
 * External production-path Electron hardening harness.
 *
 * The runner loads this as a main-process preload before the real app main
 * bundle. It observes Electron's global browser-window-created event and sends
 * crafted server frames directly to the real preload/renderer. Production main
 * owns the BrowserWindow, CSP, navigation handlers, and window-open handler;
 * no smoke-only branch or fixture is compiled into production code.
 */

import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerFrame } from '../shared/protocol.js'

const CH_SERVER_FRAME = 'catcode:server-frame'
const HARDENING_SESSION_ID = 'hardening-smoke-session'
const HARDENING_MARKER = 'catcode-production-hardening-marker'

// The source-tree Electron launch is normally "development". Override the
// Electron-owned packaging signal before production main evaluates so its
// normal packaged renderer/CSP/navigation branch executes unchanged.
Object.defineProperty(app, 'isPackaged', {
  configurable: true,
  get: () => true,
})

const frames: ServerFrame[] = [
  {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: HARDENING_SESSION_ID,
    engineSessionId: 'hardening-engine-session',
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  },
  {
    kind: 'event',
    protocolVersion: 1,
    sessionId: HARDENING_SESSION_ID,
    event: {
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          id: 'hardening-message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: `${HARDENING_MARKER}

<img src="x" onerror="window.__MARKDOWN_IMG_RAN = true">

<script>window.__MARKDOWN_SCRIPT_RAN = true</script>

[unsafe](javascript:window.__MARKDOWN_LINK_RAN=true)

<a target="_blank" href="https://evil.example">raw target blank</a>

[safe external](https://evil.example)`,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: HARDENING_SESSION_ID,
        uuid: '00000000-0000-4000-8000-000000000003',
      },
    },
  },
]

// P4-15 — put the session under test in the NORMAL state (trusted workspace,
// accounts not-yet-loaded) so neither the session-create trust gate nor the
// first-run OAuth surface covers the transcript pane. This harness verifies
// transcript XSS sanitization, which only occurs in a trusted+opened session;
// without these the real sidecar's spawn-time `workspace-trust.snapshot`
// (`trusted:false` for the temp cwd) would show the gate and the crafted
// Markdown would never render. These are RE-SENT each poll iteration below so
// they reliably post-date the real attach snapshots (last-write-wins), not race
// them.
const gateFrames: ServerFrame[] = [
  {
    kind: 'workspace-trust.snapshot',
    protocolVersion: 1,
    sessionId: HARDENING_SESSION_ID,
    workspaceTrust: { trusted: true, detectedRepo: null, trustRoot: null },
  },
  {
    kind: 'accounts.snapshot',
    protocolVersion: 1,
    sessionId: HARDENING_SESSION_ID,
    accounts: {
      accounts: [],
      activeAccountId: null,
      readyCount: 0,
      poolCount: 0,
      initialized: false,
      anthropicAccounts: [],
      anthropicActiveAccountId: null,
      anthropicReadyCount: 0,
      anthropicPoolCount: 0,
      anthropicInitialized: false,
      anthropicRouteAvailable: false,
    },
  },
]

// Capture the session id of the FIRST frame main delivers to the renderer (the
// real startup session that owns the active pane), so the crafted Markdown can
// be delivered into it. Wraps webContents.send before any frame flows.
let liveSessionId: string | null = null
// P4-15 — the real attach ends its snapshot burst with `workspace-trust.snapshot`
// (P4-14: sent AFTER the other snapshots, before history replay). Observing it
// means the real trust/accounts snapshots have all landed, so the gate-clearing
// override injected afterward is DETERMINISTICALLY last (no re-send race).
let sawAttachSettled = false

function watchForLiveSession(window: BrowserWindow): void {
  const contents = window.webContents
  const originalSend = contents.send.bind(contents)
  contents.send = ((channel: string, ...args: unknown[]) => {
    if (channel === CH_SERVER_FRAME) {
      // Production main batches a delivery as one ServerFrame[] (perf F3); sniff
      // the session id from the first frame of the batch.
      const batch = args[0] as Array<{ sessionId?: unknown; kind?: unknown }> | undefined
      const frame = Array.isArray(batch) ? batch[0] : undefined
      if (liveSessionId === null && frame && typeof frame.sessionId === 'string') {
        liveSessionId = frame.sessionId
      }
      if (Array.isArray(batch) && batch.some(f => f?.kind === 'workspace-trust.snapshot')) {
        sawAttachSettled = true
      }
    }
    return originalSend(channel, ...args)
  }) as typeof contents.send
}

async function resolveActiveSessionId(window: BrowserWindow): Promise<string> {
  const deadline = Date.now() + 5_000
  while (liveSessionId === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // Wait for the real attach snapshots to settle (workspace-trust is last) so the
  // injected trusted/non-first-run override post-dates them deterministically. If
  // no real session ever attaches, fall back to the synthetic id (the crafted
  // frame then acts as the first-ever streaming session, with no real gate).
  while (!sawAttachSettled && liveSessionId !== null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return liveSessionId ?? HARDENING_SESSION_ID
}

app.once('browser-window-created', (_event, window) => {
  watchForLiveSession(window)
  window.webContents.once('did-finish-load', () => {
    void runProductionHardeningSmoke(window)
  })
})

async function runProductionHardeningSmoke(
  window: BrowserWindow,
): Promise<void> {
  type Check = { name: string; pass: boolean; detail?: string }
  const checks: Check[] = []
  const add = (name: string, pass: boolean, detail?: string) => {
    checks.push({ name, pass, detail })
  }

  try {
    // did-finish-load precedes React effects. Wait for the real app mount, then
    // use the same fixed server-frame channel that production main delivers.
    //
    // Multi-session shell (P3-5a): main auto-creates a real startup session, and
    // that session owns the active pane (a background session's frames never
    // steal focus). The crafted Markdown must therefore be delivered INTO the
    // active session, not a synthetic id — otherwise it renders only in a
    // background slice the probe cannot see. Sniff the live session id from the
    // frames main delivers on CH_SERVER_FRAME, then stamp the crafted frames
    // with it so the Markdown lands in the pane under test.
    await new Promise(resolve => setTimeout(resolve, 100))
    const activeSessionId = await resolveActiveSessionId(window)
    const sendGateFrames = () => {
      for (const frame of gateFrames) {
        window.webContents.send(CH_SERVER_FRAME, [{ ...frame, sessionId: activeSessionId }])
      }
    }
    sendGateFrames()
    for (const frame of frames) {
      // Deliver on the same batched contract production main uses (one
      // ServerFrame[] per send); the preload fans it out to `subscribe`.
      window.webContents.send(CH_SERVER_FRAME, [{ ...frame, sessionId: activeSessionId }])
    }

    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      // Re-assert the trusted/non-first-run state each iteration so it reliably
      // post-dates the real attach snapshots (last-write-wins), clearing the
      // P4-15 startup gate so the crafted-Markdown transcript can render.
      sendGateFrames()
      const rendered = await window.webContents.executeJavaScript(
        `document.body.textContent.includes(${JSON.stringify(HARDENING_MARKER)})`,
      )
      if (rendered) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const probe = await window.webContents.executeJavaScript(`(() => {
      const links = Array.from(document.querySelectorAll('a')).map(link => ({
        text: link.textContent,
        href: link.getAttribute('href'),
        target: link.getAttribute('target'),
      }))
      return {
        markerRendered: document.body.textContent.includes(${JSON.stringify(HARDENING_MARKER)}),
        hasRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
        hasModule: typeof window.module !== 'undefined',
        hasGlobal: typeof window.global !== 'undefined',
        markdownScriptRan: window.__MARKDOWN_SCRIPT_RAN === true,
        markdownImgRan: window.__MARKDOWN_IMG_RAN === true,
        markdownLinkRan: window.__MARKDOWN_LINK_RAN === true,
        links,
        hasCatcodeBridge: typeof window.catcode === 'object' && window.catcode !== null,
        bridgeKeys: window.catcode ? Object.keys(window.catcode).sort() : [],
        exposesIpcRenderer: typeof window.ipcRenderer !== 'undefined',
      }
    })()`)

    const expectedBridgeKeys = [
      // Frame plane (engine commands + attachment).
      'abort',
      'accountVerb',
      'answerQuestions',
      'ping',
      'workspaceTrustVerb',
      'remoteSettingsVerb',
      'rendererReady',
      'respondPermission',
      'restart',
      'runControlVerb',
      'sessionActionVerb',
      'setAgentMode',
      'setPermissionMode',
      'settingsVerb',
      'submit',
      'subscribe',
      'taskControlVerb',
      'contextBreakdownVerb',
      // Control plane (P3-3 — HC3 fixed per-method senders).
      'closeSession',
      'createSession',
      'createSessionInWorkspace',
      'listSessions',
      // SESSIONS-UNIFICATION (2026-07-20) — open a terminal-created session by its
      // engine id (HC3 fixed sender; renderer authors no cwd, HC1).
      'openHistorySession',
      'pickDirectory',
      'previewSession',
      // F2 — read-only cold-launch sessions-catalog baseline (HC3 fixed sender).
      'readSessionsCatalog',
      'restoreSession',
      // P4-35 — the file sink (operator ruling 2026-07-30). The renderer requests
      // main's native save dialog and cannot name a destination (HC1/HC3).
      'saveTextToFile',
      // IDLE-PARK §4(b) (2026-08-05) — the visible-pane hint. HC3 fixed one-way
      // sender; it names sessions to EXEMPT from an optimisation, so it can start
      // nothing and reach no sidecar, and main re-validates shape + bounds
      // (`parseVisibleSessions`) because the preload is not the boundary.
      'reportVisibleSessions',
      'subscribeHost',
      // Private desktop diagnostics (2026-08-06). All four terminate in Electron
      // main and appear in neither the supervisor nor the sidecar, so they add no
      // engine vocabulary. Main re-validates the payload-bearing ones because the
      // preload is not the boundary, and the renderer names no path or
      // destination: it asks for the folder and the save dialog (HC1/HC3).
      'deliveryAck',
      'openLogsFolder',
      'reportRendererFault',
      'saveDiagnosticsBundle',
    ].sort()
    const links = probe.links as Array<{
      text: string | null
      href: string | null
      target: string | null
    }>
    const unsafeLink = links.find(link => link.text === 'unsafe')
    const safeLink = links.find(link => link.text === 'safe external')
    const rawTargetBlank = links.find(link => link.text === 'raw target blank')

    add('real renderer projected the crafted Markdown frame', probe.markerRendered)
    add('window.require is undefined', !probe.hasRequire)
    add('window.process is undefined', !probe.hasProcess)
    add('window.module is undefined', !probe.hasModule)
    add('window.global is undefined', !probe.hasGlobal)
    add('Markdown inline <script> did not execute', !probe.markdownScriptRan)
    add('Markdown img onerror did not execute', !probe.markdownImgRan)
    add('Markdown javascript: link did not execute', !probe.markdownLinkRan)
    add(
      'Markdown javascript: URL was removed',
      !unsafeLink?.href?.toLowerCase().startsWith('javascript:'),
      JSON.stringify(unsafeLink),
    )
    add(
      'raw target=_blank HTML was not rendered as an active link',
      rawTargetBlank === undefined,
      JSON.stringify(rawTargetBlank),
    )
    add(
      'safe Markdown https link remains inert in the app document',
      safeLink?.href === 'https://evil.example',
      JSON.stringify(safeLink),
    )
    add('catcode bridge is exposed', probe.hasCatcodeBridge)
    add(
      'bridge exposes exactly the allowlisted methods',
      JSON.stringify(probe.bridgeKeys) === JSON.stringify(expectedBridgeKeys),
      JSON.stringify(probe.bridgeKeys),
    )
    add('raw ipcRenderer is not exposed', !probe.exposesIpcRenderer)

    await window.webContents.executeJavaScript(`(() => {
      const script = document.createElement('script')
      script.textContent = 'window.__DYNAMIC_INLINE_SCRIPT_RAN = true'
      document.body.append(script)
      const image = document.createElement('img')
      image.setAttribute('onerror', 'window.__DYNAMIC_ONERROR_RAN = true')
      image.src = 'file:///definitely-missing-catcode-hardening-image'
      document.body.append(image)
    })()`)
    await new Promise(resolve => setTimeout(resolve, 200))
    const cspProbe = await window.webContents.executeJavaScript(`({
      inlineScriptRan: window.__DYNAMIC_INLINE_SCRIPT_RAN === true,
      inlineOnerrorRan: window.__DYNAMIC_ONERROR_RAN === true,
    })`)
    add('production document CSP blocked dynamic inline script', !cspProbe.inlineScriptRan)
    add('production document CSP blocked inline onerror', !cspProbe.inlineOnerrorRan)

    const originalUrl = window.webContents.getURL()
    await window.webContents.executeJavaScript(
      `window.location.assign('data:text/html,<title>blocked-navigation</title>')`,
    )
    await new Promise(resolve => setTimeout(resolve, 150))
    add(
      'production will-navigate policy blocked a non-app document',
      window.webContents.getURL() === originalUrl,
      window.webContents.getURL(),
    )

    const windowCount = BrowserWindow.getAllWindows().length
    const openResult = await window.webContents.executeJavaScript(
      `window.open('data:text/html,<title>blocked-window</title>', '_blank') === null`,
    )
    await new Promise(resolve => setTimeout(resolve, 100))
    add(
      'production window-open handler denied a new Electron window',
      openResult && BrowserWindow.getAllWindows().length === windowCount,
      `windows=${BrowserWindow.getAllWindows().length}`,
    )

    const debugExportPath = join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'desktop',
      'debug',
      'state.json',
    )
    add(
      'packaged production path did not create debug-state export',
      !existsSync(debugExportPath),
      debugExportPath,
    )
  } catch (error) {
    add(
      'production hardening harness completed',
      false,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  }

  let failed = 0
  for (const check of checks) {
    const mark = check.pass ? 'PASS' : 'FAIL'
    const detail = check.pass || !check.detail ? '' : ` — ${check.detail}`
    process.stdout.write(`[hardening-smoke] ${mark}: ${check.name}${detail}\n`)
    if (!check.pass) failed++
  }
  process.stdout.write(
    `[hardening-smoke] ${checks.length - failed}/${checks.length} passed\n`,
  )
  if (failed === 0) {
    process.stdout.write('[hardening-smoke] production path passed\n')
  }
  app.exit(failed === 0 ? 0 : 1)
}
