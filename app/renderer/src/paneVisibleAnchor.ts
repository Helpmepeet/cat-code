// Keep a character on its rendered line, rather than the top of a message or
// the total height of a body. A body can grow below that line, or exchange equal
// height above and below it, without an aggregate height describing the motion.
const MAX_ANCHORS = 3
const MAX_TEXT_NODES = 2_048
const SCOPE_SELECTOR = '[data-transcript-entry], [data-transcript-child]'

type RetainedSlot = {
  parent: Node
  index: number
  childCount: number
  previous: Node | null
  next: Node | null
}

type TextAnchor = {
  node: Text
  slot: RetainedSlot
  parentSlot: RetainedSlot | null
  offset: number
  context: string
  leadingContext: string
  contextOffset: number
  scope: Element
  scopeAttribute: string | null
  scopeKey: string | null
  top: number
}
export type PaneVisibleAnchor = { points: TextAnchor[]; scrollTop: number }

export function capturePaneVisibleAnchor(scroller: HTMLElement): PaneVisibleAnchor | null {
  const doc = scroller.ownerDocument
  if (!doc || scroller.clientHeight <= 0 || typeof doc.createRange !== 'function') return null
  const paneRect = scroller.getBoundingClientRect()
  const range = doc.createRange()
  if (typeof range.getBoundingClientRect !== 'function') return null
  const points: TextAnchor[] = []
  const walker = doc.createTreeWalker(scroller, 4 /* SHOW_TEXT */)
  let visited = 0
  let node: Node | null
  while (points.length < MAX_ANCHORS && visited++ < MAX_TEXT_NODES && (node = walker.nextNode())) {
    const text = node as Text
    if (!text.data.trim()) continue
    range.selectNodeContents(text)
    const box = range.getBoundingClientRect()
    if (box.height <= 0 || box.bottom <= paneRect.top || box.top >= paneRect.top + scroller.clientHeight) continue
    if (isNestedScroller(text.parentElement, scroller)) continue
    // Find the first character whose line intersects the pane's leading edge.
    // This is logarithmic in text length even for a single very long paragraph.
    let low = 0
    let high = text.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      range.setStart(text, middle)
      range.setEnd(text, middle + 1)
      if (range.getBoundingClientRect().bottom <= paneRect.top) low = middle + 1
      else high = middle
    }
    range.setStart(text, low)
    range.setEnd(text, low + 1)
    const character = range.getBoundingClientRect()
    if (character.height <= 0) continue
    const scope = text.parentElement?.closest(SCOPE_SELECTOR) ?? scroller
    const scopeAttribute = scope.hasAttribute('data-transcript-entry') ? 'data-transcript-entry'
      : scope.hasAttribute('data-transcript-child') ? 'data-transcript-child' : null
    const contextStart = Math.max(0, low - 16)
    points.push({
      node: text, slot: captureSlot(text),
      parentSlot: text.parentElement?.parentNode ? captureSlot(text.parentElement) : null,
      offset: low, context: text.data.slice(contextStart, low + 48),
      leadingContext: text.data.slice(0, 64),
      contextOffset: low - contextStart, scope, scopeAttribute,
      scopeKey: scopeAttribute === null ? null : scope.getAttribute(scopeAttribute),
      top: character.top - paneRect.top,
    })
  }
  return points.length === 0 ? null : { points, scrollTop: scroller.scrollTop }
}

export function readPaneVisibleAnchorAdjustment(scroller: HTMLElement, anchor: PaneVisibleAnchor): number | null {
  const paneTop = scroller.getBoundingClientRect().top
  for (const point of anchor.points) {
    const resolved = resolvePoint(scroller, point)
    if (!resolved) continue
    const range = scroller.ownerDocument.createRange()
    range.setStart(resolved.node, resolved.offset)
    range.setEnd(resolved.node, resolved.offset + 1)
    const box = range.getBoundingClientRect()
    if (box.height <= 0) continue
    return box.top - paneTop - point.top
  }
  return null
}

function resolvePoint(scroller: HTMLElement, point: TextAnchor): { node: Text; offset: number } | null {
  let scope: Element | undefined = scroller.contains(point.scope) ? point.scope : undefined
  if (!scope && point.scopeAttribute !== null) {
    scope = Array.from(scroller.querySelectorAll(`[${point.scopeAttribute}]`))
      .find(element => element.getAttribute(point.scopeAttribute!) === point.scopeKey)
  }
  if (!scope) return null
  if (scope.contains(point.node) && !isNestedScroller(point.node.parentElement, scroller)) {
    const offset = matchText(point.node, point)
    if (offset !== null) return { node: point.node, offset }
  }
  // A retained text parent, or a replacement parent between retained siblings,
  // identifies the occurrence even when several paragraphs have identical text.
  let located = readSlot(scope, point.slot, false)
  if (!located && point.parentSlot) {
    const parent = readSlot(scope, point.parentSlot, true)
    if (parent && parent.childNodes.length === point.slot.childCount) {
      located = parent.childNodes.item(point.slot.index)
    }
  }
  if (located?.nodeType === 3 && !isNestedScroller(located.parentElement, scroller)) {
    const text = located as Text
    const offset = matchText(text, point)
    if (offset !== null) return { node: text, offset }
  }
  const walker = scroller.ownerDocument.createTreeWalker(scope, 4)
  let visited = 0
  let match: { node: Text; offset: number } | null = null
  let matches = 0
  let node: Node | null = null
  while (visited++ < MAX_TEXT_NODES && (node = walker.nextNode())) {
    const text = node as Text
    if (isNestedScroller(text.parentElement, scroller)) continue
    const offset = matchText(text, point) ?? matchText(text, point, false)
    if (offset === null) continue
    matches++
    match = { node: text, offset }
  }
  // Stopping at the bound does not prove a match unique in the rest of a scope.
  if (node && walker.nextNode()) return null
  // A window can discard the leading text of a retained paragraph. Both leading
  // and local-context searches must reject multiple possible occurrences.
  return matches === 1 ? match : null
}

function captureSlot(node: Node): RetainedSlot {
  const parent = node.parentNode!
  return {
    parent, index: Array.prototype.indexOf.call(parent.childNodes, node),
    childCount: parent.childNodes.length, previous: node.previousSibling, next: node.nextSibling,
  }
}

function readSlot(scope: Element, slot: RetainedSlot, requireNeighbor: boolean): Node | null {
  if (!scope.contains(slot.parent) || slot.parent.childNodes.length !== slot.childCount) return null
  if (requireNeighbor && slot.previous === null && slot.next === null) return null
  const node = slot.parent.childNodes.item(slot.index)
  if (node?.previousSibling !== slot.previous || node.nextSibling !== slot.next) return null
  return node
}

function matchText(text: Text, point: TextAnchor, requireLeading = true): number | null {
  // Repeated lines can have identical local context in DIFFERENT paragraphs.
  // A reused node is not enough: retain the paragraph's leading identity too.
  const leading = text.data.startsWith(point.leadingContext) ? 0 : text.data.indexOf(point.leadingContext)
  if (leading < 0) {
    if (requireLeading) return null
    const position = text.data.indexOf(point.context)
    if (position < 0 || text.data.indexOf(point.context, position + 1) >= 0) return null
    return position + point.contextOffset
  }
  if (leading > 0 && text.data.indexOf(point.leadingContext, leading + 1) >= 0) return null
  const expectedOffset = leading + point.offset
  const contextStart = expectedOffset - point.contextOffset
  if (text.data.slice(contextStart, contextStart + point.context.length) === point.context) return expectedOffset
  const position = text.data.indexOf(point.context, leading)
  if (position < 0 || text.data.indexOf(point.context, position + 1) >= 0) return null
  return position + point.contextOffset
}

function isNestedScroller(element: Element | null, pane: HTMLElement): boolean {
  for (let current = element; current && current !== pane; current = current.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(current).overflowY)) return true
    if (current.hasAttribute('aria-hidden')) return true
  }
  return false
}
