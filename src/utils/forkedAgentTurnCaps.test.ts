import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ABSENCE guard: no `runForkedAgent` call site may omit `maxTurns`.
 *
 * This is a source scan, and a source scan cannot prove a cap is sane or that
 * it is reached at runtime — `forkedAgent.test.ts` covers the forwarding, and
 * only a live run covers the value. What it CAN prove is the thing no other
 * layer here can: that every call site sets the option at all.
 *
 * Nothing else catches an omission. Making `maxTurns` required on
 * ForkedAgentParams would push the check to tsc, but root `bun run typecheck`
 * is known-red and is not a gate, and the build does not typecheck — so a new
 * fork that forgets the cap would ship silently.
 *
 * Why it matters: these forks deny tool calls via `canUseTool`, a denial
 * returns a tool_result and re-enters the query loop rather than ending it,
 * and `query()` bounds turns ONLY when `maxTurns` is set. An uncapped fork
 * that keeps reaching for tools loops with no ceiling, burning model usage on
 * a path the user never sees. `prompt_suggestion` runs at every turn end.
 */

const SRC = new URL('..', import.meta.url).pathname

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'vendor') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/**
 * Slice each `runForkedAgent({ ... })` argument object out of `source` by
 * brace-matching from the opening `{`. Throws rather than returning a partial
 * slice, so a call shape this cannot parse fails loudly instead of silently
 * scanning an empty string that passes every `not`.
 */
function forkCallArguments(source: string, file: string): string[] {
  const calls: string[] = []
  const needle = 'runForkedAgent({'
  let from = 0
  for (;;) {
    const start = source.indexOf(needle, from)
    if (start < 0) return calls
    let depth = 0
    let i = start + needle.length - 1
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) {
      throw new Error(`unbalanced runForkedAgent({...}) in ${file}`)
    }
    calls.push(source.slice(start, i + 1))
    from = i + 1
  }
}

test('every runForkedAgent call site sets maxTurns', () => {
  const uncapped: string[] = []
  let callSites = 0

  for (const file of sourceFiles(SRC)) {
    // The defining module's own signature and JSDoc example are not call sites.
    if (file.endsWith('/utils/forkedAgent.ts')) continue
    const source = readFileSync(file, 'utf8')
    if (!source.includes('runForkedAgent({')) continue
    for (const call of forkCallArguments(source, file)) {
      callSites += 1
      if (!/\bmaxTurns:/.test(call)) {
        uncapped.push(file.slice(SRC.length))
      }
    }
  }

  // Guards the scan itself: a rename that makes `forkCallArguments` match
  // nothing would otherwise leave this test green and enforcing nothing.
  expect(callSites).toBeGreaterThanOrEqual(9)
  expect(uncapped).toEqual([])
})
