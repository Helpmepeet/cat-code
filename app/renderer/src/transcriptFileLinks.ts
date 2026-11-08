import type { ElementContent, Root, RootContent, Text } from 'hast'
import { stripLineSuffix } from './filePathActions.js'
import { FILE_PREVIEW_KNOWN_NAMES, isKnownFileMention, normalizeLocalhostPreviewUrl } from '../../shared/filePreview.js'
import { localFileUrlPath } from '../../shared/localFileUrl.js'

const PATH_SEGMENT = String.raw`(?:[A-Za-z0-9_@.+-]+|\([A-Za-z0-9_@.+-]+\)|\[(?:\.\.\.)?[A-Za-z0-9_@.+-]+\])`
const KNOWN_NAME_RE = FILE_PREVIEW_KNOWN_NAMES.map(name => name.replace(/[^A-Za-z0-9_]/g, '\\$&')).join('|')
const FILE_PATH_RE = new RegExp(
  String.raw`^(?:~/|/|\.{1,2}/)?(?:${PATH_SEGMENT}/)*(?:(?:\[(?:\.\.\.)?[A-Za-z0-9_@.+-]+\]|[A-Za-z0-9_@.+-]+)\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|${KNOWN_NAME_RE})(?::\d+(?::\d+)?)?$`,
)
const WEB_PATH_RE =
  /^(?:www\.|(?:[A-Za-z0-9-]+\.)+(?:(?:com|org|net|io|dev|app|ai|co|edu|gov|me|xyz)(?:[/:]|$)|[A-Za-z]{2,}\/))/i

// Digits-only extensions are version numbers, not file references.
function hasLetteredExtension(path: string): boolean {
  return /[A-Za-z]/.test(path.slice(path.lastIndexOf('.') + 1))
}

export function isInlineFilePath(rawPath: string): boolean {
  if (/^file:/i.test(rawPath)) return localFileUrlPath(rawPath) !== null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawPath)) return false
  const path = stripLineSuffix(rawPath)
  return (
    path.length > 0 && path.length <= 4_096 && path === path.trim() &&
    !path.includes('\n') && !path.includes('\0') &&
    !WEB_PATH_RE.test(path) && (
      (FILE_PREVIEW_KNOWN_NAMES as readonly string[]).includes(path.split('/').at(-1)!) || hasLetteredExtension(path) &&
      /(?:^|\/)[^/]+\.[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(path)
    )
  )
}

/** Host owns containment and source-location resolution, not this display classifier. */
export function workspaceFileHref(href: string | undefined): string | null {
  if (href === undefined || href.length === 0) return null
  if (/^file:/i.test(href)) return localFileUrlPath(href)
  if (href.startsWith('#') || href.startsWith('//')) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(isInlineFilePath(href) ? stripLineSuffix(href) : href)) return null
  const path = href.replace(/[?#].*$/, '')
  if (path.length === 0) return null
  try {
    return decodeURIComponent(path.replace(/%(?![\da-f]{2})/gi, '%25'))
  } catch {
    return path
  }
}

/** Only a failed literal lookup may use this repair; Unicode filenames stay literal. */
export function recoverAbsoluteFileLinkPath(path: string): string | null {
  return /^\u200c\/(?!\/)/.test(path) ? path.slice(1) : null
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

/** Markdown encodes brackets in IPv6 link destinations before rendering. */
export function localhostMarkdownHref(href: string | undefined): string | null {
  return normalizeLocalhostPreviewUrl(href?.replace(/^http:\/\/%5B::1%5D(?=[:/?#]|$)/i, 'http://[::1]'))
}

type HttpTextLink = { index: number; text: string; localhost: string | null }
function trimProseUrlToken(value: string): string {
  let token = value.replace(/[.,;]+$/, '')
  while (/[)\]}]$/.test(token)) {
    const close = token.at(-1)!
    const open = close === ')' ? '(' : close === ']' ? '[' : '{'
    if (token.split(close).length <= token.split(open).length) break
    token = token.slice(0, -1)
  }
  return token
}

function httpTextLinks(text: string): HttpTextLink[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)].map(match => {
    const token = trimProseUrlToken(match[0])
    return { index: match.index, text: token, localhost: normalizeLocalhostPreviewUrl(token) }
  })
}

type FilePathMatch = { 0: string; index: number }
function filePathMatches(text: string): FilePathMatch[] {
  const paths: FilePathMatch[] = []
  // Bound regex work to a single admissible path, rather than restarting a
  // backtracking path grammar at every character in an unbounded prose token.
  for (const token of text.matchAll(/[^\s<>"'`]+/g)) {
    if (token[0].length > 4_096) continue
    let path = trimProseUrlToken(token[0])
    let index = token.index
    const prefix = /^[([{]+/.exec(path)?.[0]
    if (prefix && !FILE_PATH_RE.test(path)) {
      path = trimProseUrlToken(path.slice(prefix.length))
      index += prefix.length
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) {
      if (localFileUrlPath(path) !== null) paths.push({ 0: path, index })
      continue
    }
    if (!FILE_PATH_RE.test(path)) {
      const label = /^[A-Za-z][A-Za-z0-9_-]*:/.exec(path)?.[0]
      if (label) { path = path.slice(label.length); index += label.length }
    }
    if (!path.includes('.') && !(FILE_PREVIEW_KNOWN_NAMES as readonly string[]).some(name => path.endsWith(`/${name}`))) continue
    if (!FILE_PATH_RE.test(path) || path.startsWith('//') || WEB_PATH_RE.test(path)) continue
    const strong = path.includes('/') || /:\d+(?::\d+)?$/.test(path)
    const clean = stripLineSuffix(path)
    if (!strong && (!isKnownFileMention(path) || (FILE_PREVIEW_KNOWN_NAMES as readonly string[]).includes(clean) ||
      clean.split('.').every(part => /^[A-Za-z]$/.test(part)))) continue
    paths.push({ 0: path, index })
  }
  return paths
}

export type FilePathMention = { path: string; strength: 'strong' | 'weak' }
export function filePathMentions(text: string): FilePathMention[] {
  return filePathMatches(text).map(match => ({ path: match[0],
    strength: match[0].includes('/') || /:\d+(?::\d+)?$/.test(match[0]) || /^file:/i.test(match[0]) ? 'strong' : 'weak' }))
}
export function bareFilePaths(text: string): string[] { return filePathMentions(text).map(mention => mention.path) }
export function strongFilePaths(text: string): string[] {
  return filePathMentions(text).filter(mention => mention.strength === 'strong').map(mention => mention.path)
}

/** Discover only addresses actually reported by this tool's output. */
export function firstLocalhostUrlInOutput(output: string): string | null {
  const plain = output
    .replace(/(?:\u001B\]|\u009D)[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)/g, '')
    .replace(/\u001B\[[0-9;:?]*[\u0020-\u002F]*[\u0040-\u007E]/g, '')
  return httpTextLinks(plain).find(link => link.localhost !== null)?.localhost ?? null
}

function linkifyText(node: Text): ElementContent[] {
  const out: ElementContent[] = []
  let cursor = 0
  const links = [
    ...filePathMatches(node.value).map(match => ({ index: match.index, text: match[0], href: match[0], file: true, weak: !match[0].includes('/') && !/:\d+(?::\d+)?$/.test(match[0]) })),
    ...httpTextLinks(node.value).filter(link => link.localhost !== null).map(link => ({ ...link, href: link.localhost!, file: false, weak: false })),
  ].sort((left, right) => left.index - right.index)
  for (const link of links) {
    if (link.index > cursor) out.push(sliceText(node, cursor, link.index))
    const text = sliceText(node, link.index, link.index + link.text.length)
    out.push({ type: 'element', tagName: 'a',
      properties: { href: link.href, ...(link.file ? { dataBareFilePath: true, ...(link.weak ? { dataWeakFilePath: true } : {}) } : {}) },
      children: [text], position: text.position })
    cursor = link.index + link.text.length
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
