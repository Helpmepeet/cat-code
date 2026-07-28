import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Repo-wide enforcement of CLAUDE.md §7 "Never render engineering notes".
 *
 * Per-file assertions did not hold this line: the same "Waiting for the engine's
 * X snapshot…" / "does not use prototype fixtures. It fills once the sidecar…"
 * copy reached EIGHT surfaces, each guarded only if someone remembered to add a
 * check. This is the §7 analogue of `fastRefreshBoundaries.test.ts`: one sweep
 * over every renderer module, so a ninth instance fails here instead of shipping.
 *
 * Precision matters more than reach. Code comments are explicitly exempt under
 * §7, and identifiers/frame kinds like `'accounts.snapshot'` are not user text,
 * so the scan looks only at strings that plausibly READ as prose: JSX text nodes
 * and string literals containing a space. That is why `frame.kind ===
 * 'accounts.snapshot'` passes while `desc="…workspace-trust snapshot…"` fails.
 *
 * To allow a genuine exception, put `§7-ok` in a comment on the same line.
 *
 * KNOWN LIMIT: a word list catches the mechanical leak (naming a frame, a
 * process, or a fixture) but not the judgment-level half of §7 — copy that
 * explains why we have not built something ("deferred until a safe writer is
 * wired") reads perfectly clean here. That still needs review; this test only
 * guarantees the recurring, mechanical class cannot come back.
 */

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Internal vocabulary that must never reach a user. Each entry is here because
 * it actually shipped on a surface, not on suspicion.
 */
const BANNED = [
  'sidecar',
  'snapshot',
  'prototype',
  'read seam',
  'write allowlist',
  'registry row',
  'engine config',
  "engine's",
]

/**
 * Deliberately NOT banned: "redacted". It reads as internal vocabulary in our
 * copy, but it also has a legitimate user-facing meaning the transcript relies
 * on (thinking content redacted by the model provider), so it is not a reliable
 * signal on its own. Every real violation found so far also tripped one of the
 * terms above.
 */

/**
 * Strip line + block comments; §7 exempts comments from this rule entirely.
 * Block comments are replaced newline-for-newline so reported line numbers stay
 * true to the original file.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * Candidate user-visible strings: JSX text nodes plus quoted literals that read
 * as prose (a space rules out identifiers, frame kinds, import paths, and props).
 */
type Candidate = { index: number; text: string }

/**
 * Candidate user-visible strings, scanned over the WHOLE file rather than
 * line-by-line: JSX text nodes routinely wrap across lines
 * (`<span\n  className=…>\n  Read-only snapshot\n</span>`), and a per-line scan
 * silently misses every one of them.
 *
 * Quoted literals are included only when they read as prose (a space rules out
 * identifiers, frame kinds, import paths, and enum values).
 */
function candidateStrings(source: string): Candidate[] {
  const out: Candidate[] = []

  // JSX text nodes, scanned whole-file so wrapped ones are seen. `>`…`<` also
  // spans ordinary code, so the capture must READ as prose: any of `=;(){}|`
  // means we caught an expression, not something a user reads.
  for (const match of source.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1]!.trim()
    if (!text || /[=;(){}|]/.test(text)) continue
    if (!/[a-z]{2}/i.test(text)) continue
    out.push({ index: match.index! + 1, text })
  }

  // Quoted literals stay LINE-scoped: prose containing an apostrophe ("engine's")
  // otherwise opens a bogus literal that runs to the next quote anywhere in the
  // file, swallowing code and reporting nonsense.
  let offset = 0
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      // Drop `${…}` bodies: identifiers, not words a user reads.
      // `${snapshot.readyCount} of ${snapshot.poolCount} ready` renders "1 of 2 ready".
      const text = match[2]!.replace(/\$\{[^}]*\}/g, ' ')
      if (text.includes(' ')) out.push({ index: offset + match.index!, text })
    }
    offset += line.length + 1
  }
  return out
}

function offendingLines(source: string): string[] {
  const hits: string[] = []
  const lines = source.split('\n')
  const stripped = stripComments(source)
  for (const { index, text } of candidateStrings(stripped)) {
    const startLine = stripped.slice(0, index).split('\n').length
    const endLine = startLine + text.split('\n').length - 1
    // The escape hatch may sit on any line the candidate spans.
    const exempt = lines
      .slice(startLine - 1, endLine)
      .some(line => line.includes('§7-ok'))
    if (exempt) continue
    for (const term of BANNED) {
      // Word-boundary so "snapshot" flags prose but "snapshotRef" does not.
      const pattern = new RegExp(`(^|[^a-zA-Z])${term}(s\\b|\\b)`, 'i')
      if (pattern.test(text)) {
        hits.push(`${startLine}: ${text.replace(/\s+/g, ' ').trim().slice(0, 90)}`)
        break
      }
    }
  }
  return hits
}

test('renderer surfaces never render internal vocabulary at the user', () => {
  const failures: string[] = []
  const files = readdirSync(here)
    .filter(
      file =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        // Fixture modules carry SIMULATED user/assistant message bodies, not
        // product copy; their text is data under test, not a surface.
        !/fixtures?\.tsx?$/i.test(file),
    )
    .sort()

  for (const file of files) {
    const source = readFileSync(join(here, file), 'utf8')
    for (const hit of offendingLines(source)) {
      failures.push(`${file}:${hit}`)
    }
  }

  expect(failures).toEqual([])
})

test('the scan distinguishes prose from code (guards its own precision)', () => {
  // Frame kinds, identifiers and import paths are NOT user text.
  expect(offendingLines(`if (frame.kind === 'accounts.snapshot') return\n`)).toEqual([])
  expect(offendingLines(`import { x } from './snapshotState.js'\n`)).toEqual([])
  expect(offendingLines(`const snapshotRef = useRef(null)\n`)).toEqual([])
  // Comments are exempt under §7.
  expect(offendingLines(`// the sidecar sends a redacted snapshot here\n`)).toEqual([])
  // Prose in JSX text and in a user-visible prop is NOT exempt.
  expect(offendingLines(`<p>Waiting for the engine's memory snapshot</p>\n`)).not.toEqual([])
  expect(offendingLines(`<X desc="the sidecar is busy" />\n`)).not.toEqual([])
  // The escape hatch works.
  expect(offendingLines(`<p>a sidecar thing</p> // §7-ok\n`)).toEqual([])
  // A JSX text node wrapped across lines is still caught. Scanning per line
  // missed exactly this shape, which is how "Read-only snapshot" survived.
  expect(
    offendingLines(`<span\n  className="chip"\n>\n  Read-only snapshot\n</span>\n`),
  ).not.toEqual([])
})
