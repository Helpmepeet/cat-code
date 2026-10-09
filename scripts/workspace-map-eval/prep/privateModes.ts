import { chmodSync, cpSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function securePrivateTree(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing linked private input: ${path}`)
  if (stat.isDirectory()) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) securePrivateTree(join(path, name))
  } else if (stat.isFile()) chmodSync(path, stat.mode & 0o111 ? 0o700 : 0o600)
}

export function copyPrivateSeed(seed: string, home: string): void {
  cpSync(seed, home, { recursive: true, dereference: false })
  securePrivateTree(home)
}
