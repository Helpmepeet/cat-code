import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export function attemptPath(requested: string): string {
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 })
  let candidate = requested
  for (;;) {
    try {
      mkdirSync(candidate, { mode: 0o700 })
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      candidate = `${requested}.attempt-${randomUUID()}`
    }
  }
}
