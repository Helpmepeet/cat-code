import { createContext } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { RootContent } from 'mdast'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { filePathMentions, isInlineFilePath, workspaceFileHref } from './transcriptFileLinks.js'
import { scopedTranscriptFilePath, transcriptFileScopes } from './transcriptFileScope.js'
import { paneFileKey } from './paneFileKey.js'
import { isPaneFilePath } from './filePaneState.js'
import { toolCardFilePath } from './transcriptToolTarget.js'
import { filePreviewKind, isKnownFileMention } from '../../shared/filePreview.js'
import type { OpenedPaneFiles } from './filePaneOpened.js'

export const LatestPaneFileCardContext = createContext<ReadonlyMap<string, string> | null>(null)

export { paneFileKey } from './paneFileKey.js'

export function paneCardPaths(row: NestedToolUseRow): string[] {
  if (row.toolFamily !== 'write' && row.toolFamily !== 'edit') return []
  const path = toolCardFilePath(row)
  return [...new Set([...(path ? [path] : []), ...(row.result?.fileDiffs?.map(diff => diff.filePath) ?? [])])]
    .filter(isPaneFilePath)
}

/** A session-level map makes the parent and its worker views share one newest card. */
function orderedPaneRows(rows: readonly NestedTranscriptRow[], order?: readonly string[]): NestedTranscriptRow[] {
  const all: NestedTranscriptRow[] = []
  const visit = (rows: readonly NestedTranscriptRow[]) => {
    for (const row of rows) { all.push(row); visit(row.children) }
  }
  visit(rows)
  if (order) {
    const ranks = new Map(order.map((id, index) => [id, index]))
    all.sort((left, right) => (ranks.get(left.id) ?? -1) - (ranks.get(right.id) ?? -1))
  }
  return all
}

export function latestPaneFileCards(
  rows: readonly NestedTranscriptRow[],
  cwd: string | null,
  order?: readonly string[],
  scopes?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const latest = new Map<string, string>()
  for (const row of orderedPaneRows(rows, order)) {
    if (row.kind === 'tool-use') for (const path of paneCardPaths(row)) latest.set(paneFileKey(path, scopes?.get(row.id) ?? cwd), row.id)
  }
  return latest
}

export function sameFileCards(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [key, id] of right) if (left.get(key) !== id) return false
  return true
}

const parser = unified().use(remarkParse)
export type ReplyFileMention = { path: string; strength: 'strong' | 'weak' }
const replyPaths = new WeakMap<object, ReplyFileMention[]>()

export function pathsInReply(row: Extract<NestedTranscriptRow, {kind: 'assistant-text'}>): readonly ReplyFileMention[] {
  if (row.isStreaming) return []
  const cached = replyPaths.get(row)
  if (cached) return cached
  const paths: ReplyFileMention[] = []
  const document = parser.parse(row.content)
  const definitions = new Map(document.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]))
  const addStrong = (path: string | null) => { if (path !== null && isKnownFileMention(path)) paths.push({ path, strength: 'strong' }) }
  const visit = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'link') addStrong(workspaceFileHref(node.url))
      else if (node.type === 'linkReference') addStrong(workspaceFileHref(definitions.get(node.identifier.toLowerCase())))
      else if (node.type === 'inlineCode') {
        if (workspaceFileHref(node.value) !== null && isInlineFilePath(node.value)) addStrong(node.value)
      } else if (node.type === 'text') paths.push(...filePathMentions(node.value).filter(mention => isKnownFileMention(mention.path)))
      else if ('children' in node) visit(node.children as RootContent[])
    }
  }
  visit(document.children)
  replyPaths.set(row, paths)
  return paths
}

/** Volunteer rendered documents first, then only text the agent changed. */
export function newestPaneFilePath(
  rows: readonly NestedTranscriptRow[],
  order?: readonly string[],
  transitions?: SessionDescriptor['contextTransitions'],
): string | null {
  let rendered: string | null = null
  let writtenText: string | null = null
  const ordered = orderedPaneRows(rows, order)
  const scopes = transcriptFileScopes(ordered, transitions)
  for (const row of ordered) {
    const paths = row.kind === 'assistant-text' ? pathsInReply(row).filter(mention => mention.strength === 'strong').map(mention => mention.path)
      : row.kind === 'tool-use' ? [...new Set([
          ...paneCardPaths(row), toolCardFilePath(row), row.result?.generatedImage?.filePath,
        ].filter((path): path is string => typeof path === 'string' && isPaneFilePath(path)))] : []
    for (const path of paths) {
      const kind = filePreviewKind(path)
      if (!kind) continue
      const scoped = scopedTranscriptFilePath(path, scopes.get(row.id))
      if (kind !== 'text') rendered = scoped
      else if (row.kind === 'tool-use' && (row.toolFamily === 'write' || row.toolFamily === 'edit')) writtenText = scoped
    }
  }
  return rendered ?? writtenText
}

export type PaneFileGroup = 'Opened' | 'Changed' | 'Mentioned' | 'Read'
export type PaneFileEntry = {
  key: string
  path: string
  filename: string
  parent: string
  group: PaneFileGroup
  external: boolean
  searchOnly: boolean
  availabilityPath: string | null
  weak?: boolean
}

/** Build only for an open chooser; settled reply parsing is cached by row identity. */
export function paneFileIndex(input: {
  rows: readonly NestedTranscriptRow[]
  cwd: string | null
  opened?: OpenedPaneFiles
  order?: readonly string[]
  transitions?: SessionDescriptor['contextTransitions']
  available?: (path: string) => boolean | undefined
  includeUnconfirmed?: boolean
}): PaneFileEntry[] {
  const { rows, cwd, opened = new Map(), order, transitions, available } = input
  const ordered = orderedPaneRows(rows, order)
  const scopes = transcriptFileScopes(ordered, transitions)
  const aliases = new Map<string, string>()
  for (const [key, entry] of opened) for (const alias of entry.aliases) aliases.set(alias, key)
  const entries = new Map<string, PaneFileEntry>()
  const rowScope = (id: string) => scopes.get(id) ?? (transitions?.length ? null : cwd)
  const add = (path: string, scope: string | null, group: PaneFileGroup, searchOnly = false, weak = false) => {
    if (!isKnownFileMention(path)) return
    const openingPath = scopedTranscriptFilePath(path, scope ?? undefined)
    const availabilityPath = scope || /^(?:\/|~\/|file:|[A-Za-z]:[\\/])/.test(openingPath) ? paneFileKey(openingPath) : null
    const known = availabilityPath ? available?.(availabilityPath) : undefined
    if (weak && known !== true && !input.includeUnconfirmed || group === 'Mentioned' && known === false) return
    const lexicalKey = paneFileKey(path, scope)
    const key = aliases.get(lexicalKey) ?? lexicalKey
    if (entries.has(key)) return
    const clean = path.replace(/:\d+(?::\d+)?$/, '')
    const slash = clean.lastIndexOf('/')
    entries.set(key, { key, path: openingPath, filename: clean.slice(slash + 1), parent: clean.slice(0, Math.max(0, slash)), group,
      external: filePreviewKind(path) === null, searchOnly, availabilityPath, ...(weak ? { weak: true } : {}) })
  }
  const openedRows = [...opened.values()].reverse()
  for (const entry of openedRows.slice(0, 5)) add(entry.path, null, 'Opened')
  for (const row of [...ordered].reverse()) {
    if (row.kind !== 'tool-use' || row.toolFamily !== 'write' && row.toolFamily !== 'edit' && row.toolFamily !== 'imagegen') continue
    const path = toolCardFilePath(row)
    const paths = [...new Set([path, ...(row.result?.fileDiffs?.map(diff => diff.filePath) ?? []), row.result?.generatedImage?.filePath].filter((path): path is string => !!path))]
    for (const target of paths) add(target, rowScope(row.id), 'Changed')
  }
  for (const row of [...ordered].reverse()) if (row.kind === 'assistant-text') {
    for (const mention of [...pathsInReply(row)].reverse()) add(mention.path, rowScope(row.id), 'Mentioned', false, mention.strength === 'weak')
  }
  for (const row of [...ordered].reverse()) if (row.kind === 'tool-use' && row.toolFamily === 'read') {
    const path = toolCardFilePath(row)
    if (path) add(path, rowScope(row.id), 'Read', true)
  }
  for (const entry of openedRows.slice(5)) add(entry.path, null, 'Opened', true)
  return [...entries.values()]
}

export function selectedTextInside(element: Element): boolean {
  const selection = element.ownerDocument.defaultView?.getSelection()
  return !!selection && !selection.isCollapsed && selection.toString().length > 0 &&
    ((selection.anchorNode !== null && element.contains(selection.anchorNode)) ||
      (selection.focusNode !== null && element.contains(selection.focusNode)))
}
