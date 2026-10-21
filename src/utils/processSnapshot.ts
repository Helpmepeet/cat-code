import { execFile } from 'node:child_process'

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
