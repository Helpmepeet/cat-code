import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Repo-wide enforcement of CLAUDE.md §7 "Never render engineering notes".
 *
 * Per-file assertions did not hold this line: the same "Waiting for the engine's
 * X snapshot…" / "does not use prototype fixtures. It fills once the sidecar…"
 * copy reached EIGHT surfaces, each guarded only if someone remembered to add a
 * check. This is the §7 analogue of `fastRefreshBoundaries.test.ts`: one sweep
 * over every module that composes user-readable text, so a ninth instance fails
 * here instead of shipping.
 *
 * SCOPE (widened 2026-07-28). The sweep used to read `renderer/src` only, which
 * made every string composed in `main`, `host` or `sidecar` structurally
 * invisible to it — and those planes are not internal. A `HostError.message` is
 * printed verbatim by the shell error line (`App.tsx` `${error.code}:
 * ${error.message}`) and an `ErrorFrame.message` becomes a danger toast
 * (`verbAckResultState.ts`), so a phrase written in `host.ts` lands on the same
 * screen as one written in a component. All four planes are swept.
 *
 * Precision matters more than reach. Code comments are explicitly exempt under
 * §7, and identifiers/frame kinds like `'accounts.snapshot'` are not user text,
 * so the scan looks only at strings that plausibly READ as prose: JSX text nodes
 * and string literals containing a space. That is why `frame.kind ===
 * 'accounts.snapshot'` passes while `desc="…workspace-trust snapshot…"` fails.
 * Three further exclusions carry their weight:
 *   - `className`/`class` values are stripped before scanning. Tailwind design
 *     tokens are English words (`border-shell-seam`) and produced ~150 false
 *     positives on their own.
 *   - a banned term glued to a hyphen is part of an identifier, not prose
 *     (`session-preload`, `border-shell-seam`), so it does not count.
 *   - a string opening with a bracketed tag (`[registry] …`, `[sidecar] …`) is
 *     a process diagnostic addressed to whoever is reading a terminal.
 *
 * To allow a genuine exception, put `§7-ok` in a comment on the same line.
 *
 * KNOWN LIMITS. A word list catches the mechanical leak (naming a frame, a
 * process, or a fixture) but not the judgment-level half of §7 — copy that
 * explains why we have not built something ("deferred until a safe writer is
 * wired") reads perfectly clean here unless it also names a mechanism. That
 * still needs review. The sweep is also flat per directory (it does not
 * recurse), and it reads text where it is WRITTEN, so a phrase assembled from
 * fragments at runtime is invisible to it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..', '..')

const ROOTS = [
  here,
  join(appRoot, 'main'),
  join(appRoot, 'host'),
  join(appRoot, 'sidecar'),
]

/**
 * Internal vocabulary that must never reach a user. Each entry is here because
 * it actually shipped on a surface, not on suspicion. Bare `seam` and
 * `allowlist` subsume the earlier `read seam` / `write allowlist` entries.
 */
const BANNED = [
  'sidecar',
  'snapshot',
  'prototype',
  'seam',
  'allowlist',
  'preload',
  'projector',
  'frame kind',
  'registry row',
  'engine config',
  "engine's",
]

/**
 * Shapes, not words. A file:line citation, a session id from the migration
 * backlog, and a SCREAMING_CASE limit constant are all engineering notes that no
 * word list can enumerate, and all three have reached a surface.
 */
const BANNED_PATTERNS = [
  /[A-Za-z0-9_]+\.(tsx?|jsx?):\d+/,
  /\b(P\d-\d+[a-z]?|CC-\d+[a-z]?|RAM-?\d)\b/,
  /\bMAX_[A-Z0-9_]+\b/,
]

/**
 * Deliberately NOT banned: "redacted". It reads as internal vocabulary in our
 * copy, but it also has a legitimate user-facing meaning the transcript relies
 * on (thinking content redacted by the model provider), so it is not a reliable
 * signal on its own. Every real violation found so far also tripped one of the
 * terms above.
 */

/**
 * Strings this sweep has already been shown and must not fail on TODAY. Two
 * kinds, and the difference matters:
 *
 *   NOT A SURFACE — the sweep is right about the words and wrong about the
 *   audience: the string reaches a terminal or a crash log, never a window.
 *
 *   PENDING — a real §7 violation sitting in a file another session owns right
 *   now (2026-07-28 wave). Listed so this guard can land green today instead of
 *   being deleted; delete the entry when the copy is fixed. Matching is by exact
 *   text, not by file, so a NEW violation in the same file still fails.
 */
const KNOWN: { text: string; why: string }[] = [
  // NOT A SURFACE — dev-harness diagnostics, folded into a `[main] …` log line.
  { text: 'invalid allowlist cwd:', why: 'not a surface: devHarness log reason' },
  { text: 'empty allowlist', why: 'not a surface: devHarness log reason' },
  // NOT A SURFACE — sidecar boot failures. The process dies before any window
  // can attach, so these are read from a terminal or a crash log.
  {
    text: 'sidecar requires CATCODE_SIDECAR_SOCKET and CATCODE_SIDECAR_SESSION_ID',
    why: 'not a surface: sidecar boot failure, stderr only',
  },
  {
    text: 'sidecar requires CATCODE_SIDECAR_CWD',
    why: 'not a surface: sidecar boot failure, stderr only',
  },
  {
    text: 'sidecar must run under Bun (Bun.listen unavailable)',
    why: 'not a surface: sidecar boot failure, stderr only',
  },
  // NOT A SURFACE — a label handed to the outbound payload check, used only in
  // the diagnostic it writes when a payload is dropped.
  {
    text: 'permission.context snapshot',
    why: 'not a surface: internal label for the outbound payload check',
  },
  // PENDING — owner: the concurrent host/sidecar copy pass (2026-07-28 wave).
  // Both become the shell error line verbatim via `${error.code}: ${message}`.
  {
    text: 'prior sidecar for is still running',
    why: 'pending: host.ts hostError copy, owned by the host/sidecar copy pass',
  },
  {
    text: 'session has no registry row',
    why: 'pending: host.ts hostError copy, owned by the host/sidecar copy pass',
  },
  {
    text: 'sessionId does not address this sidecar',
    why: 'pending: sidecarServer.ts error-frame copy, owned by the host/sidecar copy pass',
  },
  // PENDING — owner: whoever lands the agent-config write path. This one is the
  // full §7 house special: a session id, a frame word, and an explanation of why
  // something is not built, all rendered as the read-only reason.
  {
    text: 'P4-7 exposes a read-only snapshot; desktop editing waits for a full-fidelity writer.',
    why: 'pending: agentConfigDomain.ts readOnlyReason, owned by the agent-config write path',
  },
]

const KNOWN_TEXT = new Set(KNOWN.map(entry => entry.text))

/**
 * Blank out `className`/`class` attribute values. Tailwind tokens are English
 * (`border-shell-seam`, `bg-shell-hover`) and are not read by anyone. Replaced
 * space-for-space so reported line numbers stay true to the original file.
 */
function stripClassNames(source: string): string {
  return source.replace(
    /\b(?:className|class)\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\}|`[^`]*`)/g,
    match => match.replace(/[^\n]/g, ' '),
  )
}

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
 * Candidate user-visible strings, scanned over the WHOLE file rather than
 * line-by-line: JSX text nodes routinely wrap across lines
 * (`<span\n  className=…>\n  Read-only snapshot\n</span>`), and a per-line scan
 * silently misses every one of them.
 *
 * Quoted literals are included only when they read as prose (a space rules out
 * identifiers, frame kinds, import paths, and enum values).
 */
type Candidate = { index: number; text: string }

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

  // Single- and double-quoted literals stay LINE-scoped: prose containing an
  // apostrophe ("engine's") otherwise opens a bogus literal that runs to the
  // next quote anywhere in the file, swallowing code and reporting nonsense.
  let offset = 0
  for (const line of source.split('\n')) {
    for (const match of line.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      // Drop `${…}` bodies: identifiers, not words a user reads.
      // `${snapshot.readyCount} of ${snapshot.poolCount} ready` renders "1 of 2 ready".
      const text = match[2]!.replace(/\$\{[^}]*\}/g, ' ')
      if (text.includes(' ')) out.push({ index: offset + match.index!, text })
    }
    offset += line.length + 1
  }
  const sourceFile = ts.createSourceFile(
    'source.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const visit = (node: ts.Node): void => {
    if (
      ts.isNoSubstitutionTemplateLiteral(node) &&
      node.getText(sourceFile).includes('\n') &&
      node.text.includes(' ')
    ) {
      out.push({ index: node.getStart(sourceFile) + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}

type Offence = { line: number; text: string }

function offences(source: string): Offence[] {
  const hits: Offence[] = []
  const lines = source.split('\n')
  const stripped = stripClassNames(stripComments(source))
  for (const { index, text } of candidateStrings(stripped)) {
    const normalized = text.replace(/\s+/g, ' ').trim()
    // A bracketed tag opens a process diagnostic, not a sentence on a screen.
    if (/^\[[a-z][a-z-]*\]/.test(normalized)) continue
    const startLine = stripped.slice(0, index).split('\n').length
    const endLine = startLine + text.split('\n').length - 1
    // The escape hatch may sit on any line the candidate spans.
    const exempt = lines
      .slice(startLine - 1, endLine)
      .some(line => line.includes('§7-ok'))
    if (exempt) continue
    const banned = BANNED.some(term =>
      // Word-boundary so "snapshot" flags prose but "snapshotRef" does not, and
      // a leading hyphen means we are inside an identifier, not a sentence.
      new RegExp(`(^|[^a-zA-Z-])${term}(s\\b|\\b)`, 'i').test(normalized),
    )
    if (banned || BANNED_PATTERNS.some(pattern => pattern.test(normalized))) {
      hits.push({ line: startLine, text: normalized })
    }
  }
  return hits
}

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .filter(
      file =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        // Fixture modules carry SIMULATED user/assistant message bodies, not
        // product copy; their text is data under test, not a surface.
        !/fixtures?\.tsx?$/i.test(file),
    )
    .sort()
}

test('no plane renders internal vocabulary at the user', () => {
  const failures: string[] = []

  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const hit of offences(source)) {
        if (KNOWN_TEXT.has(hit.text)) continue
        failures.push(`${file}:${hit.line}: ${hit.text.slice(0, 90)}`)
      }
    }
  }

  expect(failures).toEqual([])
})

test('the sweep reaches past the renderer', () => {
  // The scope bug this test carried for its whole life: it read one directory,
  // so a host error message printed verbatim by the shell was never looked at.
  // If a root ever resolves to nothing, the sweep above passes vacuously.
  for (const root of ROOTS) {
    expect(sourceFiles(root).length).toBeGreaterThan(0)
  }
  expect(ROOTS.length).toBe(4)
})

test('the scan distinguishes prose from code (guards its own precision)', () => {
  // Frame kinds, identifiers and import paths are NOT user text.
  expect(offences(`if (frame.kind === 'accounts.snapshot') return\n`)).toEqual([])
  expect(offences(`import { x } from './snapshotState.js'\n`)).toEqual([])
  expect(offences(`const snapshotRef = useRef(null)\n`)).toEqual([])
  // Comments are exempt under §7.
  expect(offences(`// the sidecar sends a redacted snapshot here\n`)).toEqual([])
  // Prose in JSX text and in a user-visible prop is NOT exempt.
  expect(offences(`<p>Waiting for the engine's memory snapshot</p>\n`)).not.toEqual([])
  expect(offences(`<X desc="the sidecar is busy" />\n`)).not.toEqual([])
  // The escape hatch works.
  expect(offences(`<p>a sidecar thing</p> // §7-ok\n`)).toEqual([])
  // A JSX text node wrapped across lines is still caught. Scanning per line
  // missed exactly this shape, which is how "Read-only snapshot" survived.
  expect(
    offences(`<span\n  className="chip"\n>\n  Read-only snapshot\n</span>\n`),
  ).not.toEqual([])
  // Template literals may wrap as naturally as JSX. The apostrophe-safe quoted
  // literal extractor must still scan their complete text.
  expect(
    offences('const copy = `Waiting for the engine\'s\nmemory snapshot`\n'),
  ).not.toEqual([])
})

test('the words added on 2026-07-28 are actually enforced', () => {
  // Each of these shipped, or could ship, while the old list stayed green.
  expect(offences(`<p>Waiting for the write seam</p>\n`)).not.toEqual([])
  expect(offences(`<p>Not on the allowlist yet</p>\n`)).not.toEqual([])
  expect(offences(`<p>The preload bridge is unavailable</p>\n`)).not.toEqual([])
  expect(offences(`<p>The projector dropped this row</p>\n`)).not.toEqual([])
  expect(offences(`<p>Unknown frame kind</p>\n`)).not.toEqual([])
  // Shapes, not words: a citation, a backlog session id, a limit constant.
  expect(offences(`<p>See transcriptProjector.ts:940 for details</p>\n`)).not.toEqual([])
  expect(offences(`<p>Deferred to P4-20 for now</p>\n`)).not.toEqual([])
  expect(offences(`<p>Blocked by CC-19 until it lands</p>\n`)).not.toEqual([])
  expect(offences(`<p>RAM0 has not reported yet</p>\n`)).not.toEqual([])
  expect(offences(`<p>Larger than MAX_FRAME_BYTES</p>\n`)).not.toEqual([])
})

test('the seam and preload exclusions do not swallow real prose', () => {
  // The two false-positive classes the added words introduced: a Tailwind token
  // and a hyphenated log tag. Both must pass...
  expect(
    offences(`<div className="border-b border-shell-seam px-4">Ready</div>\n`),
  ).toEqual([])
  expect(offences(`log(\`[session-preload] start: eligible=2\`)\n`)).toEqual([])
  // ...while the same words in a sentence still fail.
  expect(offences(`<div className="px-4">Waiting on the seam</div>\n`)).not.toEqual([])
  expect(offences(`<p>The preload step is still running</p>\n`)).not.toEqual([])
})
