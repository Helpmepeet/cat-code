import type { ElementContent, Root, RootContent, Text } from 'hast'

const FILE_PATH_RE =
  /(?:(?:\/|(?:\.{1,2}\/)|(?:[A-Za-z0-9_@.+-]+\/))(?:[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+|[A-Za-z_@.][A-Za-z0-9_@.+-]*)\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/g
const WEB_PATH_RE =
  /^(?:www\.|(?:[A-Za-z0-9-]+\.)+(?:(?:com|org|net|io|dev|app|ai|co|edu|gov|me|xyz)(?:[/:]|$)|[A-Za-z]{2,}\/))/i

// Digits-only extensions are version numbers, not file references.
function hasLetteredExtension(path: string): boolean {
  return /[A-Za-z]/.test(path.slice(path.lastIndexOf('.') + 1))
}

export function isInlineFilePath(path: string): boolean {
  return (
    path.length > 0 && path.length <= 4_096 && path === path.trim() &&
    !path.includes('\n') && !path.includes('\0') &&
    !WEB_PATH_RE.test(path) && hasLetteredExtension(path) &&
    /(?:^|\/)[^/]+\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(path)
  )
}

/** Host owns containment and source-location resolution, not this display classifier. */
export function workspaceFileHref(href: string | undefined): string | null {
  if (href === undefined || href.length === 0) return null
  if (href.startsWith('#') || href.startsWith('//')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) return null
  const path = href.replace(/[?#].*$/, '')
  if (path.length === 0) return null
  try {
    return decodeURIComponent(path.replace(/%(?![\da-f]{2})/gi, '%25'))
  } catch {
    return path
  }
}

/** Undefined is still ambiguous; null is an outside address, as for settled links. */
export function pendingFileHref(destination: string, href: string | undefined): string | null | undefined {
  const prefix = destination.startsWith('<') ? destination.slice(1) : destination
  if (prefix === '' || prefix === '/' || /^[A-Za-z][A-Za-z0-9+.-]*$/.test(prefix)) return undefined
  return workspaceFileHref(href)
}

function sliceText(node: Text, start: number, end: number): Text {
  const value = node.value.slice(start, end)
  const origin = node.position?.start
  if (origin?.offset === undefined) return { type: 'text', value }
  const point = (index: number) => {
    const prefix = node.value.slice(0, index)
    const lines = prefix.split('\n')
    return {
      line: origin.line + lines.length - 1,
      column: lines.length === 1 ? origin.column + index : lines[lines.length - 1]!.length + 1,
      offset: origin.offset! + index,
    }
  }
  return { type: 'text', value, position: { start: point(start), end: point(end) } }
}

function linkifyText(node: Text): ElementContent[] {
  const out: ElementContent[] = []
  let cursor = 0
  for (const match of node.value.matchAll(FILE_PATH_RE)) {
    const path = match[0]
    const index = match.index
    if (
      node.value.slice(0, index).endsWith(':/') || path.startsWith('//') ||
      WEB_PATH_RE.test(path) || !hasLetteredExtension(path)
    ) continue
    if (index > cursor) out.push(sliceText(node, cursor, index))
    const text = sliceText(node, index, index + path.length)
    out.push({
      type: 'element', tagName: 'a',
      properties: { href: path, dataBareFilePath: true },
      children: [text], position: text.position,
    })
    cursor = index + path.length
  }
  if (cursor === 0) return [node]
  if (cursor < node.value.length) out.push(sliceText(node, cursor, node.value.length))
  return out
}

/** Match complete parsed text before arrival marking can split a path into spans. */
export function linkifyFilePathTree(tree: Root): Root {
  const visit = <T extends RootContent | ElementContent>(nodes: readonly T[], inProse: boolean): T[] =>
    nodes.flatMap(node => {
      if (node.type === 'text') return (inProse ? linkifyText(node) : [node]) as T[]
      if (node.type !== 'element' ||
        ['a', 'button', 'code', 'pre'].includes(node.tagName) || node.properties.dataPendingLabel) return [node]
      return [{ ...node, children: visit(node.children, inProse || node.tagName === 'p' || node.tagName === 'li') } as T]
    })
  return { ...tree, children: visit(tree.children, false) }
}
