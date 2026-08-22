/**
 * Runs INSIDE the Electron main process (injected with `electron --require`), the
 * same seam `harness-demo-driver.ts` uses.
 *
 * Its whole job is to photograph the real renderer. Not a string snapshot and not
 * happy-dom: real Chromium layout, real fonts, real colour, so a drift that only
 * shows up in pixels is visible to something other than the operator's eyes
 * (`docs/plans/2026-08-22-headless-visual-acceptance-harness.md`).
 *
 * The window is never shown. `main.ts` skips its `show()` under
 * `CATCODE_HEADLESS_CAPTURE=1`, and a never-shown window still paints, so
 * `capturePage` returns real pixels from it while nothing is raised over the
 * operator's work. Measured on Electron 33.4.11: capture and `sendInputEvent`
 * both work in that state, and `showInactive()` — the obvious alternative — takes
 * focus, which this must never do.
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const outDir = mustEnv('CATCODE_CAPTURE_OUT')
/** Milliseconds to let the shell settle after first paint before the first frame. */
const settleMs = Number(process.env.CATCODE_CAPTURE_SETTLE_MS ?? '1200')

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void run(window)
  })
})

async function run(window: BrowserWindow): Promise<void> {
  try {
    mkdirSync(outDir, { recursive: true })

    // A shown window would mean the show-gate regressed, and the run would be
    // stealing focus. Fail rather than quietly photograph a raised window.
    if (window.isVisible()) {
      throw new Error('window is visible; the capture-run show gate did not hold')
    }

    await settle(settleMs)
    // Animations and the caret are the classic sources of a screenshot that
    // differs from itself. Freeze them before the first frame, not per capture.
    await window.webContents.insertCSS(
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
    )
    await settle(150)

    const captured: string[] = []
    for (const shot of SHOTS) {
      if (shot.prepare) await shot.prepare(window)
      await settle(shot.settleMs ?? 250)
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`capture produced no pixels: ${shot.name}`)
      const file = join(outDir, `${shot.name}.png`)
      writeFileSync(file, image.toPNG())
      const { width, height } = image.getSize()
      captured.push(shot.name)
      process.stdout.write(`[capture] ${shot.name} ${width}x${height} -> ${file}\n`)
    }

    process.stdout.write(`[capture] done ${captured.length}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(
      `[capture] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    app.exit(1)
  }
}

type Shot = {
  name: string
  settleMs?: number
  prepare?: (window: BrowserWindow) => Promise<void>
}

/**
 * Stage 1 is deliberately one frame of the default shell. The scenario list is
 * where Stage 2's interaction steps attach; keeping it a plain array means adding
 * a state is adding a row, not editing the driver.
 */
const SHOTS: Shot[] = [{ name: 'shell-default', settleMs: 400 }]

function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function mustEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
