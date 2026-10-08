// Isolated Chromium layout gate. No product main, preload, engine or saved state
// is loaded. Launching this runner still requires the task's Electron permission.
import { app, BrowserWindow, session } from 'electron'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { readSyntheticWheelRequest } from './transcriptScrollWheelInput.js'

const page = process.argv[2]
const state = mkdtempSync(join(tmpdir(), 'catcode-scroll-regression-'))
app.setPath('userData', state)
app.setPath('sessionData', join(state, 'session'))
app.setPath('crashDumps', join(state, 'crash-dumps'))
app.setAppLogsPath(join(state, 'logs'))
// Keep shutdown under this runner's control, including on platforms that quit
// automatically when the last window closes.
app.on('window-all-closed', () => {})
async function print(value: unknown): Promise<void> {
  await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, () => resolve()))
}
async function finish(code: number): Promise<void> {
  try {
    rmSync(state, { recursive: true, force: true })
  } catch (error) {
    console.error(error)
    code = 1
  }
  await print({ nativeExitCode: code, pid: process.pid, temporaryState: state, temporaryStateRemoved: !existsSync(state) })
  // app.quit() selects Electron's own exit code; process.exitCode does not
  // reliably override it. Cleanup and stdout drainage precede this explicit exit.
  app.exit(code)
}
async function run(page: string | undefined): Promise<number> {
  await app.whenReady()
  app.dock?.hide()
  if (!page) throw new Error('Pass the built transcript-scroll-fixture.html path')
  const isolated = session.fromPartition('scroll-regression')
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') })
  })
  const window = new BrowserWindow({
    show: false, width: 1_100, height: 950,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  let timeout: ReturnType<typeof setTimeout> | undefined
  let inputPoll: ReturnType<typeof setInterval> | undefined
  try {
    await window.loadFile(resolve(page))
    const nativeAnchoring = process.argv.includes('--native-anchor')
    const inputMode = process.argv.includes('--script-input') ? 'script' : 'wheel'
    let failInput: ((error: unknown) => void) | null = null
    const inputFailure = new Promise<never>((_resolve, reject) => { failInput = reject })
    if (inputMode === 'wheel') {
      // CDP input reaches Chromium's wheel pipeline without showing/focusing a
      // native window. DOM dispatchEvent and JS scrollTop are not substitutes.
      window.webContents.debugger.attach('1.3')
      let busy = false
      let previousId = 0
      inputPoll = setInterval(async () => {
        if (busy) return
        busy = true
        try {
          const value: unknown = await window.webContents.executeJavaScript(
            'window.transcriptScrollRegression.takeWheelRequest()',
          )
          if (value === null) return
          const request = readSyntheticWheelRequest(value)
          if (!request || request.id <= previousId) throw new Error(`Invalid synthetic wheel request: ${JSON.stringify(value)}`)
          previousId = request.id
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: request.x, y: request.y, deltaX: 0, deltaY: request.deltaY,
          })
          await window.webContents.executeJavaScript(
            `window.transcriptScrollRegression.acknowledgeWheelRequest(${request.id})`,
          )
        } catch (error) {
          clearInterval(inputPoll)
          failInput?.(error)
        } finally {
          busy = false
        }
      }, 16)
    }
    const result = await Promise.race([
      window.webContents.executeJavaScript(
        `window.transcriptScrollRegression.run({nativeAnchoring:${nativeAnchoring},inputMode:'${inputMode}'})`,
      ),
      inputFailure,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Synthetic scroll regression exceeded 90 seconds')), 90_000)
      }),
    ])
    await print(result)
    return 0
  } catch (error) {
    console.error(error)
    try {
      await print(await window.webContents.executeJavaScript(
        'window.transcriptScrollRegression?.diagnostics ?? null',
      ))
    } catch (diagnosticError) {
      console.error(diagnosticError)
    }
    return 1
  } finally {
    clearInterval(inputPoll)
    clearTimeout(timeout)
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
  }
}
void run(page).then(finish).catch(async error => {
  console.error(error)
  await finish(1)
})
