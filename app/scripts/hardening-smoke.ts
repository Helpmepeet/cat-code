/**
 * F16 — Electron renderer-hardening smoke test (SECURITY-MINIMUM §3).
 *
 * The live-renderer half of the P1-0 hardening gate: the pure navigation policy
 * is unit-tested in `navigationPolicy.test.ts`, but the behaviors that only
 * exist inside a REAL Electron renderer must be proven in a real renderer:
 *
 *   1. Node globals are absent — `window.require` / `window.process` /
 *      `window.module` are undefined (sandbox + contextIsolation + no
 *      nodeIntegration).
 *   2. The CSP blocks inline execution — an injected inline `<script>` and an
 *      `<img onerror>` handler do NOT run.
 *   3. The preload exposes ONLY the `catcode` bridge (submit/abort/
 *      respondPermission/ping/subscribe/rendererReady) and no raw `ipcRenderer`.
 *
 * Run under Electron (NOT bun:test — it needs the Electron runtime). Electron's
 * Node cannot load a raw `.ts` entry, so it is bundled to `.js` first; use the
 * wrapper, which builds the preload, bundles this harness, and launches it:
 *   bun run app/scripts/run-hardening-smoke.ts   # (or: bun run test:hardening)
 *
 * Exits 0 iff every assertion passed; non-zero (and prints failures) otherwise.
 *
 * This harness re-declares the SAME security baseline as `main.ts` (CSP delivered
 * as a response HEADER + the same webPreferences) rather than importing main
 * (which spawns the supervisor/sidecar and owns app lifecycle). The attack page
 * carries NO <meta> CSP, so a passing inline-script/img-onerror block is
 * attributable to the header alone — a header regression cannot be masked by a
 * page-level meta policy.
 */

import { app, BrowserWindow, protocol } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(__dirname, '..', 'preload', 'preload.cjs')

type Check = { name: string; pass: boolean; detail?: string }

// The CSP under test — the SAME policy main.ts delivers as a response HEADER
// (F9: no 'unsafe-inline'/'unsafe-eval' for scripts).
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/**
 * The crafted attack page: inline script + img onerror that set window flags.
 * Deliberately carries NO <meta> CSP — if either payload fails to run it is
 * because of the HEADER CSP the harness serves, not a page-level meta policy that
 * would mask a header regression.
 */
const ATTACK_HTML = `<!doctype html>
<html>
  <head></head>
  <body>
    <!-- If the header CSP is enforced, neither of these runs. -->
    <script>window.__INLINE_SCRIPT_RAN = true;</script>
    <img src="x" onerror="window.__IMG_ONERROR_RAN = true;" />
  </body>
</html>`

// Serve the page over a registered scheme so the CSP applies as a real response
// HEADER (the mechanism main.ts uses). A `data:`/`file:` load would not exercise
// header delivery the same way.
const SCHEME = 'catcode-smoke'
const PAGE_URL = `${SCHEME}://page/index.html`

function registerAttackProtocol(): void {
  protocol.handle(SCHEME, () => {
    return new Response(ATTACK_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP,
      },
    })
  })
}

async function run(): Promise<Check[]> {
  registerAttackProtocol()

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      preload: preloadPath,
    },
  })

  await window.loadURL(PAGE_URL)
  // Give the inline script / img onerror a chance to (fail to) run.
  await new Promise(resolve => setTimeout(resolve, 300))

  const probe = await window.webContents.executeJavaScript(`(() => ({
    hasRequire: typeof window.require !== 'undefined',
    hasProcess: typeof window.process !== 'undefined',
    hasModule: typeof window.module !== 'undefined',
    hasGlobal: typeof window.global !== 'undefined',
    inlineScriptRan: window.__INLINE_SCRIPT_RAN === true,
    imgOnerrorRan: window.__IMG_ONERROR_RAN === true,
    hasCatcodeBridge: typeof window.catcode === 'object' && window.catcode !== null,
    bridgeKeys: window.catcode ? Object.keys(window.catcode).sort() : [],
    exposesIpcRenderer: typeof window.ipcRenderer !== 'undefined',
  }))()`)

  const expectedBridgeKeys = [
    'abort',
    'ping',
    'rendererReady',
    'respondPermission',
    'submit',
    'subscribe',
  ]

  const checks: Check[] = [
    { name: 'window.require is undefined', pass: !probe.hasRequire },
    { name: 'window.process is undefined', pass: !probe.hasProcess },
    { name: 'window.module is undefined', pass: !probe.hasModule },
    { name: 'window.global is undefined', pass: !probe.hasGlobal },
    {
      name: 'inline <script> did NOT execute (CSP)',
      pass: !probe.inlineScriptRan,
    },
    {
      name: 'img onerror handler did NOT execute (CSP)',
      pass: !probe.imgOnerrorRan,
    },
    { name: 'catcode bridge is exposed', pass: probe.hasCatcodeBridge },
    {
      name: 'bridge exposes exactly the allowlisted methods',
      pass: JSON.stringify(probe.bridgeKeys) === JSON.stringify(expectedBridgeKeys),
      detail: `got ${JSON.stringify(probe.bridgeKeys)}`,
    },
    {
      name: 'raw ipcRenderer is NOT exposed to the renderer',
      pass: !probe.exposesIpcRenderer,
    },
  ]

  window.destroy()
  return checks
}

// Must run BEFORE app is ready: mark the scheme standard + secure so the page
// loads as a normal secure document (a bare custom scheme would be treated as an
// opaque origin and could skip normal CSP/preload behavior).
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

app.whenReady().then(async () => {
  try {
    const checks = await run()
    let failed = 0
    for (const check of checks) {
      const mark = check.pass ? 'PASS' : 'FAIL'
      const extra = check.pass || !check.detail ? '' : ` — ${check.detail}`
      process.stdout.write(`[hardening-smoke] ${mark}: ${check.name}${extra}\n`)
      if (!check.pass) failed++
    }
    process.stdout.write(
      `[hardening-smoke] ${checks.length - failed}/${checks.length} passed\n`,
    )
    app.exit(failed === 0 ? 0 : 1)
  } catch (error) {
    process.stderr.write(
      `[hardening-smoke] harness error: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    )
    app.exit(2)
  }
})
