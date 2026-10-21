import { basename } from 'node:path'
import { totalmem } from 'node:os'
import { parse } from 'shell-quote'
import { splitCommandWithOperators } from './bash/commands.js'

export type TestCommandLimits = { timeoutMs: number; maxMemoryBytes: number }

function isTestArgv(argv: string[]): boolean {
  let i = 0
  while (/^[A-Za-z_]\w*=/.test(argv[i] ?? '')) i++
  if (basename(argv[i] ?? '') === 'env') {
    i++
    while (/^[A-Za-z_]\w*=/.test(argv[i] ?? '')) i++
  }
  if (!['bun', 'npm', 'pnpm', 'yarn'].includes(basename(argv[i++] ?? ''))) return false
  // Only finite invocations. Test watchers retain their ordinary service life.
  if (argv.slice(i).some(arg => /^(--watch\w*(?:=.*)?|--hot|test:watch(?::.*)?)$/.test(arg))) return false
  while (i < argv.length) {
    const arg = argv[i++]!
    if (arg === '--cwd' || arg === '--prefix' || arg === '-C') { i++; continue }
    if (arg.startsWith('--cwd=') || arg.startsWith('--prefix=')) continue
    if (arg === 'run' || arg === '--') continue
    return /^test(?::[^\s]+)?$/.test(arg)
  }
  return false
}

/** Resource policy, not a permission parser. Quoted mentions are not commands. */
export function getTestCommandLimits(command: string): TestCommandLimits | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined
  let recognized = false
  let otherWork = false
  try {
    let argv: string[] = []
    let redirect = false
    const classify = (): void => {
      if (!argv.length) return
      if (isTestArgv(argv)) recognized = true
      // Do not put a following server/build under a previous test's deadline.
      // Only inert shell setup and output may share the guarded invocation.
      else if (!['cd', 'pwd', 'echo', 'printf', 'true'].includes(argv[0]!)) otherWork = true
    }
    for (const part of splitCommandWithOperators(command)) {
      if (['&&', '||', '|', '|&', ';', '&', '\n'].includes(part)) {
        classify()
        argv = []
        redirect = false
        continue
      }
      if (/^[<>]/.test(part)) { redirect = true; continue }
      for (const entry of parse(part, name => `$${name}`)) {
        if (redirect) { redirect = false; continue }
        if (typeof entry === 'string') argv.push(entry)
      }
    }
    classify()
  } catch { return undefined }
  if (!recognized || otherWork) return undefined
  const positive = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    timeoutMs: Math.min(2 ** 31 - 1, positive(process.env.CAT_CODE_TEST_TIMEOUT_MS, 30 * 60_000)),
    maxMemoryBytes: positive(process.env.CAT_CODE_TEST_MAX_MEMORY_MB,
      Math.floor(Math.min(4 * 1024 ** 3, totalmem() / 4) / 1024 ** 2)) * 1024 ** 2,
  }
}
