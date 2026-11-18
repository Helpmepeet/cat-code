import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The warning guard (docs/migration/decisions/WARNINGS.md §6).
 *
 * Every warning picks one of the rulebook's kinds and lets that kind's component
 * own its place, look and lifetime. Before the rulebook each surface drew its own,
 * so the same failure looked different in eleven places. This sweep fails when a
 * renderer file draws a new one by hand.
 *
 * It catches specific patterns, not every possible warning:
 *   - `role="alert"`, including a conditional role, outside the warning components;
 *   - the `text-tone-danger` and `text-tone-warn` text colors outside them.
 * `role="status"` and `aria-live` stay free for announcements that are not
 * warnings, such as loading text. Toast tones are not scanned, because callers
 * pass computed tones; the toast type is meant to enforce them instead.
 *
 * The sites that existed when the guard landed are recorded in
 * `warningSurfaces.baseline.json` by file and line text, not by count, so
 * replacing one hand-built warning with another fails here. An entry whose line
 * is gone also fails, so the list only shrinks. A line that is not a warning (a
 * destructive button, a status dot) carries a `warning-ok: <reason>` comment.
 *
 * A hand-built warning that uses none of these patterns passes. Review covers it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const BASELINE_FILE = join(here, 'warningSurfaces.baseline.json')

/** The components that own how a warning looks, and the tone vocabulary itself. */
const WARNING_COMPONENTS = new Set(['BannerStack.tsx', 'ToastHost.tsx', 'tone.ts'])

const PATTERNS = [
  /role=(?:"alert"|'alert'|\{[^}]*['"]alert['"])/,
  /\btext-tone-(?:danger|warn)\b/,
]
/** A reason is required: `warning-ok:` followed by a word, not just the comment's end. */
const EXEMPT = /warning-ok:\s*[A-Za-z]/
const COMMENT_LINE = /^(?:\/\/|\/\*|\*|\{\/\*)/

type Sites = Record<string, Record<string, number>>

export function warningLines(source: string): string[] {
  const lines: string[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (COMMENT_LINE.test(line) || EXEMPT.test(line)) continue
    if (PATTERNS.some(pattern => pattern.test(line))) lines.push(line)
  }
  return lines
}

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'assets' && entry.name !== 'node_modules') files.push(...sourceFiles(path))
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || /fixture/i.test(entry.name)) continue
    if (WARNING_COMPONENTS.has(entry.name)) continue
    files.push(path)
  }
  return files
}

function scanSites(): Sites {
  const sites: Sites = {}
  for (const path of sourceFiles(here).sort()) {
    const lines = warningLines(readFileSync(path, 'utf8'))
    if (lines.length === 0) continue
    const counts: Record<string, number> = {}
    for (const line of lines) counts[line] = (counts[line] ?? 0) + 1
    sites[relative(here, path)] = counts
  }
  return sites
}

test('no warning is built by hand outside the warning components', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Sites
  const current = scanSites()
  const added: string[] = []
  const gone: string[] = []
  for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
    const now = current[file] ?? {}
    const recorded = baseline[file] ?? {}
    for (const line of new Set([...Object.keys(now), ...Object.keys(recorded)])) {
      const difference = (now[line] ?? 0) - (recorded[line] ?? 0)
      if (difference > 0) added.push(`  ${file}: ${line}`)
      if (difference < 0) gone.push(`  ${file}: ${line}`)
    }
  }
  if (added.length > 0) {
    throw new Error([
      'A warning is drawn by hand outside the warning components (docs/migration/decisions/WARNINGS.md):',
      ...added,
      'Use the kind the rulebook names: BannerStack for an app or chat bar, a transcript note for something',
      'that happened in the conversation, a toast only to say "done". If the line is not a warning (a',
      'destructive button, a status dot), add a `warning-ok: <reason>` comment on the same line.',
      'Editing a line recorded in warningSurfaces.baseline.json counts as a new site. Move that warning to',
      'its kind; if its kind is not built yet, update the entry in the same commit and say why.',
    ].join('\n'))
  }
  if (gone.length > 0) {
    throw new Error([
      'These warningSurfaces.baseline.json entries no longer exist. Remove them (or lower their count):',
      ...gone,
    ].join('\n'))
  }
  expect(Object.keys(current).length).toBeGreaterThan(0)
})

test('the sweep matches only the patterns it promises', () => {
  expect(warningLines([
    '<p role="alert" className="mt-2">{error}</p>',
    "role={failed ? 'alert' : 'status'}",
    '<span className="text-tone-warn/70">late</span>',
    "className='hover:text-tone-danger'",
    '<div role="status">Opening report.pdf</div>',
    '// role="alert" in a comment',
    '* text-tone-danger in a doc comment',
    '<button className="text-tone-danger" /* warning-ok: destructive button */>Delete</button>',
    '<button className="text-tone-danger" /* warning-ok: */>Delete</button>',
    "className='bg-tone-danger/10'",
  ].join('\n'))).toEqual([
    '<p role="alert" className="mt-2">{error}</p>',
    "role={failed ? 'alert' : 'status'}",
    '<span className="text-tone-warn/70">late</span>',
    "className='hover:text-tone-danger'",
    '<button className="text-tone-danger" /* warning-ok: */>Delete</button>',
  ])
})
