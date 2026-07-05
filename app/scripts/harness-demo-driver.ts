import { app, BrowserWindow } from 'electron'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DebugStateFile } from '../shared/debugState.js'

const cwd = mustEnv('CATCODE_HARNESS_DEMO_CWD')
const configHome = mustEnv('CLAUDE_CONFIG_DIR')
const exportPath = join(configHome, 'desktop', 'debug', 'state.json')

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void run(window)
  })
})

async function run(window: BrowserWindow): Promise<void> {
  try {
    const initial = await waitForExport(state => {
      const matches = state.sessions.filter(
        session => session.cwd === cwd && session.status === 'ready',
      )
      return matches.length >= 1
    })
    assertMode(exportPath, 0o600, 'debug export file')
    if (window.getTitle() !== 'Cat Code Dev') {
      throw new Error(`expected Cat Code Dev title, got ${JSON.stringify(window.getTitle())}`)
    }

    const createResult = await window.webContents.executeJavaScript(`(async () => {
      const token = await window.catcode.pickDirectory()
      if (!token) return { ok: false, error: 'no token' }
      return await window.catcode.createSession({ cwdToken: token })
    })()`)
    if (!createResult?.ok) {
      throw new Error(`createSession failed: ${JSON.stringify(createResult)}`)
    }

    const final = await waitForExport(state => {
      const matches = state.sessions.filter(
        session =>
          session.cwd === cwd &&
          session.status === 'ready' &&
          typeof session.enginePid === 'number',
      )
      return matches.length >= 2 && new Set(matches.map(s => s.enginePid)).size >= 2
    })
    const sessions = final.sessions.filter(session => session.cwd === cwd)
    process.stdout.write(`[harness-demo] initial sessions=${initial.sessions.length}\n`)
    process.stdout.write(`[harness-demo] final same-cwd sessions=${sessions.length}\n`)
    process.stdout.write(
      `[harness-demo] pids=${sessions.map(session => session.enginePid).join(',')}\n`,
    )
    process.stdout.write('[harness-demo] passed\n')
    exitElectron(0)
  } catch (error) {
    process.stderr.write(
      `[harness-demo] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    exitElectron(1)
  }
}

async function waitForExport(predicate: (state: DebugStateFile) => boolean): Promise<DebugStateFile> {
  const deadline = Date.now() + 30_000
  let last = 'not read'
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(exportPath, 'utf8')) as DebugStateFile
      if (predicate(state)) return state
      last = JSON.stringify(state.sessions.map(session => ({
        id: session.appSessionId,
        cwd: session.cwd,
        status: session.status,
        pid: session.enginePid,
      })))
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for debug export predicate (${last})`)
}

function assertMode(path: string, expected: number, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`)
  const actual = statSync(path).mode & 0o777
  if (actual !== expected) {
    throw new Error(`${label} mode ${actual.toString(8)} !== ${expected.toString(8)}`)
  }
}

function mustEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function exitElectron(code: number): void {
  app.exit(code)
  setTimeout(() => process.exit(code), 250).unref()
}
