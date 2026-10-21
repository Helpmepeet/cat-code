import { spawn } from 'node:child_process'
import { dlopen, ptr } from 'bun:ffi'
import { isProcessDescendant, readProcessParents } from '../src/utils/processSnapshot.js'

// Explicit macOS test supervisor. No shell parsing or engine command policy.
const args = process.argv.slice(2)
let timeoutMs = 120_000
let memoryMb = 1024
while (args[0] && args[0] !== '--' && args[0].startsWith('--')) {
  const flag = args.shift()
  const value = Number(args.shift())
  if (!['--timeout-ms', '--memory-mb'].includes(flag!) ||
      !Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1) {
    throw new Error('Use --timeout-ms N and --memory-mb N with positive integers')
  }
  if (flag === '--timeout-ms') timeoutMs = value
  else memoryMb = value
}
if (args[0] === '--') args.shift()
if (!args.length) throw new Error('Usage: bun run test:bounded [--timeout-ms N] [--memory-mb N] -- <command> [args...]')
if (process.platform !== 'darwin') throw new Error('test:bounded currently supports macOS only')

// rusage_info_v0: UUID[16], then ten uint64_t fields. The eighth is physical
// footprint, which includes compressed/swapped memory that RSS misses.
const lib = dlopen('/usr/lib/libproc.dylib', {
  proc_pid_rusage: { args: ['int', 'int', 'ptr'], returns: 'int' },
})
function memoryBytes(pid: number): number {
  const usage = Buffer.alloc(96)
  if (lib.symbols.proc_pid_rusage(pid, 0, ptr(usage)) !== 0) {
    throw new Error(`Cannot measure process ${pid}`)
  }
  return Number(usage.readBigUInt64LE(72))
}

// Share the caller's group so ordinary Bash task cleanup still reaches the
// test. Budget enforcement also checks descendants that detached themselves.
const child = spawn(args[0]!, args.slice(1), { stdio: 'inherit' })
let stopping = false
async function stop(reason: string): Promise<void> {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return
  stopping = true
  console.error(`test:bounded: ${reason}`)
  const parents = await readProcessParents().catch(() => undefined)
  if (child.exitCode !== null || child.signalCode !== null) return
  if (child.pid && parents?.has(child.pid)) {
    for (const pid of parents.keys()) {
      if (pid !== child.pid && isProcessDescendant(pid, child.pid, parents)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
    }
  }
  child.kill('SIGKILL')
}

const onInterrupt = (): void => { void stop('interrupted') }
const onExit = (): void => { child.kill('SIGKILL') }
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onInterrupt)
process.once('exit', onExit)
const deadline = setTimeout(() => { void stop(`exceeded ${timeoutMs} ms execution limit`) }, timeoutMs)
let reading = false
const poller = setInterval(() => {
  if (reading || stopping) return
  reading = true
  void (async () => {
    try {
      const root = child.pid
      if (!root || child.exitCode !== null || child.signalCode !== null) return
      const parents = await readProcessParents()
      if (!parents.has(root)) return
      let bytes = 0
      for (const pid of parents.keys()) {
        if (!isProcessDescendant(pid, root, parents)) continue
        try { bytes += memoryBytes(pid) }
        catch (error) {
          try { process.kill(pid, 0) }
          catch (gone) {
            if ((gone as NodeJS.ErrnoException).code === 'ESRCH') continue
          }
          throw error
        }
      }
      if (bytes > memoryMb * 1024 ** 2) await stop(`exceeded ${memoryMb} MiB memory limit`)
    } catch {
      await stop('could not monitor process memory')
    } finally { reading = false }
  })()
}, 100)

try {
  process.exitCode = await new Promise<number>(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1) })
    child.once('exit', (code, signal) => resolve(stopping ? 137 : code ?? (signal === 'SIGTERM' ? 143 : 137)))
  })
} finally {
  clearTimeout(deadline)
  clearInterval(poller)
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onInterrupt)
  process.removeListener('exit', onExit)
}
