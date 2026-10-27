import { afterAll, beforeAll, expect, test } from 'bun:test'

import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js'
import { buildQuestionPreview, isHtmlPreview } from './questionPreviewHtml.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterAll(async () => {
  await harness.teardown()
})

function build(html: string): HTMLElement {
  const fragment = buildQuestionPreview(html, document)
  const host = document.createElement('div')
  host.append(fragment)
  return host.querySelector('.preview-root') as HTMLElement
}

test('the preview root is inert and follows its own stylesheet', () => {
  const fragment = buildQuestionPreview('<p>hi</p>', document)
  const [style, root] = Array.from(fragment.children)
  expect(style!.localName).toBe('style')
  expect(root!.hasAttribute('inert')).toBe(true)
  expect(root!.innerHTML).toBe('<p>hi</p>')
})

test('executable, embedding, and metadata elements are removed with their content', () => {
  const root = build(
    '<div>keep<script>alert(1)</script><style>body{}</style><iframe></iframe><object></object><template><b>t</b></template><link rel="stylesheet"><meta charset="utf-8"></div>',
  )
  expect(root.innerHTML).toBe('<div>keep</div>')
})

test('event handlers, classes, ids and unknown attributes are stripped while inline style stays', () => {
  const root = build(
    '<div id="x" class="y" onclick="alert(1)" data-z="1" style="color: var(--fg); display: flex">t</div>',
  )
  expect(root.innerHTML).toBe('<div style="color: var(--fg); display: flex">t</div>')
})

test('links and forms keep their text but lose the element', () => {
  const root = build('<form action="https://x"><a href="javascript:alert(1)">go</a> <span>s</span></form>')
  expect(root.innerHTML).toBe('go <span>s</span>')
})

test('styles that reference outside resources are removed', () => {
  const root = build(
    '<div style="background: url(https://x/y.png)">a</div><div style="background-image: image-set(&quot;x.png&quot; 1x)">b</div><div style="background: linear-gradient(red, blue)">c</div>',
  )
  expect(root.innerHTML).toBe(
    '<div>a</div><div>b</div><div style="background: linear-gradient(red, blue)">c</div>',
  )
})

test('images load only from data URIs', () => {
  const root = build('<img src="https://x/y.png" alt="remote"><img src="data:image/png;base64,AAAA" alt="inline" onerror="alert(1)">')
  expect(root.innerHTML).toBe('<img src="data:image/png;base64,AAAA" alt="inline">')
})

test('inline SVG keeps its namespace, shapes, and local paint references', () => {
  const root = build(
    '<svg viewBox="0 0 10 10" onload="alert(1)"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><circle r="2" fill="url(https://x#g)"/><use href="#g"/><foreignObject><div>x</div></foreignObject><a href="https://x"><text>label</text></a></svg>',
  )
  const svg = root.querySelector('svg')!
  expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
  expect(svg.hasAttribute('onload')).toBe(false)
  expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
  expect(root.querySelector('linearGradient')?.getAttribute('id')).toBe('g')
  expect(root.querySelector('rect')?.getAttribute('fill')).toBe('url(#g)')
  expect(root.querySelector('circle')?.hasAttribute('fill')).toBe(false)
  expect(root.querySelector('use')).toBeNull()
  expect(root.querySelector('foreignObject')).toBeNull()
  expect(root.querySelector('a')).toBeNull()
  expect(root.querySelector('text')?.textContent).toBe('label')
})

test('form controls draw as static mockups with only safe input types', () => {
  const root = build(
    '<input type="file" name="f" value="v"><input type="checkbox" checked><button type="submit" formaction="https://x">Save</button>',
  )
  const [file, checkbox] = Array.from(root.querySelectorAll('input'))
  expect(file!.getAttribute('type')).toBe('text')
  expect(file!.hasAttribute('name')).toBe(false)
  expect(checkbox!.hasAttribute('checked')).toBe(true)
  expect(root.querySelector('button')?.hasAttribute('formaction')).toBe(false)
})

test('comments are dropped', () => {
  expect(build('<p>a<!-- hidden --></p>').innerHTML).toBe('<p>a</p>')
})

test('markup is detected the same way the engine validates it', () => {
  expect(isHtmlPreview('<div>x</div>')).toBe(true)
  expect(isHtmlPreview('+---+\n| a <-- b |\n+---+')).toBe(false)
  expect(isHtmlPreview('import { format } from "date-fns"')).toBe(false)
})
