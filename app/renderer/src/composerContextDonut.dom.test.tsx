import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'

import { ContextUsagePanel } from './ComposerActionsBar.js'
import { createDomTestHarness } from './domTestHarness.js'
import type { DomTestHarness } from './domTestHarness.js'
import type { ContextBreakdownSnapshot } from '../../shared/protocol.js'

let harness: DomTestHarness

beforeAll(async () => {
  harness = await createDomTestHarness()
})

afterEach(async () => {
  await harness.unmountAll()
})

afterAll(async () => {
  await harness.teardown()
})

const BREAKDOWN: ContextBreakdownSnapshot = {
  categories: [
    { label: 'System prompt', tokens: 17_000, colorKey: 'promptBorder', deferred: false },
    { label: 'Messages', tokens: 300_000, colorKey: 'claude', deferred: false },
    { label: 'Skills', tokens: 2_000, colorKey: 'warning', deferred: false },
  ],
  usedTokens: 319_000,
  freeTokens: 661_000,
  contextWindow: 980_000,
  model: 'gpt-5.6-luna',
}

test('hovering categories leaves the center aggregate percentage unchanged', async () => {
  const usage = {
    usedTokens: 518_782,
    contextWindow: 980_000,
    percentUsed: 53,
  }

  const tree = await harness.mount(
    <ContextUsagePanel usage={usage} breakdown={BREAKDOWN} />,
  )

  // Find center text element
  const centerSpans = Array.from(tree.container.querySelectorAll('span')).filter(
    span => span.textContent === '53%',
  )
  expect(centerSpans.length).toBeGreaterThanOrEqual(2) // header line + ring center

  // Find category rows
  const categoryLabels = ['System prompt', 'Messages', 'Skills']
  for (const label of categoryLabels) {
    const labelSpan = Array.from(tree.container.querySelectorAll('span')).find(
      span => span.textContent?.includes(label),
    )
    expect(labelSpan).toBeDefined()
    const row = labelSpan?.closest('div')
    expect(row).toBeDefined()

    // Hover over category row
    act(() => {
      row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      row?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    })
    await harness.nextFrame()

    // Center percentage must remain 53%
    const currentCenterSpans = Array.from(
      tree.container.querySelectorAll('span'),
    ).filter(span => span.textContent === '53%')
    expect(currentCenterSpans.length).toBeGreaterThanOrEqual(2)

    // And must not show the category percentage (e.g. 300k/319k = 94%, 17k/319k = 5%, etc.)
    expect(tree.container.textContent).not.toContain('94%')
    expect(tree.container.textContent).not.toContain('5%')

    // Leave
    act(() => {
      row?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
      row?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }))
    })
    await harness.nextFrame()

    const afterCenterSpans = Array.from(
      tree.container.querySelectorAll('span'),
    ).filter(span => span.textContent === '53%')
    expect(afterCenterSpans.length).toBeGreaterThanOrEqual(2)
  }
})
