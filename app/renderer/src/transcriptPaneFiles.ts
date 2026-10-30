import { createContext } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { RootContent } from 'mdast'
import type { NestedTranscriptRow, NestedToolUseRow } from './transcriptProjector.js'
import { bareFilePaths, isInlineFilePath, workspaceFileHref } from './transcriptFileLinks.js'
import { resolveFilePathParts } from './filePathActions.js'
import { isPaneFilePath } from './filePaneState.js'
import { toolCardFilePath } from './transcriptToolTarget.js'

export const LatestPaneFileCardContext = createContext<ReadonlyMap<string, string> | null>(null)

export function paneFileKey(path: string, cwd: string | null): string {
  const parts = resolveFilePathParts({ rawPath: path, cwd })
  const resolved = (parts.absolutePath ?? parts.cleanPath).replace(/:\d+(?::\d+)?$/, '')
  const windows = /^[A-Za-z]:[\\/]/.test(resolved)
  const rooted = windows || resolved.startsWith('/')
  const prefix = windows ? resolved.slice(0, 2) : rooted ? '/' : ''
  const normalized: string[] = []
  for (const part of resolved.slice(windows ? 2 : 0).split(windows ? /[\\/]+/ : /\/+/)) {
    if (!part || part === '.') continue
    if (part === '..' && normalized.length && normalized.at(-1) !== '..') normalized.pop()
    else if (part !== '..' || !rooted) normalized.push(part)
  }
  return `${prefix}${windows ? '/' : ''}${normalized.join('/')}`
}

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

export function latestPaneFileCards(rows: readonly NestedTranscriptRow[], cwd: string | null, order?: readonly string[]): ReadonlyMap<string, string> {
  const latest = new Map<string, string>()
  for (const row of orderedPaneRows(rows, order)) {
    if (row.kind === 'tool-use') for (const path of paneCardPaths(row)) latest.set(paneFileKey(path, cwd), row.id)
  }
  return latest
}

const parser = unified().use(remarkParse)
const replyPaths = new WeakMap<object, string[]>()

function pathsInReply(row: Extract<NestedTranscriptRow, {kind: 'assistant-text'}>): string[] {
  const cached = replyPaths.get(row)
  if (cached) return cached
  const paths: string[] = []
  const document = parser.parse(row.content)
  const definitions = new Map(document.children.filter(node => node.type === 'definition').map(node => [node.identifier.toLowerCase(), node.url]))
  const visit = (nodes: readonly RootContent[]) => {
    for (const node of nodes) {
      if (node.type === 'link') {
        const path = workspaceFileHref(node.url)
        if (path !== null && isPaneFilePath(path)) paths.push(path)
      } else if (node.type === 'linkReference') {
        const path = workspaceFileHref(definitions.get(node.identifier.toLowerCase()))
        if (path !== null && isPaneFilePath(path)) paths.push(path)
      } else if (node.type === 'inlineCode') {
        if (workspaceFileHref(node.value) !== null && isInlineFilePath(node.value) && isPaneFilePath(node.value)) paths.push(node.value)
      } else if (node.type === 'text') {
        paths.push(...bareFilePaths(node.value).filter(isPaneFilePath))
      } else if ('children' in node) visit(node.children as RootContent[])
    }
  }
  visit(document.children)
  replyPaths.set(row, paths)
  return paths
}

/** Read-time discovery only. Resolving or opening still requires the user's action. */
export function newestPaneFilePath(rows: readonly NestedTranscriptRow[], order?: readonly string[]): string | null {
  let newest: string | null = null
  for (const row of orderedPaneRows(rows, order)) {
    const paths = row.kind === 'assistant-text' ? pathsInReply(row)
      : row.kind === 'tool-use' ? [...new Set([
          ...paneCardPaths(row),
          toolCardFilePath(row),
          row.result?.generatedImage?.filePath,
        ].filter((path): path is string => typeof path === 'string' && isPaneFilePath(path)))] : []
    if (paths.length) newest = paths[paths.length - 1]!
  }
  return newest
}

export function selectedTextInside(element: Element): boolean {
  const selection = element.ownerDocument.defaultView?.getSelection()
  return !!selection && !selection.isCollapsed && selection.toString().length > 0 &&
    ((selection.anchorNode !== null && element.contains(selection.anchorNode)) ||
      (selection.focusNode !== null && element.contains(selection.focusNode)))
}
