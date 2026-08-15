/**
 * SSR-ONLY LIMIT: the repo's renderer suite renders with `renderToStaticMarkup`
 * (no happy-dom here), so these tests pin what the FIRST mounted window emits
 * and the geometry that chooses it. Scroll-driven windows, ResizeObserver
 * measurement, and the pane-scroller pooling live in effects and are covered by
 * the plan-level suite plus operator verification.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import {
  planMarkdownLeaves,
  renderMarkdownTree,
  selectMarkdownLeafWindow,
  type MountedMarkdownLeaf,
} from './markdownRenderPlan.js'

function renderBody(sourceId: string, source: string): string {
  return renderToStaticMarkup(
    <BoundedMarkdown
      sourceId={sourceId}
      source={source}
      renderLeaf={(leaf: MountedMarkdownLeaf) => renderMarkdownTree(leaf.tree)}
    />,
  )
}

describe('BoundedMarkdown', () => {
  test('renders a short body as interpreted Markdown', () => {
    const html = renderBody('test-1', 'Hello **world**, this is a test response.')

    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('this is a test response.')
  })

  test('renders every block of a body that fits the first window', () => {
    const paragraphs = Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n')
    const html = renderBody('test-2', paragraphs)

    expect(html).toContain('Paragraph 1')
    expect(html).toContain('Paragraph 5')
  })

  test('the first mounted window of a long table already carries its header', () => {
    const rows = Array.from({ length: 500 }, (_, index) => `| a${index} | b${index} |`).join('\n')
    const html = renderBody('test-3', `| Alpha | Beta |\n| --- | --- |\n${rows}`)

    expect(html).toContain('<thead>')
    expect(html).toContain('Alpha')
    expect(html).toContain('a0')
    // Bounded: the tail of the table is not mounted, and a spacer stands in for it.
    expect(html).not.toContain('a499')
    expect(html).toContain('aria-hidden')
  })

  test('a pathological unbroken line gets the disclosed viewer and a full-source copy', () => {
    const html = renderBody('test-4', 'a'.repeat(400_000))

    expect(html).toContain('Long unbroken text is shown in parts.')
    expect(html).toContain('Copy full text')
    // The whole 400k characters are retained in state, never mounted at once.
    expect(html.length).toBeLessThan(200_000)
  })

  test('an open streaming fence shows its final line rather than a card', () => {
    const html = renderBody('test-5', 'Patch:\n\n```ts\nconst first = 1\nconst last = 2')

    expect(html).toContain('const last = 2')
    expect(html).not.toContain('<pre>')
  })

  test('scroll offset geometry keeps content visible when the message is in view', () => {
    // Scrolled deep into a transcript the message sits in the viewport, so
    // `scrollerRect.top - rootRect.top` is negative. Nothing may be skipped.
    const leaves = planMarkdownLeaves('msg-1', 'Here is the model answer.\n\nSecond line.')
    const leafWindow = selectMarkdownLeafWindow(leaves, -100, 800)

    expect(leafWindow.start).toBe(0)
    expect(leafWindow.topSpacerHeight).toBe(0)
    expect(leafWindow.end).toBeGreaterThan(0)
  })

  test('scroll offset geometry windows a large body once it is scrolled past', () => {
    const source = Array.from({ length: 2_000 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('msg-2', source)
    const leafWindow = selectMarkdownLeafWindow(leaves, 10_000, 800)

    expect(leafWindow.start).toBeGreaterThan(0)
    expect(leafWindow.topSpacerHeight).toBeGreaterThan(0)
    expect(leafWindow.end).toBeGreaterThan(leafWindow.start)
  })
})
