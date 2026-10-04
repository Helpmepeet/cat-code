import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { unified } from 'unified'
import type { Element, ElementContent, Root } from 'hast'
import type { PluggableList } from 'unified'

const highlightProcessor = unified().use(rehypeHighlight, {
  detect: false,
  ignoreMissing: true,
})
const highlightedCode = new Map<string, {
  children: ElementContent[]
  className: string[] | undefined
  characters: number
}>()
let highlightedCharacters = 0
const MAX_CACHED_HIGHLIGHTED_BLOCKS = 32
const MAX_CACHED_HIGHLIGHTED_CHARACTERS = 256_000
const MAX_HIGHLIGHT_CACHE_ENTRY_CHARACTERS = 16_000

/** Reuses syntax trees for settled fences while the full Markdown document is re-parsed. */
function rehypeHighlightCached() {
  return (tree: Root) => {
    const visit = (node: Root | Element): void => {
      if (node.type === 'element' && node.tagName === 'pre') {
        for (const child of node.children) {
          if (child.type === 'element' && child.tagName === 'code') highlightCode(child)
        }
        return
      }
      if (node.type !== 'root' && node.type !== 'element') return
      for (const child of node.children) {
          if (child.type === 'element') visit(child)
      }
    }
    visit(tree)
  }
}

function highlightCode(code: Element): void {
  const source = hastText(code)
  if (source.length > MAX_HIGHLIGHT_CACHE_ENTRY_CHARACTERS) {
    runHighlighter(code)
    return
  }
  const language = Array.isArray(code.properties.className)
    ? code.properties.className.join(' ')
    : ''
  const key = `${language}\0${source}`
  const cached = highlightedCode.get(key)
  if (cached) {
    highlightedCode.delete(key)
    highlightedCode.set(key, cached)
    code.children = cloneHastChildren(cached.children)
    if (cached.className !== undefined) {
      code.properties = { ...code.properties, className: [...cached.className] }
    }
    return
  }
  runHighlighter(code)
  const characters = source.length
  const children = cloneHastChildren(code.children)
  const className = Array.isArray(code.properties.className)
    ? code.properties.className.filter((value): value is string => typeof value === 'string')
    : undefined
  highlightedCode.set(key, { children, className, characters })
  highlightedCharacters += characters
  while (
    highlightedCode.size > MAX_CACHED_HIGHLIGHTED_BLOCKS ||
    highlightedCharacters > MAX_CACHED_HIGHLIGHTED_CHARACTERS
  ) {
    const oldest = highlightedCode.keys().next().value as string | undefined
    if (oldest === undefined) break
    const removed = highlightedCode.get(oldest)
    highlightedCode.delete(oldest)
    highlightedCharacters -= removed?.characters ?? 0
  }
}

function runHighlighter(code: Element): void {
  const input: Root = {
    type: 'root',
    children: [{
      type: 'element',
      tagName: 'pre',
      properties: {},
      children: [{ ...code, children: cloneHastChildren(code.children) }],
    }],
  }
  const output = highlightProcessor.runSync(input)
  const pre = (output as Root).children[0]
  const highlighted = pre?.type === 'element' ? pre.children[0] : undefined
  if (highlighted?.type === 'element' && highlighted.tagName === 'code') {
    code.children = highlighted.children
    if (Array.isArray(highlighted.properties.className)) {
      code.properties = {
        ...code.properties,
        className: highlighted.properties.className.filter((value): value is string => typeof value === 'string'),
      }
    }
  }
}

function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return ''
  return node.children.map(hastText).join('')
}

function cloneHastChildren(children: readonly ElementContent[]): ElementContent[] {
  return children.map(child => child.type === 'element'
    ? { ...child, properties: { ...child.properties }, children: cloneHastChildren(child.children) }
    : { ...child })
}

// Shared transcript/preview syntax highlighting. `detect:false` colors only
// explicitly-languaged fences; `ignoreMissing:true` leaves unknown languages as
// plain text instead of throwing during renderer or SSR rendering.
export const REHYPE_PLUGINS: PluggableList = [
  rehypeHighlightCached,
]

/**
 * Ordinary transcript messages add KaTeX after syntax highlighting. KaTeX
 * receives text parsed by `remark-math`, never raw HTML; `trust:false` keeps
 * commands that can author links or external resources disabled.
 */
export const TRANSCRIPT_REHYPE_PLUGINS: PluggableList = [
  ...REHYPE_PLUGINS,
  [
    rehypeKatex,
    {
      trust: false,
      strict: 'ignore',
      maxExpand: 1_000,
      maxSize: 50,
    },
  ],
]
