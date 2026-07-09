import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanBar, PlanPanel } from './PlanPanel.js'
import type { PlanReview } from './planState.js'

const REVIEW: PlanReview = {
  request: {
    requestId: 'perm-plan-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'ExitPlanMode',
      input: {},
      tool_use_id: 'toolu-plan-1',
    },
  },
  submitted: false,
  data: {
    plan: '1. Write the tests\n2. Wire the domain',
    planFilePath: '/config/plans/kind-otter.md',
    allowedPrompts: [{ tool: 'Bash', prompt: 'run the test suite' }],
  },
}

test('PlanBar renders nothing without a pending plan review', () => {
  const html = renderToStaticMarkup(<PlanBar onOpen={() => {}} review={null} />)
  expect(html).toBe('')
})

test('PlanBar shows the real derived step count and a reopen affordance', () => {
  const html = renderToStaticMarkup(<PlanBar onOpen={() => {}} review={REVIEW} />)

  expect(html).toContain('Plan mode')
  expect(html).toContain('2-step plan ready for review')
  expect(html).toContain('View plan')
})

test('PlanBar falls back to a plain label when the plan has no parseable steps', () => {
  const html = renderToStaticMarkup(
    <PlanBar
      onOpen={() => {}}
      review={{ ...REVIEW, data: { ...REVIEW.data, plan: 'Just prose, no list.' } }}
    />,
  )

  expect(html).toContain('Plan ready for review')
})

test('PlanPanel renders nothing when closed or without a review', () => {
  expect(
    renderToStaticMarkup(
      <PlanPanel onApprove={() => {}} onClose={() => {}} onRevise={() => {}} open={false} review={REVIEW} />,
    ),
  ).toBe('')
  expect(
    renderToStaticMarkup(
      <PlanPanel onApprove={() => {}} onClose={() => {}} onRevise={() => {}} open review={null} />,
    ),
  ).toBe('')
})

test('PlanPanel renders the real plan file, parsed steps, and allowedPrompts', () => {
  const html = renderToStaticMarkup(
    <PlanPanel onApprove={() => {}} onClose={() => {}} onRevise={() => {}} open review={REVIEW} />,
  )

  expect(html).toContain('/config/plans/kind-otter.md')
  expect(html).toContain('Write the tests')
  expect(html).toContain('Wire the domain')
  // Honesty copy (review fix 2026-07-09): the header no longer implies an
  // automatic grant; the chips are listed for context, still gated per use.
  expect(html).toContain('Tools this plan expects to use')
  expect(html).toContain('still confirmed when it runs')
  expect(html).toContain('run the test suite')
  expect(html).toContain('Approve plan')
  expect(html).toContain('Revise')
  expect(html).toContain('read-only until you approve')
  // The "executing" sub-state and its persistent progress line have no
  // engine backing (PARITY-LEDGER.md §24) — never rendered here.
  expect(html).not.toContain('executing')
  expect(html).not.toContain('Executing:')
})

test('PlanPanel falls back to the raw plan text when it has no parseable steps', () => {
  const html = renderToStaticMarkup(
    <PlanPanel
      onApprove={() => {}}
      onClose={() => {}}
      onRevise={() => {}}
      open
      review={{ ...REVIEW, data: { ...REVIEW.data, plan: 'Just prose, no list.' } }}
    />,
  )

  expect(html).toContain('Just prose, no list.')
})
