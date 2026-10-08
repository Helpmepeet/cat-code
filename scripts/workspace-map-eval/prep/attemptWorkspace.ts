import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { attemptPath } from './attemptPath.ts'

export type AttemptWorkspace = {
  out: string
  stage: string
  cwd: string
  setScratch(path: string): void
  complete(): void
}

export function createAttemptWorkspace(
  requestedOut: string,
  stage: string,
  copy: string,
  registerExit: (listener: () => void) => void = listener => process.on('exit', listener),
): AttemptWorkspace {
  const out = attemptPath(requestedOut)
  const cwd = join(stage, 'cat-code')
  let complete = false
  let scratch = ''
  const record = (state: string) => {
    writeFileSync(join(out, 'stage.json'), JSON.stringify({ stage, cwd, copy, scratch: scratch || undefined, state }, null, 1))
  }
  writeFileSync(join(out, 'attempt.json'), JSON.stringify({ stage, cwd, copy, state: 'starting' }, null, 1))
  registerExit(() => {
    try { record(complete ? 'completed' : 'failed') } catch {}
  })
  mkdirSync(dirname(stage), { recursive: true, mode: 0o700 })
  mkdirSync(stage, { mode: 0o700 })
  cpSync(join(copy, 'cat-code'), cwd, { recursive: true, dereference: false, force: false, errorOnExist: true })
  record('running')
  return {
    out,
    stage,
    cwd,
    setScratch(path) {
      scratch = path
      record('running')
    },
    complete() {
      complete = true
      record('completed')
    },
  }
}
