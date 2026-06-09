import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBrowser as defaultOpenBrowser } from '../utils/browser.js'

export type LaunchWebAppDevServerOptions = {
  webDir: string
  token: string
  port?: number
  logPath?: string
  logStream?: Pick<WriteStream, 'write' | 'end'>
  spawnProcess?: typeof spawn
  openBrowser?: (url: string) => Promise<unknown> | unknown
  registerParentExitHook?: (hook: () => void) => () => void
}

// The global SIGINT handler calls process.exit(0) directly, which skips the
// caller's async cleanup (startRuntimeBackedWebMode's finally never runs while
// it is parked on waitForever). Without a synchronous 'exit' hook the Vite
// child outlives the session as an orphan.
const defaultRegisterParentExitHook = (hook: () => void): (() => void) => {
  process.on('exit', hook)
  return () => {
    process.off('exit', hook)
  }
}

export type LaunchedWebAppDevServer = {
  url: string
  logPath: string
  child: ChildProcess
  stop(): Promise<void>
}

export async function launchWebAppDevServer({
  webDir,
  token,
  port = 5173,
  logPath = join(tmpdir(), 'cat-code-web-dev.log'),
  logStream = createWriteStream(logPath, { flags: 'a' }),
  spawnProcess = spawn,
  openBrowser = defaultOpenBrowser,
  registerParentExitHook = defaultRegisterParentExitHook,
}: LaunchWebAppDevServerOptions): Promise<LaunchedWebAppDevServer> {
  const url = `http://127.0.0.1:${port}`
  const viteLocalRootUrlPattern = new RegExp(
    `(?:^|\\s)http://127\\.0\\.0\\.1:${port}/(?=\\s|$)`,
  )
  const redactToken = (text: string) =>
    token.length > 0 ? text.split(token).join('[REDACTED]') : text
  const redactionTailLength = Math.max(token.length - 1, 0)
  const createLogRedactor = () => ({ pending: '' })
  const writeStreamLog = (
    redactor: ReturnType<typeof createLogRedactor>,
    text: string,
  ) => {
    if (token.length === 0) {
      logStream.write(text)
      return
    }
    if (redactionTailLength === 0) {
      logStream.write(redactToken(text))
      return
    }

    const combined = redactor.pending + text
    let writeEnd = Math.max(0, combined.length - redactionTailLength)
    let tokenIndex = combined.indexOf(token)
    while (tokenIndex !== -1) {
      const tokenEnd = tokenIndex + token.length
      if (tokenIndex < writeEnd && tokenEnd > writeEnd) {
        writeEnd = tokenIndex
      }
      tokenIndex = combined.indexOf(token, tokenIndex + 1)
    }

    const writable = combined.slice(0, writeEnd)
    if (writable.length > 0) {
      logStream.write(redactToken(writable))
    }
    redactor.pending = combined.slice(writeEnd)
  }
  const flushStreamLog = (redactor: ReturnType<typeof createLogRedactor>) => {
    if (redactor.pending.length === 0) return
    logStream.write(redactToken(redactor.pending))
    redactor.pending = ''
  }
  const appendOutputBuffer = (buffer: string, text: string) => {
    const nextBuffer = buffer + text
    return nextBuffer.length > 4096 ? nextBuffer.slice(-4096) : nextBuffer
  }
  let opened = false
  let stopped = false
  let logEnded = false
  let stdoutBuffer = ''
  let stderrBuffer = ''
  const logRedactor = createLogRedactor()
  const writeLog = (text: string) => {
    writeStreamLog(logRedactor, text)
  }
  const flushLog = () => {
    flushStreamLog(logRedactor)
  }
  const child = spawnProcess(
    'bun',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: webDir,
      env: {
        ...process.env,
        VITE_CAT_CODE_WS_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const unregisterParentExitHook = registerParentExitHook(() => {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  })

  const maybeOpen = (text: string) => {
    if (opened || !viteLocalRootUrlPattern.test(text)) return
    opened = true
    void Promise.resolve(openBrowser(url)).catch(error => {
      writeLog(
        `Failed to open browser: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
  }

  child.stdout?.on('data', chunk => {
    const text = String(chunk)
    writeLog(text)
    stdoutBuffer = appendOutputBuffer(stdoutBuffer, text)
    maybeOpen(stdoutBuffer)
  })

  child.stderr?.on('data', chunk => {
    const text = String(chunk)
    writeLog(text)
    stderrBuffer = appendOutputBuffer(stderrBuffer, text)
    maybeOpen(stderrBuffer)
  })

  child.on('error', error => {
    writeLog(
      `Failed to start web dev server: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    flushLog()
  })

  const endLogStream = () => {
    if (logEnded) return
    logEnded = true
    flushLog()
    logStream.end()
  }

  child.on('exit', (code, signal) => {
    unregisterParentExitHook()
    if (stopped || code === 0 || signal === 'SIGTERM') {
      endLogStream()
      return
    }
    writeLog(
      `Web dev server exited unexpectedly (${signal ?? code ?? 'unknown'})\n`,
    )
    endLogStream()
  })

  return {
    url,
    logPath,
    child,
    async stop() {
      if (stopped) return
      stopped = true
      unregisterParentExitHook()
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      endLogStream()
    },
  }
}
