import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'

const START_TIMEOUT_MS = 8000
const PROBE_TIMEOUT_MS = 250

/** Probe the daemon transport without replaying a GUI action or changing its cache. */
async function isReady(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath)
    let response = ''
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    socket.once('error', () => finish(false))
    socket.once('connect', () => socket.write('{"method":"list"}\n'))
    socket.on('data', chunk => {
      response += chunk.toString()
      if (response.length > 1024 * 1024) return finish(false)
      const newline = response.indexOf('\n')
      if (newline < 0) return
      try {
        finish(JSON.parse(response.slice(0, newline)).ok === true)
      } catch {
        finish(false)
      }
    })
    socket.once('end', () => finish(false))
  })
}

/**
 * The MCP stdio proxy can stay connected after another run stops its daemon.
 * Start through the CLI's normal LaunchServices relaunch path before dispatch,
 * rather than retrying a tool whose effects may already have happened.
 */
export async function acquireCuaDriverDaemon(
  binary: string,
  signal: AbortSignal,
): Promise<void> {
  const socketPath = join(
    process.env.HOME || homedir(),
    'Library', 'Caches', 'cua-driver', 'cua-driver.sock',
  )
  signal.throwIfAborted()
  if (await isReady(socketPath)) return
  signal.throwIfAborted()
  const child = spawn(binary, ['serve'], { stdio: 'ignore' })
  let startError: Error | undefined
  child.once('error', error => { startError = error })
  child.unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (startError) throw startError
      if (await isReady(socketPath)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Computer use could not start its daemon. Check CuaDriver permissions and try again.')
  } catch (error) {
    // Only this invocation's child is ours. A normal relaunch may have already
    // exited; run cleanup still stops the shared LaunchServices daemon.
    // A ready direct child owns a socket and needs graceful run cleanup.
    // Killing it here would leave a stale socket and bypass the queued stop.
    if (!await isReady(socketPath)) child.kill()
    throw error
  }
}
