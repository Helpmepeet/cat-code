import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseUndefinedNames } from './undefinedNamesLint.js'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function runLint(checker?: { stdout?: string; stderr?: string; status: number }) {
  const root = mkdtempSync(join(tmpdir(), 'undefined-name-lint-'))
  fixtureRoots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  if (checker) {
    writeFileSync(
      join(bin, 'bunx'),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(checker.stdout ?? '')});\nprocess.stderr.write(${JSON.stringify(checker.stderr ?? '')});\nprocess.exit(${checker.status});\n`,
      { mode: 0o700 },
    )
  }
  const result = Bun.spawnSync(
    [process.execPath, fileURLToPath(new URL('./undefinedNamesLint.ts', import.meta.url)), root],
    { env: { ...process.env, PATH: bin }, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    status: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  }
}

describe('undefined-name lint command', () => {
  test('accepts a successful checker and the known-red source diagnostics', () => {
    for (const checker of [
      { status: 0 },
      { status: 2, stdout: "src/example.ts(1,1): error TS2345: Argument of type 'x' is not assignable to parameter of type 'y'.\n" },
      { status: 1, stdout: "src/example.ts(1,1): error TS2322: Type 'x' is not assignable.\n  Types of property 'value' are incompatible.\n    Type 'string' is not assignable to type 'number'.\n" },
    ]) {
      const result = runLint(checker)
      expect(result.status).toBe(0)
      expect(result.output).toContain('undefined-name lint passed')
    }
  })

  test('fails when the checker executable cannot start', () => {
    const result = runLint()
    expect(result.status).not.toBe(0)
    expect(result.output).not.toContain('undefined-name lint passed')
  })

  test('fails on checker configuration errors', () => {
    for (const stdout of [
      "error TS5058: The specified path does not exist: 'tsconfig.json'.\n",
      "tsconfig.json(2,1): error TS1005: '}' expected.\n",
    ]) {
      const result = runLint({ status: 1, stdout })
      expect(result.status).not.toBe(0)
      expect(result.output).toContain(stdout.trim())
      expect(result.output).not.toContain('undefined-name lint passed')
    }
  })

  test('does not treat a crash after source diagnostics as a completed check', () => {
    const result = runLint({ status: 137, stdout: 'src/example.ts(1,1): error TS2345: Invalid argument.\n' })
    expect(result.status).not.toBe(0)
    expect(result.output).not.toContain('undefined-name lint passed')
  })

  test('rejects infrastructure output even after valid source diagnostics', () => {
    const diagnostic = 'src/example.ts(1,1): error TS2345: Invalid argument.\n'
    for (const checker of [
      { status: 1, stdout: diagnostic, stderr: 'TypeError: checker crashed\n    at checker.ts:1:1\n' },
      { status: 1, stdout: `${diagnostic}TypeError: checker crashed\n    at checker.ts:1:1\n` },
    ]) {
      const result = runLint(checker)
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('TypeError: checker crashed')
      expect(result.output).not.toContain('undefined-name lint passed')
    }
  })

  test('fails on undefined names reported through stderr', () => {
    const result = runLint({ status: 2, stderr: "src/example.ts(1,1): error TS2304: Cannot find name 'missing'.\n" })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain("'missing' is used but never imported or declared")
  })
})

describe('parseUndefinedNames', () => {
  test('catches a value used but never imported', () => {
    // The shape of the real regression: QueryEngine called toSDKRetryError
    // without importing it, so every retryable API error threw instead of
    // emitting an api_retry frame.
    const found = parseUndefinedNames(
      "src/QueryEngine.ts(1105,22): error TS2304: Cannot find name 'toSDKRetryError'.",
    )
    expect(found).toEqual([
      { column: 22, file: 'src/QueryEngine.ts', line: 1105, name: 'toSDKRetryError' },
    ])
  })

  test('catches a missing type namespace', () => {
    const found = parseUndefinedNames(
      "src/Tool.ts(107,12): error TS2503: Cannot find namespace 'React'.",
    )
    expect(found.map(n => n.name)).toEqual(['React'])
  })

  test('keeps a did-you-mean suffix out of the reported name', () => {
    const found = parseUndefinedNames(
      "src/utils/effort.ts(382,20): error TS2304: Cannot find name 'getAntModelOverrideConfig'. Did you mean 'getAntModelOverrideSection'?",
    )
    expect(found.map(n => n.name)).toEqual(['getAntModelOverrideConfig'])
  })

  test('ignores the known-red baseline diagnostics that are not undefined names', () => {
    const found = parseUndefinedNames(
      [
        "src/QueryEngine.ts(310,37): error TS2345: Argument of type 'x' is not assignable to parameter of type 'y'.",
        "src/QueryEngine.ts(824,60): error TS2339: Property 'preservedMessages' does not exist on type 'unknown'.",
        'Found 1879 errors in 214 files.',
      ].join('\n'),
    )
    expect(found).toEqual([])
  })

  test('reports every occurrence across a multi-file run', () => {
    const found = parseUndefinedNames(
      [
        "src/commands/insights.ts(1591,3): error TS2304: Cannot find name 'z'.",
        "src/commands/insights.ts(1592,22): error TS2304: Cannot find name 'z'.",
        "src/utils/thinking.ts(96,7): error TS2304: Cannot find name 'resolveAntModel'.",
      ].join('\n'),
    )
    expect(found).toHaveLength(3)
    expect(found.map(n => n.file)).toEqual([
      'src/commands/insights.ts',
      'src/commands/insights.ts',
      'src/utils/thinking.ts',
    ])
  })

  test('returns nothing for empty output', () => {
    expect(parseUndefinedNames('')).toEqual([])
  })
})
