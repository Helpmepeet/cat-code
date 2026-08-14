import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoundedMarkdown } from './BoundedMarkdown.js'
import { selectMarkdownLeafWindow, planMarkdownLeaves } from './markdownRenderPlan.js'

describe('BoundedMarkdown', () => {
  test('renders markdown leaves without crashing', () => {
    const html = renderToStaticMarkup(
      <BoundedMarkdown
        sourceId="test-1"
        source="Hello world, this is a test response."
        renderLeaf={leaf => <p key={leaf.id}>{leaf.content}</p>}
      />,
    )

    expect(html).toContain('Hello world, this is a test response.')
  })

  test('renders multiple leaves for long markdown content', () => {
    const paragraphs = Array.from({ length: 5 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n')
    const html = renderToStaticMarkup(
      <BoundedMarkdown
        sourceId="test-2"
        source={paragraphs}
        renderLeaf={leaf => <p key={leaf.id}>{leaf.content}</p>}
      />,
    )

    expect(html).toContain('Paragraph 1')
    expect(html).toContain('Paragraph 5')
  })

  test('renders copy control for atomic-text leaf', () => {
    const longUnbrokenText = 'a'.repeat(25_000)
    const html = renderToStaticMarkup(
      <BoundedMarkdown
        sourceId="test-3"
        source={longUnbrokenText}
        renderLeaf={leaf => <p key={leaf.id}>{leaf.content}</p>}
      />,
    )

    expect(html).toContain('Long unbroken text is shown in parts.')
    expect(html).toContain('Copy full text')
  })

  test('scroll offset geometry keeps content visible when transcript is scrolled down to a message', () => {
    // When the user has scrolled deep into a transcript, the message is in the viewport:
    // rootRect.top is close to scrollerRect.top (e.g. scrollerRect.top = 100, rootRect.top = 200).
    // scrollOffset = scrollerRect.top - rootRect.top = -100px.
    const leaves = planMarkdownLeaves('msg-1', 'Here is the model answer.\n\nSecond line.')
    const leafWindow = selectMarkdownLeafWindow(leaves, -100, 800)

    // The content at the top of the message must NOT be skipped (topSpacerHeight must be 0)
    expect(leafWindow.start).toBe(0)
    expect(leafWindow.topSpacerHeight).toBe(0)
    expect(leafWindow.end).toBeGreaterThan(0)
  })

  test('scroll offset geometry correctly windows large markdown when scrolled past top', () => {
    const source = Array.from({ length: 1000 }, (_, index) => `Paragraph ${index}\n`).join('\n')
    const leaves = planMarkdownLeaves('msg-2', source)

    // When the top 10000px of this specific message has scrolled above the scroller viewport:
    // scrollerRect.top - rootRect.top = 10000px.
    const leafWindow = selectMarkdownLeafWindow(leaves, 10_000, 800)

    expect(leafWindow.start).toBeGreaterThan(0)
    expect(leafWindow.topSpacerHeight).toBeGreaterThan(0)
    expect(leafWindow.end).toBeGreaterThan(leafWindow.start)
  })
})
