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
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAnalyticsMatrix } from './visualAcceptanceMatrix.js'

const outDir = mustEnv('CATCODE_CAPTURE_OUT')
// Isolate the single-instance lock and window preferences from an open dev app.
mkdirSync(join(outDir, 'electron-profile'), { recursive: true })
app.setPath('userData', join(outDir, 'electron-profile'))
/** Milliseconds to let the shell settle after first paint before the first frame. */
const settleMs = Number(process.env.CATCODE_CAPTURE_SETTLE_MS ?? '1200')

app.once('browser-window-created', (_event, window) => {
  const trace = (kind: string, detail: unknown) => {
    appendFileSync(join(outDir, 'renderer-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, detail }) + '\n')
  }
  window.webContents.on('console-message', (_event, level, message) => trace('console', { level, message }))
  window.webContents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => trace('navigation', { url, inPlace, mainFrame }))
  window.webContents.on('render-process-gone', (_event, details) => trace('renderer-gone', details))
  window.webContents.on('did-finish-load', () => trace('loaded', {}))
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
    if (process.env.CATCODE_CAPTURE_SCENE === 'analytics-matrix') {
      await runAnalyticsMatrix(window, outDir)
      app.quit()
      return
    }
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
      if (shot.verify && !await window.webContents.executeJavaScript(shot.verify)) {
        throw new Error(`Capture state did not match: ${shot.name}`)
      }
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error(`capture produced no pixels: ${shot.name}`)
      const file = join(outDir, `${shot.name}.png`)
      writeFileSync(file, image.toPNG())
      const { width, height } = image.getSize()
      captured.push(shot.name)
      process.stdout.write(`[capture] ${shot.name} ${width}x${height} -> ${file}\n`)
    }

    process.stdout.write(`[capture] done ${captured.length}\n`)
    writeFileSync(join(outDir, 'result.json'), JSON.stringify({ ok: true, scene: process.env.CATCODE_CAPTURE_SCENE ?? '', captured }))
    app.quit()
  } catch (error) {
    process.stderr.write(
      `[capture] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    const image = await window.webContents.capturePage()
    if (!image.isEmpty()) writeFileSync(join(outDir, 'failure.png'), image.toPNG())
    writeFileSync(join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(error) }))
    process.exitCode = 1
    app.quit()
  }
}

type Shot = {
  name: string
  settleMs?: number
  prepare?: (window: BrowserWindow) => Promise<void>
  verify?: string
}

/**
 * Stage 1 is deliberately one frame of the default shell. The scenario list is
 * where Stage 2's interaction steps attach; keeping it a plain array means adding
 * a state is adding a row, not editing the driver.
 */
const SHOTS: Shot[] = process.env.CATCODE_CAPTURE_SCENE === 'usage' ? [
  { name: 'usage-normal', prepare: async window => {
    window.setMinimumSize(400, 400)
    window.setContentSize(1200, 900)
    await waitForUsage(window, `Boolean(document.querySelector('[data-sidebar-nav-id="usage"]'))`, 'Analytics navigation')
    await window.webContents.executeJavaScript(`document.querySelector('[data-sidebar-nav-id="usage"]').click()`)
    await waitForUsage(window, `Boolean(document.querySelector('.usage-daily-svg'))`, 'Analytics fixture')
    await usageRange(window, '7d')
  }, verify: `document.querySelector('.usage-page').dataset.range === '7d' && !!document.querySelector('.usage-daily-svg')` },
  { name: 'usage-narrow', prepare: async window => { window.setContentSize(520, 1900) }, verify: `innerWidth === 520 && !!document.querySelector('.usage-daily-svg')` },
  { name: 'usage-30d', prepare: async window => {
    window.setContentSize(1920, 1056)
    await usageRange(window, '30d')
  }, verify: `document.querySelector('.usage-page').dataset.range === '30d' && document.querySelectorAll('.usage-daily-hit').length === 30` },
  { name: 'usage-selected-day', prepare: async window => {
    await window.webContents.executeJavaScript(`(() => { const day = document.querySelectorAll('.usage-daily-hit')[25]; if (!day) throw new Error('Missing retained day'); day.scrollIntoView({ block: 'center' }); day.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`)
  }, verify: `document.querySelectorAll('.usage-daily-hit')[25].getAttribute('aria-pressed') === 'true' && !!document.querySelector('.usage-pinned')` },
  { name: 'usage-activity', prepare: async window => {
    window.setContentSize(1440, 1056)
    await window.webContents.executeJavaScript(`document.querySelector('.usage-analytics-details[aria-label="Activity"]').scrollIntoView({ block: 'center' })`)
  }, verify: `document.querySelector('.usage-page').dataset.range === '30d' && document.querySelector('.usage-analytics-details[aria-label="Activity"] .uad-empty').textContent.includes('Hourly tool request detail is unavailable')` },
  { name: 'usage-week-activity', prepare: async window => {
    window.setContentSize(1440, 1056)
    await usageRange(window, '7d')
    await waitForUsage(window, `Boolean(document.querySelector('[aria-label="Hourly tool request heatmap"]'))`, 'hourly tool requests')
    await window.webContents.executeJavaScript(`(() => { const heatmap = document.querySelector('.uad-heatmap'); heatmap.scrollIntoView({ block: 'center' }); const cell = heatmap.querySelector('g[role="button"] rect:not(.uad-level-0):not(.uad-missing-cell)'); if (!cell) throw new Error('Missing populated activity cell'); cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })()`)
  }, verify: `document.querySelector('.usage-page').dataset.range === '7d' && document.querySelector('.usage-analytics-details[aria-label="Activity"] .uad-readout').textContent.includes('tool requests')` },
  { name: 'usage-activity-narrow', prepare: async window => {
    window.setContentSize(520, 1100)
    await window.webContents.executeJavaScript(`document.querySelector('.uad-controls[aria-label="Activity view"] button:nth-child(2)').click()`)
    await waitForUsage(window, `Boolean(document.querySelector('[aria-label="Ten-minute concurrency heatmap"]'))`, 'ten-minute concurrency')
    await window.webContents.executeJavaScript(`document.querySelector('.uad-heatmap').scrollIntoView({ block: 'center' })`)
  }, verify: `(() => { const chart = document.querySelector('[aria-label="Ten-minute concurrency heatmap"]'); const rect = chart.getBoundingClientRect(); return innerWidth === 520 && !!document.querySelector('.uad-concurrency') && rect.top >= document.querySelector('.usage-sticky-top').getBoundingClientRect().bottom && rect.bottom <= document.querySelector('.usage-page').getBoundingClientRect().bottom; })()` },
] : [{ name: 'shell-default', settleMs: 400 }]

async function waitForUsage(window: BrowserWindow, expression: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await window.webContents.executeJavaScript(expression)) return
    await settle(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function usageRange(window: BrowserWindow, range: '7d' | '30d'): Promise<void> {
  await window.webContents.executeJavaScript(`document.querySelector('.usage-range button:nth-child(${range === '7d' ? 1 : 2})').click()`)
  await waitForUsage(window, `document.querySelector('.usage-page')?.dataset.range === ${JSON.stringify(range)}`, `Analytics period ${range}`)
}

function settle(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function mustEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
