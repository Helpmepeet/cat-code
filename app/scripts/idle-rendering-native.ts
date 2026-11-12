// Isolated Chromium paint regression. No product main, engine, or saved state.
import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const sourceRoot = process.argv[2]
const state = mkdtempSync(join(tmpdir(), 'catcode-idle-rendering-'))
app.setPath('userData', state)
app.setPath('sessionData', join(state, 'session'))
app.setPath('crashDumps', join(state, 'crash-dumps'))
app.setAppLogsPath(join(state, 'logs'))
app.on('window-all-closed', () => {})
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// Historical paint-heavy styles establish that this fixture exercises the fault.
const baseline = `
.focused-turn[data-focused-live] .focused-shimmer,
.focused-step-head[data-running] .focused-step-verb,
.focused-live-verb {
  background: linear-gradient(90deg, var(--text-subtle) 0 38%, var(--text-primary) 50%, var(--text-subtle) 62% 100%);
  background-size: 300% 100%; background-clip: text; color: transparent;
  animation: baseline-shimmer 1.8s linear infinite;
}
@keyframes baseline-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
`
const labels = '.focused-shimmer,.focused-step-verb,.focused-live-verb'

type Counts = { Paint: number; Layout: number; UpdateLayoutTree: number }
async function run(): Promise<void> {
  assert(sourceRoot, 'Pass the renderer source directory')
  await app.whenReady()
  app.dock?.hide()
  const isolated = session.fromPartition('idle-rendering')
  isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  isolated.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('data:') }))
  const window = new BrowserWindow({
    show: false, width: 1100, height: 900,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const debuggerApi = window.webContents.debugger
  try {
    const css = ['theme.css', 'focusedTranscript.css'].map(file => readFileSync(join(sourceRoot, file), 'utf8')).join('\n')
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>${css}
      :root { --text-subtle:#888; --text-primary:#eee; --text-muted:#aaa; --text-ghost:#666; --shell-seam:#444; }
      body { background:#222; color:#eee; font:13px system-ui; padding:40px; }
      .effort-flow-clip { position:relative; height:24px; overflow:hidden; background:#465; }
      </style>
      <section class="focused-turn" data-focused-live>
        <div class="focused-fold-head"><span class="focused-ticker"><span><span class="focused-shimmer">Working</span></span></span></div>
        <div class="focused-step-head" data-running><span class="focused-step-text"><span class="focused-step-verb">Reading</span> source.ts</span></div>
        <div class="focused-thinking"><span class="focused-ticker"><span><span class="focused-live-verb">Thinking</span></span></span></div>
      </section>
      <div class="effort-flow-clip animate-effort-flow" style="--effort-flow-width:240px;--effort-flow-duration:.8s"><span class="effort-flow-light-band"></span></div>`)}`)
    debuggerApi.attach('1.3')
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await debuggerApi.sendCommand('Performance.enable')
    const styles = () => window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('${labels}')).map(e => {
      const s = getComputedStyle(e); return { text:e.textContent, animation:s.animationName, color:s.color, display:s.display };
    })`) as Promise<Array<{ text: string; animation: string; color: string; display: string }>>
    const sample = async (name: string) => {
      await pause(1000)
      const counts: Counts = { Paint: 0, Layout: 0, UpdateLayoutTree: 0 }
      const collect = (_event: Electron.Event, method: string, params: { value?: Array<{ ph: string; name: string }> }) => {
        if (method !== 'Tracing.dataCollected') return
        for (const event of params.value ?? []) {
          if (event.ph === 'X' && Object.hasOwn(counts, event.name)) counts[event.name as keyof Counts]++
        }
      }
      debuggerApi.on('message', collect)
      const cpuBefore = app.getAppMetrics()
      await debuggerApi.sendCommand('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' })
      await pause(2000)
      const cpuAfter = app.getAppMetrics()
      const ended = new Promise<void>(resolve => {
        const done = (_event: Electron.Event, method: string) => {
          if (method !== 'Tracing.tracingComplete') return
          debuggerApi.off('message', done)
          resolve()
        }
        debuggerApi.on('message', done)
      })
      await debuggerApi.sendCommand('Tracing.end')
      await ended
      debuggerApi.off('message', collect)
      console.log(JSON.stringify({ name, counts, cpuSeconds: cpuAfter.map(point => {
        const before = cpuBefore.find(previous => previous.pid === point.pid)
        const end = point.cpu.cumulativeCPUUsage
        const start = before?.cpu.cumulativeCPUUsage
        return { type: point.type, seconds: end !== undefined && start !== undefined ? end - start : null }
      }) }))
      return counts
    }
    const currentStyles = await styles()
    assert.equal(currentStyles.length, 3)
    assert(currentStyles.every(style => style.animation !== 'none' && style.color !== 'rgba(0, 0, 0, 0)'))
    const current = await sample('current-status-and-effort')
    assert(current.Paint <= 4, `Unchanged status indicators repainted ${current.Paint} times`)
    assert(current.Layout <= 4, `Unchanged effort indicator laid out ${current.Layout} times`)
    // The moving highlight still traverses the entire selected track.
    assert(await window.webContents.executeJavaScript(`(() => {
      const band = document.querySelector('.effort-flow-light-band');
      const animation = band.getAnimations()[0];
      if (!animation) return false;
      animation.currentTime = 0;
      const start = band.getBoundingClientRect().left;
      animation.currentTime = 799;
      const end = band.getBoundingClientRect().left;
      return end - start > 270 && end - start < 281;
    })()`), 'Effort highlight must move from before the track to its far end')
    await window.webContents.executeJavaScript(`{ const style=document.createElement('style'); style.id='baseline'; style.textContent=${JSON.stringify(baseline)}; document.head.append(style); }`)
    const oldStyles = await styles()
    assert(oldStyles.every(style => style.animation === 'baseline-shimmer'))
    const historical = await sample('historical-gradient')
    assert(historical.Paint > 20, `Fixture did not reproduce gradient painting: ${historical.Paint}`)
    await window.webContents.executeJavaScript(`document.getElementById('baseline').remove()`)
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await pause(50)
    assert((await styles()).every(style => style.animation === 'none' && style.color !== 'rgba(0, 0, 0, 0)'))
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.effort-flow-light-band')).animationName`), 'none')
    const remainingAnimations = await window.webContents.executeJavaScript(`document.getAnimations().map(animation => ({
      target: animation.effect?.target?.className, state: animation.playState,
      keyframes: animation.effect?.getKeyframes()
    }))`) as unknown[]
    assert.deepEqual(remainingAnimations, [], `Reduced motion left animations active: ${JSON.stringify(remainingAnimations)}`)
    console.log(JSON.stringify({ reducedMotion: 'static-readable', current, historical }))
  } finally {
    if (debuggerApi.isAttached()) debuggerApi.detach()
    window.destroy()
  }
}

async function finish(code: number) {
  clearTimeout(deadline)
  try { rmSync(state, { recursive: true, force: true }) } catch (error) { console.error(error); code = 1 }
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify({ nativeExitCode: code, temporaryStateRemoved: !existsSync(state) })}\n`, () => resolve()))
  app.exit(code)
}
const deadline = setTimeout(() => { console.error('Idle rendering regression timed out'); void finish(1) }, 45_000)
void run().then(() => finish(0)).catch(error => { console.error(error); return finish(1) })
