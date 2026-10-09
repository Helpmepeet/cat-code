// Rules for finding and removing workspace-map material in text, shared by
// scrubMaps.ts (working copies) and scrubTranscript.ts (session inputs).

// Map-study conclusions: evaluations of whether and how agents use the maps.
export const MAP_STUDY_FILES = [
  'docs/reports/2026-07-04-workspace-map-usage-evaluation.md',
  'docs/reports/2026-07-14-map-consultation-diagnosis.md',
  'docs/reports/2026-09-05-workspace-map-scalability-review.md',
  'docs/reports/2026-07-12-refresh-workspace-maps-automation-review.md',
]
// DONE.md entries that report map-usage measurements.
export const DONE_STUDY_ENTRY = /^\d+\. (Re-measured workspace-map usage|Measured workspace-map usage|Diagnosed (why )?map consultation)/

export const TOKEN = new RegExp([
  String.raw`\[[^\]\n]*\]\([^)\n]*(?:docs/maps|WORKSPACE_MAP)[^)\n]*\)`,
  String.raw`\x60[^\x60\n]*(?:docs/maps|WORKSPACE_MAP|maps:lint|workspaceMapLint|workspaceMapRefreshState|mapRoutingNudge|map-routing-nudge)[^\x60\n]*\x60`,
  String.raw`(?:\.\/)?docs/maps(?:/[\w.\-/{},*]*)?`,
  String.raw`(?:docs/maps/)?WORKSPACE_MAP(?:\.md)?`,
  String.raw`scripts/(?:workspaceMapLint|workspaceMapRefreshState|mapRoutingNudge)(?:\.test)?\.ts`,
  String.raw`(?:bun run )?maps:lint`,
  String.raw`(?:\.claude/hooks/)?map-routing-nudge(?:\.sh)?`,
  String.raw`\b[Mm]aps?[- ]lint\b`,
  String.raw`(?:\.\.\/)+maps\/[\w./-]*`,
  String.raw`\bmaps\/[\w-]+\.md\b`,
].join('|'), 'g')
export const PROSE = new RegExp([
  String.raw`workspace[- ]maps?\b|map-first|routing nudge|maps route|refresh(?:ed)? (?:the )?(?:workspace |routing )?maps|\bmaps? (?:is|are) (?:navigation|routing)`,
  String.raw`\b(?:maintained|desktop|runtime|codex-core|codex|provider|query\/provider|focused|subsystem|navigation|owner|relevant|routing|affected(?: \w+)?) maps?\b`,
  String.raw`\bmaps?[- ](?:lint|nudge|router|refresh|updates?|entries|rows|edits|changes|dates)\b`,
  String.raw`\b(?:contract|decision)\/maps?\b|\bmaps?\/status\b`,
  String.raw`\b(?:docs|configs|tests|status),? (?:and )?maps\b|\bmaps, and\b`,
  String.raw`\bmap-routing\b|\b(?:repository|listed|documentation|focused source|prompt-system|analytics|account\/analytics) maps?\b|\bmaps?, parity-ledger\b`,
  String.raw`\bmaps? (?:were|was) used for navigation|\[[^\]\n]*\bmaps?\]`,
  String.raw`^\s*#{1,6}\s.*\band [Mm]aps?\s*$`,
].join('|'), 'i')
// Broader net for the residual review only; matches here are never auto-edited.
export const REVIEW = /\bmaps?\b/i
const ANY_RE = new RegExp(`${TOKEN.source}|${PROSE.source}`, 'i')
// Reviewed uses of "map" in another sense (Codex cache routing map, a prompt
// reference described as a routing map). Never edited, never reported.
const ALLOW: { file: RegExp; text: RegExp }[] = [
  { file: /^docs\/codex\/2026-04-30-cache-|^docs\/research\/2026-06-05-codex-cache-deep-dive|^docs\/codex\/2026-04-30-investigation-backend-slowness/, text: /routing map/i },
  { file: /^docs\/plans\/2026-04-11-agent-mode-phase1/, text: /Routing map for prompt-related changes/ },
  { file: /^docs\/design-html\/2026-09-30-analytics-/, text: /TITLES = \[|map-routing nudge failing/ },
  { file: /^docs\/reference\/2026-04-30-codex-core-extraction-map\.md$/, text: /Focused map:/ },
  { file: /^docs\/design-html\/2026-08-23-ask-user-question-redesign\.html$/, text: /Maps and the migration status file/ },
]
let currentFile = ''
export function setCurrentFile(f: string) { currentFile = f }
export const ANY = { test: (s: string) => ANY_RE.test(s) && !ALLOW.some(a => a.file.test(currentFile) && a.text.test(s)) }


const MARK = '\u0000'
const SEP = String.raw`(?:,|;|\+|&&|/|\band\b|\bor\b)`
// Removes tokens that are items of a list (with their separator). Returns null
// when a token is not a list item: the sentence then goes as a whole.
function dropListTokens(s: string): string | null {
  let t = s.replace(TOKEN, MARK)
  if (!t.includes(MARK)) return s
  t = t.replace(new RegExp(String.raw`\(\s*${MARK}(?:\s*${SEP}\s*${MARK})*\s*\)`, 'g'), '')
  t = t.replace(new RegExp(String.raw`${MARK}\s*${SEP}\s*`, 'g'), '')
  t = t.replace(new RegExp(String.raw`\s*${SEP}\s*${MARK}`, 'g'), '')
  if (t.includes(MARK)) return null
  return t.replace(/(\S) {2,}/g, '$1 ')
}

const SENT = /(?<=[.!?])\s+(?=[A-Z`*\[(])/
function dropSentences(s: string): string {
  return s.split(SENT).flatMap(x => {
    if (!ANY.test(x)) return [x]
    const t = dropListTokens(x)
    return t === null || ANY.test(t) ? [] : [t]
  }).join(' ')
}
// Nothing substantive left: only markers, punctuation, or a dangling label.
function trivial(s: string): boolean {
  const core = s.replace(/^\s*(?:[-*>]|\d+\.|#+|\|)\s*/, '').replace(/^\*?\*?[^:]{0,60}:\*?\*?\s*/, '').replace(/[\s.,;:|*_`()\[\]-]+/g, '')
  return core.length < 3
}

export type Change = { file: string; action: string; before?: string; after?: string }
export const changes: Change[] = []

function scrubLines(file: string, text: string): string {
  return text.split('\n').map(line => {
    if (!ANY.test(line)) return line
    const t = dropListTokens(line)
    if (t !== null && !ANY.test(t)) { changes.push({ file, action: 'edit-line', before: line, after: t }); return t }
    return line
  }).join('\n')
}

// Search output lines from map files ("docs/maps/x.md:12:...") go whole.
const GREP_LINE = /^\s*(?:\.\/)?(?:docs\/maps\/|scripts\/(?:mapRoutingNudge|workspaceMap))[^\s:]*:(?:\d+[:-])?/
function dropGrepLines(file: string, text: string): string {
  if (!GREP_LINE.test(text) && !/\n\s*(?:\.\/)?docs\/maps\//.test(text)) return text
  return text.split('\n').filter(l => { const hit = GREP_LINE.test(l); if (hit) changes.push({ file, action: 'drop-search-line', before: l }); return !hit }).join('\n')
}

export function scrubText(file: string, rawText: string): string {
  currentFile = file
  const text = dropGrepLines(file, rawText)
  if (!/\.(md|mdx)$/i.test(file)) return scrubLines(file, text)
  const lines = text.split('\n')
  const out: string[] = []
  const drops: { at: number; indent: number }[] = []
  let fence = false
  let skipUntilLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const heading = /^(#{1,6})\s/.exec(line)
    if (skipUntilLevel && heading && heading[1]!.length <= skipUntilLevel) skipUntilLevel = 0
    if (skipUntilLevel) { changes.push({ file, action: 'drop-section-line', before: line }); continue }
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push(line); continue }
    if (!ANY.test(line)) { out.push(line); continue }
    if (heading && !fence) {
      // "Maps and verification" keeps its section; a heading about the maps drops it.
      const edited = line
        .replace(/\b[Mm]aps?\s+and\s+(\w)/, (_, c) => c.toUpperCase())
        .replace(/,\s*maps?\b(?=\s*,)/i, '')
        .replace(/,?\s+and\s+(?:\w+\s+)?maps?\b/i, '')
        .replace(/\s+[Mm]ap\s+(Updates?)\b/, ' $1')
      if (!ANY.test(edited) && /\w/.test(edited.replace(/^#+\s*/, '').replace(/^(?:Step|Task) \d+:\s*/, ''))) { changes.push({ file, action: 'edit-heading', before: line, after: edited }); out.push(edited); continue }
      skipUntilLevel = heading[1]!.length; changes.push({ file, action: 'drop-section', before: line }); continue
    }
    if (fence) { changes.push({ file, action: 'drop-code-line', before: line }); continue }
    // Prose paragraph: gather wrapped continuation lines so sentences are whole.
    const isBlock = /^\s*([-*>|]|\d+\.)/.test(line)
    let unit = line, j = i
    if (!isBlock) {
      while (j + 1 < lines.length && lines[j + 1]!.trim() && !/^\s*([-*>|#]|\d+\.|```)/.test(lines[j + 1]!)) unit += ' ' + lines[++j]!.trim()
      while (out.length && out[out.length - 1]!.trim() && !/^\s*([-*>|#]|\d+\.|```)/.test(out[out.length - 1]!)) unit = out.pop()!.trimEnd() + ' ' + unit.trim()
    } else {
      while (j + 1 < lines.length && /^\s{2,}\S/.test(lines[j + 1]!) && !/^\s*([-*]|\d+\.)\s/.test(lines[j + 1]!)) unit += ' ' + lines[++j]!.trim()
    }
    let next: string
    i = j
    if (unit.trimStart().startsWith('|')) {
      let emptied = false
      next = unit.split('|').map(cell => {
        if (!ANY.test(cell)) return cell
        const t = dropSentences(cell.trim())
        if (!t.trim()) emptied = true
        return ' ' + t.trim() + ' '
      }).join('|')
      if (emptied) { changes.push({ file, action: 'drop-row', before: unit }); continue }
    } else {
      const body = unit.replace(/^(\s*(?:[-*>]|\d+\.)\s+)/, '')
      const lead = unit.slice(0, unit.length - body.length)
      // A list item whose topic (first sentence) is the maps goes as a whole.
      // A list item whose topic (first sentence) is the maps goes as a whole; a
      // map path that is only one item of a list in it goes alone.
      const topic = body.split(SENT)[0]!
      const cleaned = ANY.test(topic) ? dropListTokens(topic) : topic
      if (isBlock && (cleaned === null || ANY.test(cleaned))) { changes.push({ file, action: 'drop-item', before: unit }); drops.push({ at: out.length, indent: indentOf(unit) }); continue }
      next = lead + dropSentences(body)
    }
    if (trivial(next) || ANY.test(next)) { changes.push({ file, action: 'drop-unit', before: unit }); if (isBlock) drops.push({ at: out.length, indent: indentOf(unit) }); continue }
    if (next.trim() === unit.trim()) { out.push(unit); continue }
    changes.push({ file, action: 'edit', before: unit, after: next })
    out.push(next)
  }
  return tidyLists(file, out, drops).join('\n')
}

const ITEM = /^(\s*)(?:[-*]|(\d+)\.)\s+/
const indentOf = (l: string) => (ITEM.exec(l)?.[1] ?? /^\s*/.exec(l)![0]).length
// After list items are dropped: a parent item that only introduced the dropped
// children ("Read:") goes too, and ordered lists are renumbered.
function tidyLists(file: string, out: string[], drops: { at: number; indent: number }[]): string[] {
  const kill = new Set<number>()
  for (const d of drops) {
    const p = d.at - 1
    const parent = out[p]
    if (parent === undefined || !ITEM.test(parent) || indentOf(parent) >= d.indent || !/:\s*$/.test(parent)) continue
    const nextLine = out[d.at]
    const hasChild = nextLine !== undefined && ITEM.test(nextLine) && indentOf(nextLine) > indentOf(parent)
    if (!hasChild) { kill.add(p); changes.push({ file, action: 'drop-empty-parent', before: parent }) }
  }
  const kept = out.filter((_, i) => !kill.has(i))
  if (!drops.length) return kept
  // Renumber ordered runs at each indent.
  const counters = new Map<number, number>()
  return kept.map(l => {
    const m = ITEM.exec(l)
    if (!m) { if (l.trim() === '') return l; if (!/^\s/.test(l)) counters.clear(); return l }
    const ind = m[1]!.length
    for (const k of [...counters.keys()]) if (k > ind) counters.delete(k)
    if (m[2] === undefined) { counters.delete(ind); return l }
    const n = counters.has(ind) ? counters.get(ind)! + 1 : Number(m[2])
    counters.set(ind, n)
    return n === Number(m[2]) ? l : l.replace(/^(\s*)\d+\./, `$1${n}.`)
  })
}
