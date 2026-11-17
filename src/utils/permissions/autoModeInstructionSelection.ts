import { INSTRUCTION_AUTHORITY_RULE } from '../../constants/corePolicy.js'

// Match the existing snapshot framing exactly. A framing change makes this
// optimization inapplicable rather than silently discarding unfamiliar text.
const INSTRUCTION_PREAMBLE =
  `Codebase and user instructions are shown below, each labeled with its source. Be sure to adhere to these instructions. IMPORTANT: these instructions OVERRIDE any default behavior and you MUST follow them exactly as written. ${INSTRUCTION_AUTHORITY_RULE}`

const SOURCE_HEADER = /^Contents of (?:\/|[A-Za-z]:[\\/])[^\r\n]+\.(?:md|txt)(?: \((?:project instructions, checked into the codebase|user's private project instructions, not checked in|user's private global instructions for all projects)\))?:$/

const STYLE_HEADINGS = new Set([
  'style', 'code style', 'coding style', 'formatting', 'formatting preferences',
  'indentation', 'quotes', 'line endings', 'whitespace', 'line wrapping',
  'markdown', 'markdown style', 'prose', 'prose style', 'typography',
  'headings', 'lists', 'naming', 'naming conventions', 'punctuation',
])

// Positive, complete sentences with a closed set of meanings. Matching a
// heading or failing to find a security keyword never makes prose removable.
// In particular, conditions, exceptions, references, examples and code are not
// in this grammar. One unfamiliar sentence retains the entire snapshot.
const FORMATTING_SENTENCES = [
  /^Use (?:two|four|2|4) spaces for indentation\.$/,
  /^Use tabs for indentation\.$/,
  /^(?:Use|Prefer) (?:single|double) quotes(?: in (?:JavaScript|TypeScript|Python|Ruby))?\.$/,
  /^Keep Markdown headings in sentence case\.$/,
  /^Use sentence case for (?:headings|Markdown headings)\.$/,
  /^Wrap (?:Markdown|documentation|prose)(?: (?:lines|paragraphs))? at [1-9][0-9]{1,2} (?:characters|columns)\.$/,
  /^Limit (?:line length|prose line length|Markdown line length) to [1-9][0-9]{1,2} (?:characters|columns)\.$/,
  /^End files with a (?:single )?newline\.$/,
  /^Use LF line endings\.$/,
  /^(?:Omit|Avoid) trailing whitespace\.$/,
  /^Use (?:ATX|Setext) headings(?: in Markdown)?\.$/,
  /^Use (?:asterisks|hyphens) for unordered list markers\.$/,
  /^Use backticks for inline code\.$/,
  /^Use (?:bold|italics) for emphasis\.$/,
  /^Separate paragraphs with a blank line\.$/,
  /^Place opening braces on the (?:same|next) line\.$/,
  /^Use (?:camelCase|PascalCase|snake_case|kebab-case) for (?:variable|function|type|file|CSS class) names\.$/,
  /^Use Oxford commas\.$/,
  /^Use (?:American|British) English spelling\.$/,
  /^Use (?:one|two) spaces after sentence-ending punctuation\.$/,
  /^Avoid exclamation marks\.$/,
]

export type AutoModeInstructionSelection = {
  text: string | null
  removedChars: number
  disposition: 'unchanged' | 'formatting_only'
}

function hasIndependentBuildContext(projected: string): boolean {
  if (projected === '') return true
  // Absence of dependency keywords is insufficient. Recognize only a simple
  // local-build request and its build command; all other contexts, including
  // code, references, short approvals and unfamiliar languages, retain files.
  if (/[^\t\r\n\x20-\x7e]/.test(projected)) return false
  let requests = 0
  let commands = 0
  for (const line of projected.trim().split(/\r?\n/)) {
    let kind: string
    let value: unknown
    if (line.startsWith('User: ')) {
      kind = 'user'
      value = line.slice('User: '.length)
    } else if (line.startsWith('Bash ')) {
      kind = 'Bash'
      value = line.slice('Bash '.length)
    } else {
      let record: unknown
      try { record = JSON.parse(line) } catch { return false }
      if (typeof record !== 'object' || record === null || Array.isArray(record) ||
        Object.keys(record).length !== 1) return false
      kind = Object.keys(record)[0]!
      value = (record as Record<string, unknown>)[kind]
    }
    if (typeof value !== 'string') return false
    if (kind === 'user' && /^(?:Please )?(?:Run|Start|Perform) (?:the|a) local build[.!]?$/i.test(value)) {
      requests++
    } else if (kind === 'Bash' && /^(?:bun|npm|pnpm|yarn) run build(?::(?:dev(?::full)?|local))?$/.test(value)) {
      commands++
    } else return false
  }
  return requests === 1 && commands === 1
}

/**
 * Omit only snapshots whose complete source bodies express independent,
 * recognized formatting preferences, and whose projected history and pending
 * action have no recognized dependency on them. Preserve every source label
 * and the original engine boilerplate. Any uncertainty keeps all original bytes.
 * This does not infer consent, authority, or action permissions from a file.
 * Callers must supply the full projected history and action, not a trimmed view.
 */
export function selectAutoModeInstructionContext(
  full: string | null,
  projectedDependencyText = '',
): AutoModeInstructionSelection {
  const unchanged: AutoModeInstructionSelection = { text: full, removedChars: 0, disposition: 'unchanged' }
  if (!full || !hasIndependentBuildContext(projectedDependencyText)) return unchanged

  let preamble = ''
  let body = full
  if (body.startsWith(INSTRUCTION_PREAMBLE + '\n\n')) {
    preamble = INSTRUCTION_PREAMBLE + '\n\n'
    body = body.slice(preamble.length)
  }

  const sources: string[] = []
  let sourceSentences = 0
  for (const line of body.split(/\r?\n/)) {
    if (SOURCE_HEADER.test(line)) {
      if (sources.length > 0 && sourceSentences === 0) return unchanged
      sources.push(line)
      sourceSentences = 0
      continue
    }
    if (line.trim() === '') continue
    if (sources.length === 0 || /^\s{4}|\t/.test(line)) return unchanged

    const heading = line.match(/^#{1,6} ([A-Za-z ]+)$/)
    if (heading) {
      if (!STYLE_HEADINGS.has(heading[1]!.toLowerCase())) return unchanged
      continue
    }

    const text = line.replace(/^ {0,3}(?:[-*] |[1-9][0-9]*[.)] )/, '').trim()
    const sentences = text.split(/(?<=\.) +/)
    for (const sentence of sentences) {
      if (!FORMATTING_SENTENCES.some(pattern => pattern.test(sentence))) return unchanged
      sourceSentences++
    }
  }

  if (sources.length === 0 || sourceSentences === 0) return unchanged
  const text = preamble + sources.join('\n\n')
  if (text.length >= full.length) return unchanged
  return { text, removedChars: full.length - text.length, disposition: 'formatting_only' }
}
