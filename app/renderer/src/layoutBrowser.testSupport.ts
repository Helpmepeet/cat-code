import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const layoutBrowser = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find(path => existsSync(path))

if (process.env.CI && !layoutBrowser) {
  throw new Error('Layout tests require Chrome in CI; set CHROME_BIN')
}

let browserVersion: string | undefined

export function runLayoutBrowser(file: string, profile: string, width: number): {
  stdout: string
  diagnostics: string
} {
  if (!layoutBrowser) throw new Error('No layout browser available')
  if (browserVersion === undefined) {
    const version = spawnSync(layoutBrowser, ['--version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 16_384,
    })
    browserVersion = version.stdout?.trim() || version.error?.message || 'unknown'
    console.info(`[layout-browser] ${layoutBrowser}: ${browserVersion}`)
  }
  const started = performance.now()
  // Each fixture owns its profile and must not wait for a macOS keychain prompt.
  const run = spawnSync(layoutBrowser, [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--password-store=basic', '--use-mock-keychain', '--disable-background-networking',
    `--user-data-dir=${profile}`, `--window-size=${width},900`, '--dump-dom',
    pathToFileURL(file).href,
  ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1_048_576 })
  const stdout = run.stdout ?? ''
  const diagnostics = JSON.stringify({
    browser: layoutBrowser,
    version: browserVersion,
    durationMs: Math.round(performance.now() - started),
    status: run.status,
    signal: run.signal,
    error: run.error?.message,
    hasSnapshot: /<pre id="result">.+?<\/pre>/.test(stdout),
    stdoutTail: stdout.slice(-4000),
    stderrTail: (run.stderr ?? '').slice(-4000),
  }, null, 2)
  if (run.error || run.status !== 0) {
    throw new Error(`Layout browser failed:\n${diagnostics}`)
  }
  return { stdout, diagnostics }
}
