/**
 * Bounded Markdown rendering plan.
 *
 * The whole source is parsed ONCE into a single hast document, and the plan
 * then slices that ONE tree into leaves. Every leaf keeps the chain of semantic
 * ancestors it was cut out of, so a mounted range still renders a table with its
 * header row, a list with correct numbering and nesting, a blockquote with its
 * border, and a code fence as one card. Reference-link definitions resolve
 * because the definition and its use were parsed together, not as two
 * independent documents.
 *
 * Bounding is about MOUNTED DOM only. The authoritative source string and the
 * parsed tree stay in JavaScript state at full fidelity.
 */
import type { Element, ElementContent, Root, RootContent } from 'hast'
import type { Root as MdastRoot } from 'mdast'
import type { ReactNode } from 'react'
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified, type PluggableList } from 'unified'

/** Line ceiling for one mounted leaf. */
export const MAX_MARKDOWN_LEAF_LINES = 200
/** Character ceiling for one mounted leaf. */
export const MAX_MARKDOWN_LEAF_CHARACTERS = 12_000
/** Mounted-children ceiling for one semantic parent's leaf. */
export const MAX_MARKDOWN_LEAF_CHILDREN = 200
/**
 * Element ceiling for one mounted leaf.
 *
 * Lines and characters both measure TEXT, so a child that is element-dense and
 * text-sparse weighed nothing and was buffered whole: fifty thousand empty
 * anchors on one source line produced one leaf and fifty thousand mounted
 * nodes. This is the dimension those inputs are dense in.
 */
export const MAX_MARKDOWN_LEAF_ELEMENTS = 400
/** Leaf ceiling for one mounted window. */
export const MAX_MOUNTED_MARKDOWN_LEAVES = 120
/**
 * Element ceiling for one mounted window. Element-dense content can be far
 * shorter than it is expensive, so the leaf ceiling alone would still admit
 * `MAX_MOUNTED_MARKDOWN_LEAVES` dense leaves into a viewport that estimates
 * them at one row each.
 */
export const MAX_MOUNTED_MARKDOWN_ELEMENTS = 4_000
/**
 * Retained-ancestor ceiling. A linear nesting chain cannot be windowed at all,
 * because every one of its levels is an ancestor of the content: five thousand
 * nested blockquotes are five thousand mounted nodes however the body is cut.
 * Past this depth the tail is truncated instead of retained.
 */
export const MAX_MARKDOWN_WRAPPER_DEPTH = 24
/**
 * Element ceiling for a retained wrapper's sticky prefix. The prefix re-mounts
 * with every unit that shows any part of its parent, so a table with ten
 * thousand header cells charged them to every window.
 */
export const MAX_MARKDOWN_WRAPPER_PREFIX_ELEMENTS = 200
/**
 * Retained measured runs. A key names a contiguous RUN of leaves, so scrolling
 * one group mints a new key per distinct run the window ever framed: pruning
 * drops runs whose content changed, but an unchanged group keeps every run it
 * has ever shown, which is quadratic in its leaf count.
 */
export const MAX_RETAINED_MARKDOWN_MEASUREMENTS = MAX_MOUNTED_MARKDOWN_LEAVES * 3

export type MarkdownLeafKind = 'block' | 'code' | 'atomic-text'

/** Tag-name to component overrides, applied to every mounted range alike. */
export type MarkdownComponents = Components

/**
 * One retained semantic ancestor. `prefix` holds children that must stay with
 * every chunk of the parent rather than being windowed away, which is how a
 * table body keeps its `<thead>` at any scroll position.
 */
export type MarkdownLeafWrapper = {
  /**
   * Tree path of the element this wrapper was cut from. Two leaves are inside
   * the SAME wrapper when the ids match, which survives the cloning
   * `withOrderedStart` does to carry an ordered list's running number.
   */
  id: string
  element: Element
  prefix: readonly ElementContent[]
}

export type MarkdownRenderLeaf = {
  id: string
  /** Consecutive leaves sharing this render inside ONE semantic wrapper. */
  groupId: string
  /**
   * The outermost retained wrapper's group, or `groupId` when nothing is
   * retained. Leaves of one top-level container share it however deeply the
   * container was recursed into, which is what folds a table whose body was
   * interrupted by an oversized row back into ONE table.
   */
  unitId: string
  kind: MarkdownLeafKind
  wrappers: readonly MarkdownLeafWrapper[]
  children: readonly ElementContent[]
  /** Disclosed plain-text chunk; empty for every kind but `atomic-text`. */
  text: string
  /** Complete fence source for the group's single copy action. */
  codeSource: string
  codeLanguage: string
  /**
   * True while this leaf's fence has opened but not closed. The card is up
   * from the opening delimiter on, so its copy action has to say that what it
   * would copy is not finished yet.
   */
  codeOpen: boolean
  /** Content revision. Never part of a React key. */
  characters: number
  lines: number
  /** Upper bound on this leaf's mounted elements, retained ancestors included. */
  elements: number
  estimatedHeight: number
}

/** A merged run of consecutive same-group leaves: what actually mounts. */
export type MountedMarkdownLeaf = {
  /** React key: source identity plus semantic kind, no content revision. */
  key: string
  /** Height-cache key: identity AND content revision. */
  measurementKey: string
  kind: MarkdownLeafKind
  /** Ready to render, semantic ancestors applied. */
  tree: Root
  /** The mounted children alone, without the retained ancestors. */
  content: Root
  text: string
  codeSource: string
  codeLanguage: string
  codeOpen: boolean
}

export type MarkdownLeafWindow = {
  start: number
  end: number
  topSpacerHeight: number
  bottomSpacerHeight: number
}

/**
 * Holds the hast of the settled prefix while a fence is still open, so a
 * streamed token does not reparse blocks that can no longer change. Owned by
 * the mounted body, so nothing survives its unmount.
 */
export type MarkdownPlanCache = {
  current: {
    body: string
    tree: Root
    recognizeCallouts: boolean
  } | null
}

export function createMarkdownPlanCache(): MarkdownPlanCache {
  return { current: null }
}

const NO_PLUGINS: PluggableList = []
const processors = new WeakMap<PluggableList, ReturnType<typeof buildProcessor>>()

function buildProcessor(rehypePlugins: PluggableList) {
  // Same shape react-markdown builds: raw HTML is admitted as `raw` nodes here
  // and demoted to literal text below, which is what keeps HTML disabled while
  // still showing the author what they wrote.
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
}

function markdownProcessor(rehypePlugins: PluggableList) {
  const cached = processors.get(rehypePlugins)
  if (cached !== undefined) return cached
  const created = buildProcessor(rehypePlugins)
  processors.set(rehypePlugins, created)
  return created
}

/**
 * Parses the complete source once and cuts the resulting document into bounded
 * leaves.
 */
export function planMarkdownLeaves(
  sourceId: string,
  source: string,
  options?: {
    rehypePlugins?: PluggableList
    cache?: MarkdownPlanCache
    recognizeCallouts?: boolean
  },
): MarkdownRenderLeaf[] {
  const processor = markdownProcessor(options?.rehypePlugins ?? NO_PLUGINS)
  const recognizeCallouts = options?.recognizeCallouts ?? false
  const cached = options?.cache?.current

  let tree: Root
  let tailOffset: number | null

  // Fast path while a fence is open. The cached body ends exactly at that
  // fence, so the remainder can be read on its own: if it is still nothing but
  // an unterminated fence, no settled block can have changed and the parsed
  // prefix stands. Every other case reparses the whole document.
  const appendedToOpenFence =
    cached !== null &&
    cached !== undefined &&
    cached.recognizeCallouts === recognizeCallouts &&
    source.length > cached.body.length &&
    source.startsWith(cached.body) &&
    isWholeUnterminatedFence(processor, source.slice(cached.body.length))

  if (appendedToOpenFence) {
    tree = cached.tree
    tailOffset = cached.body.length
  } else {
    const mdast = processor.parse(source)
    tailOffset = findUnterminatedFence(mdast, source)
    const body = tailOffset === null ? source : source.slice(0, tailOffset)
    if (
      cached !== null &&
      cached !== undefined &&
      cached.body === body &&
      cached.recognizeCallouts === recognizeCallouts
    ) {
      tree = cached.tree
    } else {
      tree = processor.runSync(body === source ? mdast : processor.parse(body))
      normalizeTree(tree, recognizeCallouts)
    }
    // Only a settled prefix is worth holding: while a fence is open the body is
    // constant across tokens, and the entry is replaced outright on settlement.
    if (options?.cache !== undefined) {
      options.cache.current =
        tailOffset === null ? null : { body, tree, recognizeCallouts }
    }
  }

  const state: PlanState = { sourceId, leaves: [] }
  const roots: ElementContent[] = []
  for (const child of tree.children) {
    if (child.type !== 'doctype') roots.push(child)
  }
  planChildren(roots, [], '', state)

  if (tailOffset !== null) {
    planOpenFence(source.slice(tailOffset), 'tail', state)
  }

  return state.leaves
}

/**
 * Bounded plain-text leaves for a document the parser could not read at all, so
 * its author still sees the text they wrote.
 */
export function planPlainTextLeaves(
  sourceId: string,
  source: string,
): MarkdownRenderLeaf[] {
  const state: PlanState = { sourceId, leaves: [] }
  planPlainText(source, 'text', state)
  return state.leaves
}

function planPlainText(value: string, path: string, state: PlanState): void {
  const wrapper: MarkdownLeafWrapper = {
    id: `${path}#text`,
    element: {
      type: 'element',
      tagName: 'div',
      properties: {
        className: [
          'whitespace-pre-wrap',
          'break-words',
          'font-mono',
          'text-xs',
          'text-text-muted',
        ],
      },
      children: [],
    },
    prefix: [],
  }
  planChildren([{ type: 'text', value }], [wrapper], path, state)
}

/**
 * Qualifies a measured height by mounted identity and content revision
 * together. A streamed leaf keeps its id while its content grows, so an id-only
 * key would retain a height measured for shorter content.
 */
export function markdownMeasurementKey(leaf: MarkdownRenderLeaf): string {
  return markdownUnitKey([leaf])
}

function markdownUnitKey(members: readonly MarkdownRenderLeaf[]): string {
  let characters = 0
  for (const member of members) characters += member.characters
  return `${members[0].id}#${members.length}#${characters}`
}

/**
 * Resolves heights measured against merged mounted units back onto the plan's
 * individual leaves, and reports which cache entries still describe a run that
 * exists in the current plan. Everything else has left the plan and is pruned.
 */
export function resolveMarkdownMeasurements(
  leaves: readonly MarkdownRenderLeaf[],
  unitHeights: ReadonlyMap<string, number>,
): { heights: Map<string, number>; live: Set<string> } {
  const heights = new Map<string, number>()
  const live = new Set<string>()
  if (unitHeights.size === 0) return { heights, live }

  const positions = new Map<string, number>()
  for (let index = 0; index < leaves.length; index += 1) {
    positions.set(leaves[index].id, index)
  }

  for (const [key, height] of unitHeights) {
    const decoded = decodeUnitKey(key)
    if (decoded === null) continue
    const start = positions.get(decoded.id)
    if (start === undefined) continue
    const end = start + decoded.count
    if (end > leaves.length) continue

    let characters = 0
    let estimated = 0
    let sameUnit = true
    for (let index = start; index < end; index += 1) {
      const leaf = leaves[index]
      if (leaf.unitId !== leaves[start].unitId) sameUnit = false
      characters += leaf.characters
      estimated += leaf.estimatedHeight
    }
    if (!sameUnit || characters !== decoded.characters) continue

    live.add(key)
    const total = estimated > 0 ? estimated : 1
    for (let index = start; index < end; index += 1) {
      const leaf = leaves[index]
      heights.set(leaf.id, Math.max(1, Math.round((height * leaf.estimatedHeight) / total)))
    }
  }

  return { heights, live }
}

function decodeUnitKey(
  key: string,
): { id: string; count: number; characters: number } | null {
  const second = key.lastIndexOf('#')
  if (second <= 0) return null
  const first = key.lastIndexOf('#', second - 1)
  if (first <= 0) return null
  const count = Number(key.slice(first + 1, second))
  const characters = Number(key.slice(second + 1))
  if (!Number.isInteger(count) || count < 1) return null
  if (!Number.isInteger(characters) || characters < 0) return null
  return { id: key.slice(0, first), count, characters }
}

/**
 * Selects a bounded range using estimated leaf heights. Browser measurement can
 * replace the estimates without changing the leaf identities.
 */
export function selectMarkdownLeafWindow(
  leaves: readonly MarkdownRenderLeaf[],
  scrollOffset: number,
  viewportHeight: number,
  overscan: number = 800,
  maxMountedLeaves: number = MAX_MOUNTED_MARKDOWN_LEAVES,
): MarkdownLeafWindow {
  if (leaves.length === 0) {
    return { start: 0, end: 0, topSpacerHeight: 0, bottomSpacerHeight: 0 }
  }

  const startOffset = Math.max(0, scrollOffset - overscan)
  const endOffset = Math.max(startOffset, scrollOffset + viewportHeight + overscan)
  let offset = 0
  let start = 0
  while (start < leaves.length && offset + leaves[start].estimatedHeight < startOffset) {
    offset += leaves[start].estimatedHeight
    start += 1
  }

  let end = start
  let covered = offset
  let elements = 0
  while (end < leaves.length && covered < endOffset && end - start < maxMountedLeaves) {
    // Element-dense content is charged nothing by the height estimate, so the
    // leaf count alone would let a viewport's worth of one-row leaves mount
    // tens of thousands of nodes.
    if (end > start && elements + leaves[end].elements > MAX_MOUNTED_MARKDOWN_ELEMENTS) break
    covered += leaves[end].estimatedHeight
    elements += leaves[end].elements
    end += 1
  }

  if (end === start) end = Math.min(start + 1, leaves.length)
  const topSpacerHeight = sumHeights(leaves, 0, start)
  const bottomSpacerHeight = sumHeights(leaves, end, leaves.length)
  return { start, end, topSpacerHeight, bottomSpacerHeight }
}

/**
 * Folds the selected range into the units that actually mount. Consecutive
 * leaves of one semantic parent share ONE wrapper, so a windowed fence stays a
 * single card and a windowed table stays a single table.
 */
export function mergeMountedMarkdownLeaves(
  leaves: readonly MarkdownRenderLeaf[],
  start: number,
  end: number,
): MountedMarkdownLeaf[] {
  const units: MountedMarkdownLeaf[] = []
  let index = Math.max(0, start)
  const limit = Math.min(end, leaves.length)

  while (index < limit) {
    const first = leaves[index]
    let last = index
    while (last + 1 < limit && leaves[last + 1].unitId === first.unitId) last += 1

    const members = leaves.slice(index, last + 1)
    const children: ElementContent[] = []
    let text = ''
    for (const member of members) {
      for (const child of member.children) children.push(child)
      text += member.text
    }

    units.push({
      key: first.id,
      measurementKey: markdownUnitKey(members),
      kind: first.kind,
      tree: { type: 'root', children: foldWrappers(members, 0) },
      content: { type: 'root', children },
      text,
      codeSource: first.codeSource,
      codeLanguage: first.codeLanguage,
      codeOpen: first.codeOpen,
    })
    index = last + 1
  }

  return units
}

/** Renders a hast tree through the caller's own component overrides. */
export function renderMarkdownTree(tree: Root, components?: Components): ReactNode {
  return toJsxRuntime(tree, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  })
}

/* ── planning ──────────────────────────────────────────────────────────────── */

type PlanState = { sourceId: string; leaves: MarkdownRenderLeaf[] }

type Weight = { lines: number; characters: number; elements: number }

/**
 * Containers whose inter-child whitespace carries no meaning. Dropping it stops
 * a lone `"\n"` between `<thead>` and `<tbody>` from becoming its own leaf.
 */
const BLOCK_CONTAINERS = new Set([
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'li',
  'ol',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'tr',
  'ul',
])

/**
 * Elements that start their own line. Whitespace between two of these is hast
 * serialization filler; whitespace next to anything else is a word separator.
 */
const BLOCK_LEVEL_TAGS = new Set([
  ...BLOCK_CONTAINERS,
  'dd',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'p',
  'pre',
  'td',
  'th',
])

/** Table parts that belong to every chunk of the body, not to one of them. */
const TABLE_STICKY = new Set(['caption', 'colgroup', 'thead'])

function planChildren(
  children: readonly ElementContent[],
  wrappers: readonly MarkdownLeafWrapper[],
  path: string,
  state: PlanState,
  parentUnitId?: string,
): void {
  const usable = usableChildren(children, wrappers)
  const groupId = `${state.sourceId}:${path === '' ? 'root' : path}`
  // The outermost wrapper's own group names the mounted unit. A recursion that
  // adds the FIRST wrapper starts a new unit; deeper ones inherit it.
  const unitId = parentUnitId ?? groupId
  const nestedUnitId = wrappers.length === 0 ? undefined : unitId
  const wrapperElements = countWrapperElements(wrappers)
  let buffer: ElementContent[] = []
  let bufferLines = 0
  let bufferCharacters = 0
  let bufferElements = 0
  let bufferStart = 0
  let chunkIndex = 0

  const push = (
    leafChildren: readonly ElementContent[],
    firstIndex: number,
    lines: number,
    characters: number,
    elements: number,
  ): void => {
    state.leaves.push({
      id: `${groupId}:${chunkIndex}`,
      groupId,
      unitId,
      kind: 'block',
      wrappers: withOrderedStart(wrappers, usable, firstIndex),
      children: leafChildren,
      text: '',
      codeSource: '',
      codeLanguage: '',
      codeOpen: false,
      characters,
      lines,
      elements: elements + wrapperElements,
      estimatedHeight: estimateHeight(lines, characters),
    })
    chunkIndex += 1
  }

  const flush = (): void => {
    if (buffer.length === 0) return
    push(buffer, bufferStart, bufferLines, bufferCharacters, bufferElements)
    buffer = []
    bufferLines = 0
    bufferCharacters = 0
    bufferElements = 0
  }

  for (let index = 0; index < usable.length; index += 1) {
    const child = usable[index]

    const weight = weigh(child)
    const oversized =
      weight.lines > MAX_MARKDOWN_LEAF_LINES ||
      weight.characters > MAX_MARKDOWN_LEAF_CHARACTERS ||
      weight.elements > MAX_MARKDOWN_LEAF_ELEMENTS

    if (oversized) {
      flush()
      // A fence too long to mount whole becomes its own group, so however many
      // chunks the window takes they fold back into ONE card. A fence that fits
      // stays an ordinary child and keeps rendering through the caller's own
      // `pre`/`code` overrides.
      if (wrappers.length === 0 && isCodeBlock(child)) {
        planCodeBlock(child, wrappers, `${path}/${index}`, state)
        continue
      }
      if (child.type === 'text') {
        for (const slice of sliceBoundedText(child.value)) {
          push([{ type: 'text', value: slice }], index, countBreaks(slice), slice.length, 0)
        }
        continue
      }
      if (child.type === 'element') {
        if (wrappers.length === 0 && !hasElementChild(child)) {
          planAtomicProse(child, `${path}/${index}`, state)
          continue
        }
        // A chain deeper than any reader can follow is dense in nesting rather
        // than in siblings, so recursing one more level would retain a wrapper
        // instead of windowing anything. Mount what fits and stop.
        const exhausted =
          wrappers.length >= MAX_MARKDOWN_WRAPPER_DEPTH &&
          weight.elements > MAX_MARKDOWN_LEAF_ELEMENTS
        if (child.children.length > 0 && !exhausted) {
          const { wrapper, rest } = splitWrapper(child, `${path}/${index}`)
          planChildren(
            rest,
            [...withOrderedStart(wrappers, usable, index), wrapper],
            `${path}/${index}`,
            state,
            nestedUnitId,
          )
          continue
        }
        if (weight.elements > MAX_MARKDOWN_LEAF_ELEMENTS) {
          const bounded = boundElements([child], MAX_MARKDOWN_LEAF_ELEMENTS)
          push(bounded, index, weight.lines, weight.characters, countElementList(bounded))
          continue
        }
      }
      push([child], index, weight.lines, weight.characters, weight.elements)
      continue
    }

    if (
      buffer.length > 0 &&
      (buffer.length + 1 > MAX_MARKDOWN_LEAF_CHILDREN ||
        bufferLines + weight.lines > MAX_MARKDOWN_LEAF_LINES ||
        bufferCharacters + weight.characters > MAX_MARKDOWN_LEAF_CHARACTERS ||
        bufferElements + weight.elements > MAX_MARKDOWN_LEAF_ELEMENTS)
    ) {
      flush()
    }
    if (buffer.length === 0) bufferStart = index
    buffer.push(child)
    bufferLines += weight.lines
    bufferCharacters += weight.characters
    bufferElements += weight.elements
  }

  flush()
}

/**
 * A fence always gets its own group, so however many chunks the window mounts
 * they fold back into ONE card whose copy action carries the whole fence.
 */
function planCodeBlock(
  pre: Element,
  wrappers: readonly MarkdownLeafWrapper[],
  path: string,
  state: PlanState,
): void {
  const code = pre.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  )
  if (code === undefined) return

  const raw = textOf(code)
  const codeSource = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const codeLanguage = languageOf(code)
  const before = state.leaves.length

  planChildren(
    code.children,
    [
      ...wrappers,
      { id: `${path}#pre`, element: { ...pre, children: [] }, prefix: [] },
      { id: `${path}#code`, element: { ...code, children: [] }, prefix: [] },
    ],
    path,
    state,
  )

  for (let index = before; index < state.leaves.length; index += 1) {
    const leaf = state.leaves[index]
    leaf.kind = 'code'
    leaf.codeSource = codeSource
    leaf.codeLanguage = codeLanguage
    if (index === before) leaf.estimatedHeight += 56
  }
}

/**
 * The tail of a fence that has opened but not closed yet. It is planned as the
 * code block it is already becoming, so the card frame arrives with the opening
 * delimiter rather than with the closing one. The delimiter line itself is not
 * body text: its language goes to the card's chip instead.
 *
 * Nothing here is highlighted. Tokens land in the card as raw text and gain
 * their colors from the ordinary parse when the fence settles, which keeps the
 * per-token cost of a streaming fence at one text node.
 */
function planOpenFence(tail: string, path: string, state: PlanState): void {
  const firstBreak = tail.indexOf('\n')
  const language = fenceLanguage(firstBreak === -1 ? tail : tail.slice(0, firstBreak))
  const code: Element = {
    type: 'element',
    tagName: 'code',
    properties: language === '' ? {} : { className: [`language-${language}`] },
    // Always one child, empty body included: a fence whose first line has not
    // finished arriving has still opened, and its card is what says so.
    children: [{ type: 'text', value: firstBreak === -1 ? '' : tail.slice(firstBreak + 1) }],
  }
  const before = state.leaves.length
  planCodeBlock(
    { type: 'element', tagName: 'pre', properties: {}, children: [code] },
    [],
    path,
    state,
  )
  for (let index = before; index < state.leaves.length; index += 1) {
    state.leaves[index].codeOpen = true
  }
}

/**
 * A top-level block whose bulk is one unbroken run of text has no semantic
 * children to window, so it goes to the disclosed bounded viewer instead of
 * handing the layout engine one enormous wrapping text node.
 */
function planAtomicProse(element: Element, path: string, state: PlanState): void {
  const groupId = `${state.sourceId}:${path}`
  const value = textOf(element)
  let chunkIndex = 0
  for (const slice of sliceBoundedText(value)) {
    state.leaves.push({
      id: `${groupId}:${chunkIndex}`,
      groupId,
      unitId: groupId,
      kind: 'atomic-text',
      wrappers: [],
      children: [],
      text: slice,
      codeSource: '',
      codeLanguage: '',
      codeOpen: false,
      characters: slice.length,
      lines: countBreaks(slice),
      elements: 0,
      estimatedHeight: estimateHeight(countBreaks(slice), slice.length),
    })
    chunkIndex += 1
  }
}

function usableChildren(
  children: readonly ElementContent[],
  wrappers: readonly MarkdownLeafWrapper[],
): readonly ElementContent[] {
  const parent = wrappers.length === 0 ? null : wrappers[wrappers.length - 1].element
  if (parent !== null && !BLOCK_CONTAINERS.has(parent.tagName)) return children
  // Whitespace between two block siblings is hast's serialization filler and is
  // safe to drop. The identical-looking node between two inline siblings is a
  // word separator: dropping it renders `*a* *b*` as `ab`, deleting text the
  // author wrote. Only the filler case is droppable.
  const kept = children.filter((child, index) => {
    if (child.type !== 'text' || child.value.trim() !== '') return true
    return !isBlockBoundary(children, index)
  })
  return kept.length === children.length ? children : kept
}

/** True when nothing inline sits on either side of `index`. */
function isBlockBoundary(children: readonly ElementContent[], index: number): boolean {
  return isBlockSideOrEdge(children, index, -1) && isBlockSideOrEdge(children, index, 1)
}

function isBlockSideOrEdge(
  children: readonly ElementContent[],
  index: number,
  step: number,
): boolean {
  for (let at = index + step; at >= 0 && at < children.length; at += step) {
    const sibling = children[at]
    if (sibling.type === 'text') {
      if (sibling.value.trim() === '') continue
      return false
    }
    if (sibling.type !== 'element') continue
    return BLOCK_LEVEL_TAGS.has(sibling.tagName)
  }
  return true
}

function splitWrapper(
  element: Element,
  id: string,
): {
  wrapper: MarkdownLeafWrapper
  rest: ElementContent[]
} {
  if (element.tagName !== 'table') {
    return {
      wrapper: { id, element: { ...element, children: [] }, prefix: [] },
      rest: element.children,
    }
  }
  const sticky: ElementContent[] = []
  const rest: ElementContent[] = []
  for (const child of element.children) {
    if (child.type === 'element' && TABLE_STICKY.has(child.tagName)) sticky.push(child)
    else rest.push(child)
  }
  // The header travels with EVERY chunk of the body, so its cost is charged
  // once per mounted unit rather than once per document.
  const prefix =
    countElementList(sticky) <= MAX_MARKDOWN_WRAPPER_PREFIX_ELEMENTS
      ? sticky
      : boundElements(sticky, MAX_MARKDOWN_WRAPPER_PREFIX_ELEMENTS)
  return { wrapper: { id, element: { ...element, children: [] }, prefix }, rest }
}

/**
 * An ordered list cut mid-body must not restart at 1: each chunk's retained
 * `<ol>` declares the number its first mounted item actually carries.
 */
function withOrderedStart(
  wrappers: readonly MarkdownLeafWrapper[],
  children: readonly ElementContent[],
  firstIndex: number,
): readonly MarkdownLeafWrapper[] {
  if (wrappers.length === 0) return wrappers
  const last = wrappers[wrappers.length - 1]
  if (last.element.tagName !== 'ol') return wrappers

  let offset = 0
  for (let index = 0; index < firstIndex && index < children.length; index += 1) {
    const child = children[index]
    if (child.type === 'element' && child.tagName === 'li') offset += 1
  }
  if (offset === 0) return wrappers

  const declared = last.element.properties?.start
  const base = typeof declared === 'number' ? declared : 1
  return [
    ...wrappers.slice(0, -1),
    {
      ...last,
      element: {
        ...last.element,
        properties: { ...last.element.properties, start: base + offset },
      },
    },
  ]
}

/**
 * Rebuilds one mounted unit by nesting its leaves back under the wrappers they
 * were cut from, level by level.
 *
 * Folding each leaf's chain on its own instead would re-emit the whole chain
 * per leaf: a table body interrupted by an oversized row emits leaves at three
 * different depths, which used to render as three stacked tables, each paying
 * for the sticky header again.
 */
function foldWrappers(
  members: readonly MarkdownRenderLeaf[],
  depth: number,
): ElementContent[] {
  const content: ElementContent[] = []
  let index = 0

  while (index < members.length) {
    const leaf = members[index]
    if (leaf.wrappers.length <= depth) {
      for (const child of leaf.children) content.push(child)
      index += 1
      continue
    }

    const wrapper = leaf.wrappers[depth]
    let last = index
    while (
      last + 1 < members.length &&
      members[last + 1].wrappers.length > depth &&
      members[last + 1].wrappers[depth].id === wrapper.id
    ) {
      last += 1
    }

    content.push({
      ...wrapper.element,
      children: [...wrapper.prefix, ...foldWrappers(members.slice(index, last + 1), depth + 1)],
    })
    index = last + 1
  }

  return content
}

/* ── tree normalization ────────────────────────────────────────────────────── */

/**
 * Raw HTML stays disabled: every `raw` node becomes the literal text the author
 * wrote, exactly as react-markdown demotes it. URL-bearing properties go
 * through react-markdown's own transform, so a `javascript:` href is emptied
 * here rather than reaching the DOM.
 */
function normalizeTree(
  node: Root | RootContent,
  recognizeCallouts: boolean,
): void {
  if (node.type !== 'root' && node.type !== 'element') return
  if (node.type === 'element') {
    if (recognizeCallouts) normalizeCallout(node)
    for (const key of ['href', 'src']) {
      if (!Object.hasOwn(node.properties, key)) continue
      node.properties[key] = defaultUrlTransform(String(node.properties[key] ?? ''))
    }
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (child.type === 'raw') {
      node.children[index] = { type: 'text', value: child.value }
      continue
    }
    normalizeTree(child, recognizeCallouts)
  }
}

const CALLOUT_MARKER =
  /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][\t ]*(?:\n|$)/

/**
 * GitHub-style alerts are ordinary CommonMark blockquotes whose first line is a
 * reserved marker. Promote only that already-parsed shape, then remove only the
 * marker from its first paragraph. Unknown markers and malformed fences stay
 * exactly as the Markdown parser interpreted them.
 */
function normalizeCallout(element: Element): void {
  if (element.tagName !== 'blockquote') return

  const paragraphIndex = element.children.findIndex(
    child =>
      child.type === 'element' &&
      child.tagName === 'p',
  )
  if (paragraphIndex < 0) return

  for (let index = 0; index < paragraphIndex; index += 1) {
    const child = element.children[index]
    if (child.type !== 'text' || child.value.trim() !== '') return
  }

  const paragraph = element.children[paragraphIndex]
  if (paragraph.type !== 'element') return
  const first = paragraph.children[0]
  if (first?.type !== 'text') return

  const match = CALLOUT_MARKER.exec(first.value)
  if (match === null) return

  const kind = calloutKind(match[1])
  if (kind === null) return

  element.tagName = 'aside'
  element.properties = {
    ...element.properties,
    className: ['md-callout'],
    dataCalloutKind: kind,
  }

  first.value = first.value.slice(match[0].length)
  if (first.value.length === 0) paragraph.children.shift()
  if (paragraph.children.length === 0) element.children.splice(paragraphIndex, 1)
}

function calloutKind(marker: string): string | null {
  switch (marker) {
    case 'NOTE':
      return 'note'
    case 'TIP':
      return 'tip'
    case 'IMPORTANT':
      return 'important'
    case 'WARNING':
      return 'warning'
    case 'CAUTION':
      return 'caution'
    default:
      return null
  }
}

/* ── streaming ─────────────────────────────────────────────────────────────── */

/**
 * Offset of a trailing fence that has no closing delimiter yet, or null.
 *
 * CommonMark closes an open fence at end of document, so the parser hands back
 * a finished code block for text the model is still writing. Classifying the
 * already-parsed node's own slice (never re-parsing the source) tells the two
 * apart: a closed fence's slice ends with its delimiter, an open one's ends
 * with the code itself.
 */
function findUnterminatedFence(mdast: MdastRoot, source: string): number | null {
  const last = mdast.children[mdast.children.length - 1]
  if (last === undefined || last.type !== 'code') return null
  const start = last.position?.start.offset
  const end = last.position?.end.offset
  if (start === undefined || end === undefined) return null
  if (source.slice(end).trim() !== '') return null

  const raw = source.slice(start, end)
  if (fenceRunLength(raw) === 0) return null

  const firstBreak = raw.indexOf('\n')
  if (firstBreak === -1) return start
  const body = raw.slice(firstBreak + 1)
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body
  return trimmed === last.value ? start : null
}

/** Whether a slice is one unterminated fence and nothing else. */
function isWholeUnterminatedFence(
  processor: ReturnType<typeof markdownProcessor>,
  tail: string,
): boolean {
  const mdast = processor.parse(tail)
  return mdast.children.length === 1 && findUnterminatedFence(mdast, tail) === 0
}

/**
 * The language word an opening delimiter declares, or empty.
 *
 * Only a bare word qualifies, which is the same shape the settled fence's own
 * `language-` class carries: the chip then reads identically before and after
 * the fence closes, instead of changing under the reader on settlement.
 */
function fenceLanguage(openingLine: string): string {
  const trimmed = openingLine.trimStart()
  const marker = trimmed[0]
  if (marker !== '`' && marker !== '~') return ''
  let index = 0
  while (trimmed[index] === marker) index += 1
  const info = trimmed.slice(index).trim()
  const word = /^\w+/.exec(info)
  return word === null ? '' : word[0]
}

/** Length of an opening fence run, or 0 when the slice does not open one. */
function fenceRunLength(raw: string): number {
  let index = 0
  while (index < 3 && raw[index] === ' ') index += 1
  const marker = raw[index]
  if (marker !== '`' && marker !== '~') return 0
  let run = 0
  while (raw[index + run] === marker) run += 1
  return run >= 3 ? run : 0
}

/* ── measurement ───────────────────────────────────────────────────────────── */

function weigh(node: ElementContent): Weight {
  const characters = countCharacters(node)
  const breaks = countBreaks(textOf(node))
  const start = node.position?.start.line
  const end = node.position?.end.line
  const spanned = start === undefined || end === undefined ? 0 : Math.max(1, end - start + 1)
  return { lines: Math.max(spanned, breaks), characters, elements: countElements(node) }
}

function countCharacters(node: ElementContent): number {
  if (node.type === 'text' || node.type === 'raw') return node.value.length
  if (node.type !== 'element') return 0
  let total = 0
  for (const child of node.children) total += countCharacters(child)
  return total
}

/** Elements this node mounts, itself included. Text nodes cost nothing here. */
function countElements(node: ElementContent): number {
  if (node.type !== 'element') return 0
  let total = 1
  for (const child of node.children) total += countElements(child)
  return total
}

function countElementList(nodes: readonly ElementContent[]): number {
  let total = 0
  for (const node of nodes) total += countElements(node)
  return total
}

/**
 * Every retained wrapper and its sticky prefix mounts with each unit, so the
 * chain is charged to the leaves that pull it in. Over-counting inside one unit
 * is deliberate: the window budget must bound mounted nodes from above.
 */
function countWrapperElements(wrappers: readonly MarkdownLeafWrapper[]): number {
  let total = 0
  for (const wrapper of wrappers) total += 1 + countElementList(wrapper.prefix)
  return total
}

/**
 * A copy of `nodes` cut to at most `budget` mounted elements, depth first, so
 * the structure that survives is still the structure the author opened.
 */
function boundElements(
  nodes: readonly ElementContent[],
  budget: number,
): ElementContent[] {
  let remaining = budget
  const walk = (list: readonly ElementContent[]): ElementContent[] => {
    const kept: ElementContent[] = []
    for (const node of list) {
      if (remaining <= 0) break
      if (node.type !== 'element') {
        kept.push(node)
        continue
      }
      remaining -= 1
      kept.push({ ...node, children: walk(node.children) })
    }
    return kept
  }
  return walk(nodes)
}

/** Cuts one unbroken run of text at whichever ceiling it reaches first. */
function sliceBoundedText(value: string): string[] {
  const slices: string[] = []
  let start = 0
  while (start < value.length) {
    let end = Math.min(start + MAX_MARKDOWN_LEAF_CHARACTERS, value.length)
    let breaks = 0
    for (let index = start; index < end; index += 1) {
      if (value.charCodeAt(index) !== 10) continue
      breaks += 1
      if (breaks >= MAX_MARKDOWN_LEAF_LINES) {
        end = index + 1
        break
      }
    }
    slices.push(value.slice(start, end))
    start = end
  }
  return slices
}

function countBreaks(value: string): number {
  let total = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) total += 1
  }
  return total
}

function textOf(node: ElementContent): string {
  if (node.type === 'text' || node.type === 'raw') return node.value
  if (node.type !== 'element') return ''
  let total = ''
  for (const child of node.children) total += textOf(child)
  return total
}

function hasElementChild(element: Element): boolean {
  return element.children.some(child => child.type === 'element')
}

function isCodeBlock(node: ElementContent): node is Element {
  return (
    node.type === 'element' &&
    node.tagName === 'pre' &&
    node.children.some(child => child.type === 'element' && child.tagName === 'code')
  )
}

function languageOf(code: Element): string {
  const className = code.properties?.className
  if (!Array.isArray(className)) return ''
  for (const entry of className) {
    const name = String(entry)
    if (name.startsWith('language-')) return name.slice('language-'.length)
  }
  return ''
}

function estimateHeight(lines: number, characters: number): number {
  const wrapped = Math.ceil(characters / 120)
  return Math.max(lines, wrapped, 1) * 24
}

function sumHeights(
  leaves: readonly MarkdownRenderLeaf[],
  start: number,
  end: number,
): number {
  let total = 0
  for (let index = start; index < end; index += 1) total += leaves[index].estimatedHeight
  return total
}
