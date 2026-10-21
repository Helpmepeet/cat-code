import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/** A fresh parent chain, never inferred from command names or saved ps output. */
export async function readProcessParents(): Promise<Map<number, number>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/bin/ps', ['-axo', 'pid=,ppid='],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout),
    )
  })
  const parents = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

export function isProcessDescendant(
  pid: number,
  root: number,
  parents: ReadonlyMap<number, number>,
): boolean {
  const seen = new Set<number>()
  while (pid > 1 && !seen.has(pid)) {
    if (pid === root) return parents.has(root)
    seen.add(pid)
    pid = parents.get(pid) ?? 0
  }
  return false
}

let darwinUsage: ((pid: number, flavor: number, buffer: Buffer) => number) | undefined

/** Includes compressed/swapped allocations: RSS alone missed the 105 GiB test. */
export async function readProcessMemoryBytes(pid: number): Promise<number> {
  if (process.platform === 'darwin') {
    if (!darwinUsage) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi')
      const lib = dlopen('/usr/lib/libproc.dylib', {
        proc_pid_rusage: { args: ['int', 'int', 'ptr'], returns: 'int' },
      })
      darwinUsage = (target, flavor, buffer) =>
        lib.symbols.proc_pid_rusage(target, flavor, ptr(buffer))
    }
    // sys/resource.h: rusage_info_v0 is UUID[16] followed by ten uint64_t
    // fields; ri_phys_footprint is the eighth (offset 72).
    const usage = Buffer.alloc(96)
    if (darwinUsage(pid, 0, usage) !== 0) throw new Error(`Cannot measure process ${pid}`)
    return Number(usage.readBigUInt64LE(72))
  }
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    if (/^State:\s+Z/m.test(status)) return 0
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status)
    const swap = /^VmSwap:\s+(\d+) kB$/m.exec(status)
    if (!rss || !swap) throw new Error(`Cannot measure process ${pid}`)
    return (Number(rss[1]) + Number(swap[1])) * 1024
  }
  throw new Error('Process memory measurement is unavailable on this platform')
}
