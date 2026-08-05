/**
 * DOM plumbing for the contentEditable composer.
 *
 * The composer field is a `contentEditable` div rather than a `<textarea>` so a
 * collapsed paste can render as an atomic INLINE pill exactly where its
 * `[Pasted text #N]` token sits in the draft (prototype `Chat.jsx:1060-1097`,
 * `Chat.jsx:1402-1409`). A textarea cannot host styled DOM, which is why the
 * earlier adaptation had to park the pills in a strip above the field and leave
 * the raw token visible in the text.
 *
 * The draft stays a plain STRING everywhere above this module: nothing about the
 * paste model, submit expansion, or the wire changes. This file owns only the
 * two directions of the string↔DOM contract:
 *
 *  - read  — `readComposerText` serializes the live DOM back to that string, a
 *            pill contributing exactly its token text (`PASTE_TOKEN_ATTR`);
 *  - write — `renderComposerDom` rebuilds the DOM from the string, and only when
 *            the two have actually drifted, so plain typing is never disturbed.
 *
 * `splitComposerText`, `readComposerText`, and `composerOffsetOf` are written
 * against `ComposerNode` (the structural subset a real `Node` satisfies) so the
 * contract is testable in the SSR-only renderer suite, which has no DOM.
 */

import { PASTE_REF_RE } from './composerState.js'

/** Marks a pill node and carries the exact token text it stands in for. */
export const PASTE_TOKEN_ATTR = 'data-paste-token'

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/**
 * The subset of `Node` the serializer touches. Declared structurally (with
 * `getAttribute` optional, since only elements have it) so a real DOM node and a
 * plain test literal are both assignable.
 */
export type ComposerNode = {
  nodeType: number
  nodeName: string
  nodeValue?: string | null
  childNodes: ArrayLike<ComposerNode>
  getAttribute?: (name: string) => string | null
}

function pasteToken(node: ComposerNode): string | null {
  if (node.nodeType !== ELEMENT_NODE) return null
  return node.getAttribute?.(PASTE_TOKEN_ATTR) ?? null
}

function children(node: ComposerNode): ComposerNode[] {
  const list: ComposerNode[] = []
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i]
    if (child) list.push(child)
  }
  return list
}

/** How many characters of the flat draft string a node stands for. */
export function composerNodeLength(node: ComposerNode): number {
  if (node.nodeType === TEXT_NODE) return node.nodeValue?.length ?? 0
  if (node.nodeType !== ELEMENT_NODE) return 0
  const token = pasteToken(node)
  if (token !== null) return token.length
  if (node.nodeName === 'BR') return 1
  return children(node).reduce((sum, child) => sum + composerNodeLength(child), 0)
}

/**
 * Serialize the live composer DOM back to the flat draft string: text nodes
 * verbatim, a pill as its token, a `<br>` as a newline.
 *
 * Browsers keep a trailing "bogus" `<br>` in a contentEditable so the last line
 * stays reachable, which reads back as a phantom newline. We only ever emit a
 * `<br>` as that same trailing filler (`renderComposerDom`), so a final newline
 * backed by a final `<br>` is dropped (prototype `Chat.jsx:801-803`).
 */
export function readComposerText(root: ComposerNode): string {
  const read = (node: ComposerNode): string => {
    if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
    if (node.nodeType !== ELEMENT_NODE) return ''
    const token = pasteToken(node)
    if (token !== null) return token
    if (node.nodeName === 'BR') return '\n'
    return children(node).map(read).join('')
  }
  const text = read(root)
  const last = root.childNodes[root.childNodes.length - 1]
  if (text.endsWith('\n') && last?.nodeName === 'BR') return text.slice(0, -1)
  return text
}

/**
 * The flat-string offset a DOM selection boundary (`container`, `offset`) points
 * at. For a text container the offset is a character index; for an element it is
 * a CHILD INDEX, so the characters of every preceding sibling count.
 */
export function composerOffsetOf(
  root: ComposerNode,
  container: ComposerNode,
  containerOffset: number,
): number {
  let offset = 0
  let found = false
  const walk = (node: ComposerNode): void => {
    if (found) return
    if (node === container) {
      found = true
      if (node.nodeType === TEXT_NODE) {
        offset += containerOffset
        return
      }
      for (const child of children(node).slice(0, containerOffset)) {
        offset += composerNodeLength(child)
      }
      return
    }
    if (node.nodeType === TEXT_NODE) {
      offset += node.nodeValue?.length ?? 0
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const token = pasteToken(node)
    if (token !== null) {
      offset += token.length
      return
    }
    if (node.nodeName === 'BR') {
      offset += 1
      return
    }
    for (const child of children(node)) walk(child)
  }
  walk(root)
  return offset
}

// ── String → DOM ─────────────────────────────────────────────────────────────

export type ComposerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'pill'; token: string; id: number; numLines: number }

/**
 * Cut a draft into the runs the composer renders: literal text, and each
 * `[Pasted text #N]` token as a pill. Adjacent tokens produce adjacent pills
 * with no empty text run between them.
 */
export function splitComposerText(text: string): ComposerSegment[] {
  const segments: ComposerSegment[] = []
  let cursor = 0
  // A fresh regex per call: PASTE_REF_RE is global, so its lastIndex is shared.
  const pattern = new RegExp(PASTE_REF_RE.source, 'g')
  let match = pattern.exec(text)
  while (match) {
    if (match.index > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    }
    segments.push({
      kind: 'pill',
      token: match[0],
      id: Number(match[1]),
      numLines: Number(match[2] ?? 0),
    })
    cursor = match.index + match[0].length
    match = pattern.exec(text)
  }
  if (cursor < text.length) {
    segments.push({ kind: 'text', text: text.slice(cursor) })
  }
  return segments
}

export type PastePillOptions = {
  token: string
  id: number
  /** Newline count, so the pill reads `numLines + 1` lines. */
  numLines: number
  /** Full pasted length, shown when the paste has no newlines. */
  charCount: number | null
  onPreviewOpen: () => void
  onPreviewClose: () => void
  onRemove: () => void
}

const PILL_CLASS =
  'inline-flex items-center gap-1.5 whitespace-nowrap align-baseline rounded-[7px] border border-accent/35 bg-accent/10 py-px pl-[9px] pr-1 text-[13.5px] font-medium leading-tight text-accent-soft'
const PILL_BODY_CLASS = 'inline-flex cursor-pointer items-center gap-1.5'
const PILL_ICON_CLASS = 'inline-flex text-accent'
const PILL_META_CLASS = 'font-mono text-[11px] text-text-subtle'
const PILL_REMOVE_CLASS =
  'inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border-none bg-transparent p-0 text-text-subtle transition-colors hover:bg-tone-danger/10 hover:text-tone-danger'

const CLIPBOARD_PATH =
  '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'
const CLOSE_PATH =
  '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'

/**
 * One atomic pill node for a collapsed paste (prototype `Chat.jsx:1060-1097`):
 * clipboard glyph, `Pasted #N`, its size, and a remove control.
 *
 * `contenteditable="false"` is what makes it atomic to the caret and to
 * Backspace; `PASTE_TOKEN_ATTR` is what makes it serialize back to its token.
 * Both interactive parts swallow `mousedown` so clicking the pill never moves
 * the caret or blurs the field.
 */
export function buildPastePill(options: PastePillOptions): HTMLElement {
  const pill = document.createElement('span')
  pill.setAttribute(PASTE_TOKEN_ATTR, options.token)
  pill.setAttribute('contenteditable', 'false')
  pill.className = PILL_CLASS

  const body = document.createElement('span')
  body.className = PILL_BODY_CLASS
  body.title = 'Preview pasted text'

  const icon = document.createElement('span')
  icon.className = PILL_ICON_CLASS
  icon.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CLIPBOARD_PATH}</svg>`
  body.appendChild(icon)
  body.appendChild(document.createTextNode(`Pasted #${options.id}`))

  const meta =
    options.numLines > 0
      ? `${options.numLines + 1} lines`
      : options.charCount !== null
        ? `${options.charCount} chars`
        : ''
  if (meta) {
    const metaNode = document.createElement('span')
    metaNode.className = PILL_META_CLASS
    metaNode.textContent = meta
    body.appendChild(metaNode)
  }
  body.addEventListener('mousedown', event => event.preventDefault())
  body.addEventListener('mouseenter', options.onPreviewOpen)
  body.addEventListener('mouseleave', options.onPreviewClose)
  pill.appendChild(body)

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.title = 'Remove'
  remove.setAttribute('aria-label', `Remove pasted text ${options.id}`)
  remove.className = PILL_REMOVE_CLASS
  remove.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">${CLOSE_PATH}</svg>`
  remove.addEventListener('mousedown', event => event.preventDefault())
  remove.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    options.onRemove()
  })
  pill.appendChild(remove)

  return pill
}

/**
 * Rebuild the composer DOM from `text` — but ONLY when the DOM has drifted from
 * it, so ordinary typing (where the browser already produced the right DOM)
 * never gets its nodes replaced under the caret. `force` covers the case where
 * the string is unchanged but a pill's own content is not (a paste added or
 * removed under the same token text).
 *
 * Returns whether the DOM was rewritten, so the caller knows when the caret it
 * had needs restoring.
 */
export function renderComposerDom(
  root: HTMLElement,
  text: string,
  buildPill: (segment: { token: string; id: number; numLines: number }) => HTMLElement,
  force = false,
): boolean {
  if (!force && readComposerText(root) === text) return false
  const fragment = document.createDocumentFragment()
  for (const segment of splitComposerText(text)) {
    if (segment.kind === 'text') {
      fragment.appendChild(document.createTextNode(segment.text))
    } else {
      fragment.appendChild(buildPill(segment))
    }
  }
  // Under `white-space: pre-wrap` a trailing "\n" in a text node renders no
  // visible final line, so a fresh Shift+Enter at the end would look inert. The
  // filler `<br>` makes that line visible; `readComposerText` strips it back out
  // so it never doubles into the draft (prototype `Chat.jsx:1119-1122`).
  if (text.endsWith('\n')) fragment.appendChild(document.createElement('br'))
  root.textContent = ''
  root.appendChild(fragment)
  return true
}

// ── Selection ────────────────────────────────────────────────────────────────

export type ComposerSelection = { start: number; end: number }

/** The live selection as flat-string offsets, or null when it is not in the composer. */
export function composerSelectionOffsets(
  root: HTMLElement,
): ComposerSelection | null {
  const selection = window.getSelection?.()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null
  }
  return {
    start: composerOffsetOf(root, range.startContainer, range.startOffset),
    end: composerOffsetOf(root, range.endContainer, range.endOffset),
  }
}

/** Where a flat-string offset lands in the DOM, for building a Range. */
function locateOffset(
  root: Node,
  target: number,
): { container: Node; offset: number } | null {
  let consumed = 0
  const place = (node: Node): { container: Node; offset: number } | null => {
    if (node.nodeType === TEXT_NODE) {
      const length = node.nodeValue?.length ?? 0
      if (target <= consumed + length) {
        return { container: node, offset: target - consumed }
      }
      consumed += length
      return null
    }
    if (node.nodeType !== ELEMENT_NODE) return null
    const parent = node.parentNode
    const token =
      node instanceof Element ? node.getAttribute(PASTE_TOKEN_ATTR) : null
    if (token !== null && parent) {
      const index = Array.prototype.indexOf.call(parent.childNodes, node)
      if (target <= consumed) return { container: parent, offset: index }
      if (target <= consumed + token.length) {
        return { container: parent, offset: index + 1 }
      }
      consumed += token.length
      return null
    }
    if (node.nodeName === 'BR' && parent) {
      if (target <= consumed + 1) {
        const index = Array.prototype.indexOf.call(parent.childNodes, node)
        return { container: parent, offset: index + 1 }
      }
      consumed += 1
      return null
    }
    for (const child of Array.from(node.childNodes)) {
      const hit = place(child)
      if (hit) return hit
    }
    return null
  }
  return place(root)
}

/**
 * Put the selection at the given flat-string offsets. Offsets past the end
 * collapse to the end of the content, which is what a programmatic draft rewrite
 * wants when it shortened the text.
 */
export function placeComposerSelection(
  root: HTMLElement,
  start: number,
  end: number,
): void {
  const selection = window.getSelection?.()
  if (!selection) return
  const range = document.createRange()
  const from = locateOffset(root, start)
  if (from) {
    range.setStart(from.container, from.offset)
  } else {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  const to = start === end ? from : locateOffset(root, end)
  if (to) range.setEnd(to.container, to.offset)
  else if (from) range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
