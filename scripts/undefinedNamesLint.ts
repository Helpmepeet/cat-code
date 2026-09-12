#!/usr/bin/env bun
/**
 * Fails on any identifier that is used but never imported or declared.
 *
 * Root `tsc` is known-red (see CLAUDE.md §3), so the full error list is not a
 * gate. This narrow slice is: TS2304/TS2503 mean the name resolves to nothing,
 * and esbuild compiles a free identifier into a bundle-clean global reference,
 * so the build passes and the code throws `X is not defined` only once that
 * line runs. Every one of these is a latent crash, which is why the count is
 * held at zero rather than at a baseline.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export type UndefinedName = {
  column: number
  file: string
  line: number
  name: string
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error TS(?:2304|2503): Cannot find (?:name|namespace) '([^']+)'/
const SOURCE_DIAGNOSTIC = /^(.+)\(\d+,\d+\): error TS\d+:/

function isSourceDiagnosticOutput(output: string): boolean {
  let inDiagnostic = false
  return output.split(/\r?\n/).every(line => {
    if (!line.trim()) return true
    const diagnostic = line.match(SOURCE_DIAGNOSTIC)
    if (diagnostic) {
      if (diagnostic[1]!.endsWith('.json')) return false
      inDiagnostic = true
      return true
    }
    return inDiagnostic && /^[ \t]/.test(line)
  })
}

export function parseUndefinedNames(tscOutput: string): UndefinedName[] {
  const found: UndefinedName[] = []
  for (const rawLine of tscOutput.split('\n')) {
    const match = rawLine.match(DIAGNOSTIC)
    if (!match) continue
    found.push({
      column: Number(match[3]),
      file: match[1]!,
      line: Number(match[2]),
      name: match[4]!,
    })
  }
  return found
}

if (import.meta.main) {
  const repoRoot = resolve(process.argv[2] ?? process.cwd())
  const tsc = spawnSync(
    'bunx',
    ['tsc', '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const output = [tsc.stdout, tsc.stderr].filter(Boolean).join('\n')
  // Accept tsc's diagnostic exit statuses only when it actually checked source.
  const checkerFailed =
    tsc.error ||
    tsc.signal ||
    !isSourceDiagnosticOutput(tsc.stdout ?? '') ||
    !isSourceDiagnosticOutput(tsc.stderr ?? '') ||
    (tsc.status !== 0 &&
      ((tsc.status !== 1 && tsc.status !== 2) ||
        !/^.+\(\d+,\d+\): error TS\d+:/m.test(output)))
  const undefinedNames = parseUndefinedNames(output)
  if (checkerFailed) {
    const reason = tsc.error?.message ?? tsc.signal ?? `exit status ${tsc.status}`
    console.error(`undefined-name lint failed: TypeScript checker did not complete (${reason})`)
    if (output.trim()) console.error(output.trim())
    process.exitCode = 1
  } else if (undefinedNames.length > 0) {
    for (const { column, file, line, name } of undefinedNames) {
      console.error(`error: ${file}:${line}:${column} '${name}' is used but never imported or declared`)
    }
    console.error(`undefined-name lint failed: ${undefinedNames.length} name(s) will throw at runtime`)
    process.exitCode = 1
  } else {
    console.log('undefined-name lint passed: 0 undefined names')
  }
}
