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
import type { HostEvent } from '../shared/hostApi.js'

const CH_SERVER_FRAME = 'catcode:server-frame'
const CH_HOST_EVENT = 'catcode:host:event'
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

const hostSessionAdded: HostEvent = {
  type: 'session-added',
  session: {
    appSessionId: HARDENING_SESSION_ID,
    engineSessionId: 'hardening-engine-session',
    cwd: '/tmp/catcode-hardening',
    title: null,
    forked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
  },
}

app.once('browser-window-created', (_event, window) => {
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
    // The product starts with no engine session. Add a synthetic host row through
    // the same host-event channel before injecting the crafted frames, so this
    // security probe exercises a real active transcript pane without spawning a
    // sidecar or opening the native directory picker.
    await new Promise(resolve => setTimeout(resolve, 100))
    window.webContents.send(CH_HOST_EVENT, hostSessionAdded)
    await new Promise(resolve => setTimeout(resolve, 100))
    const sendGateFrames = () => {
      for (const frame of gateFrames) {
        window.webContents.send(CH_SERVER_FRAME, [frame])
      }
    }
    sendGateFrames()
    for (const frame of frames) {
      // Deliver on the same batched contract production main uses (one
      // ServerFrame[] per send); the preload fans it out to `subscribe`.
      window.webContents.send(CH_SERVER_FRAME, [frame])
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
      'deleteAccount',
      'ping',
      'refreshAccountsPool',
      // Send-now is bound to an engine-minted queued prompt id and revalidated
      // by the sidecar before it can interrupt a turn.
      'forcePrompt',
      // D1b — take back messages still waiting for the running response. Fixed
      // one-way sender; the renderer authors only a correlation id, so it names
      // no target and cannot reach a subagent's queued work.
      'recallPrompts',
      // Load earlier messages (decisions/HISTORY-LOAD-EARLIER.md). Fixed one-way
      // sender; the renderer authors only a correlation id, so it names no file,
      // no offset and no extent. The sidecar resolves the transcript from its own
      // session identity and owns the ceiling and the in-flight guard.
      'loadEarlierHistory',
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
      'pickAttachmentFile',
      'pickDirectory',
      'previewSession',
      // F2 — read-only cold-launch sessions-catalog baseline (HC3 fixed sender).
      'readSessionsCatalog',
      'restoreSession',
      // 2026-08-13 — open a transcript-cited file in the OS handler. The renderer
      // DOES name a path here, so main is the boundary and re-validates it whole
      // (`app/main/openWorkspaceFile.ts`): closed key set, 4,096-char cap, NUL
      // rejected, the appSessionId must match a live session, and the resolved
      // realpath must stay inside that session's realpath'd cwd and be a regular
      // file. Traversal and symlink escape both fail closed.
      'openWorkspaceFile',
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
      // Light/dark appearance (2026-08-27). Terminates in Electron main and adds
      // no engine vocabulary: there is no frame kind for it and the sidecar never
      // learns the app has an appearance. Its whole payload is a closed set of
      // three literals, the user's choice including follow-the-system, which is
      // the value that releases the override; re-validated in main because the
      // preload is not the boundary, and main's only reaction is assigning
      // nativeTheme.themeSource.
      // It exists at all because macOS reads a window's vibrancy material off
      // the process-wide NSAppearance, which no renderer can move (HC3;
      // app/main/appearanceChannel.test.ts).
      //
      // Those literals are deliberately not spelled with quotes above:
      // `preloadSource.test.ts` scrapes this array for quoted words, so a quoted
      // example in a comment reads as an allowlist entry.
      'setAppearance',
      // Glass mode is a fixed main-only preference sender. Its bounded boolean
      // preserves a solid native background during renderer paint gaps when off.
      'setGlassMode',
      // Usage analytics — the renderer requests an engine-backed stats snapshot.
      // It authors no query: the `stats.query` frame carries a bounded range enum
      // and a request id, schema-validated AT THE SIDECAR (`statsQueryMessageSchema`)
      // which fails closed with `bad_request`, and the snapshot is secretGuard-clean.
      'queryStats',
      // Freeze telemetry — the renderer reports that React committed a render.
      // Argument-free and IPC-free: it only increments a preload-local counter
      // (with an overflow guard) that the health probe reads at sample time, so
      // it reaches neither main nor the sidecar and carries no payload at all.
      'recordRenderCommit',
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
    process.stdout.write('[hardening-smoke] renderer document + main-process policy passed\n')
  }
  // Use Electron's normal lifecycle so production main receives before-quit
  // and synchronously tears down the real sidecars this harness may have spawned.
  process.exitCode = failed === 0 ? 0 : 1
  app.quit()
}
