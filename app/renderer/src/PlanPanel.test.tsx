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

test('PlanPanel only offers links supported by the external opening policy', () => {
  const html = renderToStaticMarkup(
    <PlanPanel
      onApprove={() => {}}
      onClose={() => {}}
      onRevise={() => {}}
      open
      review={{ ...REVIEW, data: { ...REVIEW.data, plan: '[Relative source](src/app.ts)\n\n[Absolute source](/workspace/app.ts)\n\n[Rollback](#rollback)\n\n[Insecure website](http://example.com)\n\n[Documentation](https://example.com/docs)' } }}
    />,
  )
  expect(html).toContain('Relative source')
  expect(html).toContain('Absolute source')
  expect(html).toContain('Rollback')
  expect(html).toContain('Insecure website')
  expect(html).not.toContain('href="src/app.ts"')
  expect(html).not.toContain('href="/workspace/app.ts"')
  expect(html).not.toContain('href="#rollback"')
  expect(html).not.toContain('href="http://example.com"')
  expect(html).toContain('href="https://example.com/docs" target="_blank"')
})

test('PlanPanel renders the complete mixed Markdown plan and its approval context', () => {
  const html = renderToStaticMarkup(
    <PlanPanel
      onApprove={() => {}}
      onClose={() => {}}
      onRevise={() => {}}
      open
      review={{
        ...REVIEW,
        data: {
          ...REVIEW.data,
          plan: '# Migration\n\nOnly use the disposable staging database.\n\n1. Write the tests\n\n   Keep the original backup.\n\n2. Wire the domain\n   - Check the migrated schema.\n\n```sql\nSELECT COUNT(*) FROM staging;\n```\n\n## Rollback\n\nRestore the snapshot before retrying.',
        },
      }}
    />,
  )

  expect(html).toContain('/config/plans/kind-otter.md')
  expect(html).toContain('Only use the disposable staging database.')
  expect(html).toContain('<h1>Migration</h1>')
  expect(html).toContain('Write the tests')
  expect(html).toContain('Keep the original backup.')
  expect(html).toContain('Wire the domain')
  expect(html).toContain('Check the migrated schema.')
  expect(html).toContain('<pre>')
  expect(html).toContain('SELECT COUNT(*) FROM staging;')
  expect(html).toContain('<h2>Rollback</h2>')
  expect(html).toContain('Restore the snapshot before retrying.')
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

test('PlanPanel renders a prose-only plan', () => {
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

test('a submitted plan keeps close available while approval and revision are disabled', () => {
  const html = renderToStaticMarkup(
    <PlanPanel
      onApprove={() => {}}
      onClose={() => {}}
      onRevise={() => {}}
      open
      review={{ ...REVIEW, submitted: true }}
    />,
  )
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  const approve = buttons.find(button => button[2]?.includes('Approve plan'))
  const revise = buttons.find(button => button[2]?.includes('Revise…'))
  const close = buttons.find(button => button[1]?.includes('Close plan panel'))

  expect(approve?.[1]).toContain('disabled=""')
  expect(revise?.[1]).toContain('disabled=""')
  expect(close?.[1]).toBeDefined()
  expect(close?.[1]).not.toContain('disabled')
})
