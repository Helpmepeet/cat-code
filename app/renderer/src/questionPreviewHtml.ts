/**
 * Model-authored `AskUserQuestion` option previews, rendered as HTML.
 *
 * The renderer CSP is `frame-src 'none'`, so a sandboxed iframe is not
 * available. Instead the fragment is parsed in an inert `DOMParser` document
 * (no scripts run, no resources load), reduced to an allowlist of elements and
 * attributes there, and only then moved into the live document inside a shadow
 * root. The shadow root keeps the app's stylesheets out and the preview's
 * markup in; `inert` keeps its controls from taking focus or clicks; the host's
 * layout and paint containment (`.ask-preview-html`) traps `position: fixed`
 * and stacking inside the panel. The CSP stays the backstop for anything the
 * allowlist misses: no inline script, images only from `self` or `data:`.
 *
 * The engine prompt (`PREVIEW_FEATURE_PROMPT.html`) describes this contract to
 * the model; keep the two in step.
 */

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Removed with their whole subtree: they execute, fetch, embed, or carry metadata. */
const DROPPED_ELEMENTS = new Set([
  'animate', 'animatemotion', 'animatetransform', 'applet', 'audio', 'base',
  'canvas', 'dialog', 'embed', 'feimage', 'foreignobject', 'frame', 'frameset',
  'head', 'iframe', 'image', 'link', 'math', 'meta', 'noscript', 'object',
  'picture', 'portal', 'script', 'set', 'source', 'style', 'template',
  'title', 'track', 'use', 'video',
])

const HTML_ELEMENTS = new Set([
  'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'button', 'caption',
  'code', 'col', 'colgroup', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
  'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend',
  'li', 'main', 'mark', 'meter', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre',
  'progress', 's', 'samp', 'section', 'select', 'small', 'span', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul', 'var',
])

/** Lowercased: the HTML parser case-adjusts SVG names (`linearGradient`). */
const SVG_ELEMENTS = new Set([
  'circle', 'clippath', 'defs', 'ellipse', 'g', 'line', 'lineargradient',
  'marker', 'mask', 'path', 'polygon', 'polyline', 'radialgradient', 'rect',
  'stop', 'svg', 'text', 'tspan',
])

const HTML_ATTRIBUTES = new Set([
  'align', 'alt', 'checked', 'cols', 'colspan', 'dir', 'disabled', 'height',
  'high', 'low', 'max', 'min', 'multiple', 'open', 'optimum', 'placeholder',
  'readonly', 'reversed', 'rows', 'rowspan', 'selected', 'span', 'start',
  'step', 'style', 'type', 'valign', 'value', 'width',
])

const SVG_ATTRIBUTES = new Set([
  'alignment-baseline', 'clip-path', 'clip-rule', 'clippathunits', 'color',
  'cx', 'cy', 'd', 'display', 'dominant-baseline', 'dx', 'dy', 'fill',
  'fill-opacity', 'fill-rule', 'font-family', 'font-size', 'font-style',
  'font-weight', 'fx', 'fy', 'gradienttransform', 'gradientunits', 'height',
  'id', 'letter-spacing', 'marker-end', 'marker-mid', 'marker-start',
  'markerheight', 'markerunits', 'markerwidth', 'mask', 'maskunits', 'offset',
  'opacity', 'orient', 'points', 'preserveaspectratio', 'r', 'refx', 'refy',
  'rx', 'ry', 'shape-rendering', 'spreadmethod', 'stop-color', 'stop-opacity',
  'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'style', 'text-anchor', 'transform', 'vector-effect', 'viewbox',
  'visibility', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
])

/** `type` values that draw as a static control. Anything else becomes `text`. */
const INPUT_TYPES = new Set([
  'checkbox', 'color', 'date', 'email', 'number', 'password', 'radio',
  'range', 'search', 'tel', 'text', 'time', 'url',
])

/**
 * A value that could reach outside the fragment: any `url()` that is not a
 * local `#id` reference, and the CSS image functions that fetch without one.
 */
const EXTERNAL_REFERENCE =
  /url\(\s*(?!['"]?#)|image-set\(|(?:^|[^-\w])image\(|cross-fade\(|element\(|expression\(|javascript:/i

const DATA_IMAGE_SRC = /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i

/** Same test as the engine's `validateHtmlPreview`: did the model emit markup? */
export function isHtmlPreview(preview: string): boolean {
  return /<[a-z][^>]*>/i.test(preview)
}

/**
 * Structural defaults inside the shadow root. Inherited text properties and
 * the theme variables (`--fg`, `--accent`, ...) arrive from the host.
 */
export const QUESTION_PREVIEW_SHADOW_CSS = `
*, *::before, *::after { box-sizing: border-box; }
.preview-root { overflow-wrap: anywhere; }
.preview-root > :first-child { margin-top: 0; }
.preview-root > :last-child { margin-bottom: 0; }
p, ul, ol, dl, pre, table, blockquote, figure, details, fieldset { margin: 0 0 8px; }
ul, ol { padding-left: 20px; }
h1, h2, h3, h4, h5, h6 { margin: 0 0 6px; color: var(--fg); line-height: 1.3; }
h1 { font-size: 18px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
h4, h5, h6 { font-size: 13px; }
pre, code, kbd, samp { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; }
th, td { padding: 4px 8px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--fg); font-weight: 600; }
blockquote { padding-left: 10px; border-left: 2px solid var(--border); }
hr { border: 0; border-top: 1px solid var(--border); margin: 8px 0; }
img { max-width: 100%; height: auto; }
svg { max-width: 100%; }
button, input, select, textarea { font: inherit; color: inherit; }
`

function stripAttributes(element: Element, svg: boolean, name: string): void {
  const allowed = svg ? SVG_ATTRIBUTES : HTML_ATTRIBUTES
  for (const attribute of Array.from(element.attributes)) {
    const key = attribute.name.toLowerCase()
    const keep =
      (allowed.has(key) && !EXTERNAL_REFERENCE.test(attribute.value)) ||
      (name === 'img' && key === 'src' && DATA_IMAGE_SRC.test(attribute.value.trim()))
    if (!keep) element.removeAttribute(attribute.name)
  }
  if (name === 'input') {
    const type = element.getAttribute('type')?.toLowerCase()
    if (type !== undefined && !INPUT_TYPES.has(type)) element.setAttribute('type', 'text')
  }
  if (name === 'img' && !element.hasAttribute('src')) element.remove()
}

function sanitizeChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === node.TEXT_NODE) continue
    if (node.nodeType !== node.ELEMENT_NODE) {
      node.parentNode?.removeChild(node)
      continue
    }
    const element = node as Element
    const name = element.localName.toLowerCase()
    const svg = element.namespaceURI === SVG_NS
    if (DROPPED_ELEMENTS.has(name) || (!svg && element.namespaceURI !== HTML_NS)) {
      element.remove()
      continue
    }
    sanitizeChildren(element)
    if (!(svg ? SVG_ELEMENTS : HTML_ELEMENTS).has(name)) {
      // Links, forms and unknown tags keep their text but lose the element.
      element.replaceWith(...Array.from(element.childNodes))
      continue
    }
    stripAttributes(element, svg, name)
  }
}

/**
 * Parses `html` inertly and returns the sanitized nodes, adopted into
 * `target`, wrapped in an `inert` root with the shadow stylesheet first.
 */
export function buildQuestionPreview(html: string, target: Document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  sanitizeChildren(parsed.body)
  const fragment = target.createDocumentFragment()
  const style = target.createElement('style')
  style.textContent = QUESTION_PREVIEW_SHADOW_CSS
  const root = target.createElement('div')
  root.className = 'preview-root'
  root.setAttribute('inert', '')
  // Sanitized in the parser's document first: adopting live first would let
  // the live document act on attributes the allowlist exists to remove.
  root.append(...Array.from(parsed.body.childNodes).map(node => target.adoptNode(node)))
  fragment.append(style, root)
  return fragment
}
