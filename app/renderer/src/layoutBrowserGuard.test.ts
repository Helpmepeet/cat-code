import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function runWithFakeBrowser(seatbelt: boolean) {
  const scratch = mkdtempSync(join(tmpdir(), 'layout-browser-guard-'))
  try {
    const fake = join(scratch, 'chrome')
    const started = join(scratch, 'started')
    writeFileSync(fake, `#!/bin/sh
: > "$LAYOUT_BROWSER_STARTED"
if [ "$1" = --version ]; then
  printf '%s\n' 'Fake Chrome'
else
  printf '%s\n' '<pre id="result">ok</pre>'
fi
`, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = { ...process.env, CHROME_BIN: fake, LAYOUT_BROWSER_STARTED: started }
    if (seatbelt) env.CODEX_SANDBOX = 'seatbelt'
    else delete env.CODEX_SANDBOX
    const result = spawnSync(process.execPath, ['-e', `
      import { runLayoutBrowser } from ${JSON.stringify(new URL('./layoutBrowser.testSupport.ts', import.meta.url).href)}
      console.log(runLayoutBrowser('fixture.html', ${JSON.stringify(join(scratch, 'profile'))}, 800).stdout)
    `], { env, encoding: 'utf8', timeout: 5_000 })
    return { ...result, started: existsSync(started) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test.skipIf(process.platform !== 'darwin')('Codex Seatbelt blocks the layout browser before even probing its version', () => {
  const run = runWithFakeBrowser(true)
  expect(run.status, run.stderr).toBe(1)
  expect(run.stderr).toContain('one-time outside-sandbox approval')
  expect(run.started).toBe(false)
})

test.skipIf(process.platform === 'win32')('normal layout browser runs still execute CHROME_BIN and return the DOM', () => {
  const run = runWithFakeBrowser(false)
  expect(run.status, run.stderr).toBe(0)
  expect(run.stdout).toContain('<pre id="result">ok</pre>')
  expect(run.started).toBe(true)
})
