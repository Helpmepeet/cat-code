/**
 * P4-30 — `BranchDialog` + `ExportDialog` (PARITY-LEDGER §17 rows 1281-1300).
 *
 * The state matrix each dialog is checked against: open-default, a long title,
 * the disabled/invalid button state, and (export) the pending / ready / failed
 * preview. Interaction handlers are read off the element the way
 * `SAModal.test.tsx` does, since this package has no DOM click harness.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BranchDialog, ExportDialog } from './SessionActionDialogs.js'

const LONG_TITLE =
  'Refactor the authentication module to use JWT tokens instead of session cookies everywhere'

test('BranchDialog: confirmation chrome — title, Cancel and the primary action', () => {
  const html = renderToStaticMarkup(
    <BranchDialog title="Refactor auth" onConfirm={() => {}} onClose={() => {}} />,
  )
  expect(html).toContain('aria-label="Branch session"')
  expect(html).toContain('Cancel')
  expect(html).toContain('Create branch')
  expect(html).toContain('Refactor auth')
})

test('BranchDialog: the gate is real — nothing is dispatched until the primary action', () => {
  // The live defect this dialog closes: `session.branch` used to fire straight
  // off the menu click. Cancel and the primary must be different callbacks.
  let confirmed = 0
  let closed = 0
  const el = BranchDialog({
    title: 'Refactor auth',
    onConfirm: () => (confirmed += 1),
    onClose: () => (closed += 1),
  }) as never as { props: { footer: { props: { children: { props: Record<string, unknown> }[] } } } }
  const [cancel, create] = el.props.footer.props.children
  expect(cancel.props.label).toBe('Cancel')
  expect(create.props.label).toBe('Create branch')
  expect(create.props.variant).toBe('primary')

  ;(cancel.props.onClick as () => void)()
  expect(confirmed).toBe(0)
  expect(closed).toBe(1)
  ;(create.props.onClick as () => void)()
  expect(confirmed).toBe(1)
})

test('BranchDialog: a long title truncates rather than blowing out the callout', () => {
  const html = renderToStaticMarkup(
    <BranchDialog title={LONG_TITLE} onConfirm={() => {}} onClose={() => {}} />,
  )
  expect(html).toContain(LONG_TITLE)
  expect(html).toContain('truncate')
})

test('BranchDialog: a titleless row still reads as a full sentence', () => {
  const html = renderToStaticMarkup(
    <BranchDialog title={null} onConfirm={() => {}} onClose={() => {}} />,
  )
  expect(html).toContain('A full copy of this session')
})

test('ExportDialog: pending shows an honest wait, not an empty pane or a fake transcript', () => {
  const html = renderToStaticMarkup(
    <ExportDialog
      title="Refactor auth"
      fileName="refactor-auth.txt"
      preview={{ status: 'pending' }}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('Rendering this session')
  expect(html).not.toContain('<pre')
  // Copy cannot act on a transcript that has not arrived.
  expect(html).toContain('The transcript is still rendering.')
})

test('ExportDialog: ready renders the engine text in the preview pane plus the file name', () => {
  const html = renderToStaticMarkup(
    <ExportDialog
      title="Refactor auth"
      fileName="refactor-auth.txt"
      preview={{ status: 'ready', text: 'User: hello\nAssistant: hi' }}
      onCopy={() => {}}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('<pre')
  expect(html).toContain('User: hello')
  expect(html).toContain('refactor-auth.txt')
  expect(html).toContain('font-mono')
})

test('ExportDialog: a failed export surfaces the sidecar message, never a blank success', () => {
  const html = renderToStaticMarkup(
    <ExportDialog
      title="Refactor auth"
      fileName="refactor-auth.txt"
      preview={{ status: 'failed', message: 'Transcript unreadable.' }}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('Transcript unreadable.')
  expect(html).not.toContain('<pre')
})

test('ExportDialog: Copy is wired to the transcript that actually arrived', () => {
  let copied = 0
  const el = ExportDialog({
    title: 'Refactor auth',
    fileName: 'refactor-auth.txt',
    preview: { status: 'ready', text: 'body' },
    onCopy: () => (copied += 1),
    onClose: () => {},
  }) as never as { props: { footer: { props: { children: { props: Record<string, unknown> }[] } } } }
  const [, copy, download] = el.props.footer.props.children
  expect(copy.props.label).toBe('Copy')
  ;(copy.props.onClick as () => void)()
  expect(copied).toBe(1)

  // §0 — Download is the flagged capability gap: no renderer-reachable file
  // write exists, so it ships DISABLED with an honest reason, never as a
  // Potemkin primary that silently does nothing.
  expect(download.props.label).toBe('Download')
  expect(download.props.disabled).toBe(true)
  expect(download.props.onClick).toBeUndefined()
  expect(String(download.props.reason)).toContain('not available')
})

test('ExportDialog: Download stays disabled in every preview state', () => {
  for (const preview of [
    { status: 'pending' } as const,
    { status: 'ready', text: 'x' } as const,
    { status: 'failed', message: 'nope' } as const,
  ]) {
    const html = renderToStaticMarkup(
      <ExportDialog
        title="T"
        fileName="t.txt"
        preview={preview}
        onCopy={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('Saving to a file is not available')
    // Visible state marker, not a hover-only tooltip.
    expect(html).toContain('>soon<')
  }
})

test('ExportDialog: the subtitle carries the title only — no invented message count', () => {
  // `MergedSessionRow.messageCount` is never populated by the bounded catalog
  // loader (`sessionsCatalogState.ts:374`), so the prototype's "N messages · title"
  // would read "0 messages" for every session.
  const html = renderToStaticMarkup(
    <ExportDialog
      title="Refactor auth"
      fileName="refactor-auth.txt"
      preview={{ status: 'ready', text: 'body' }}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('Refactor auth')
  expect(html).not.toContain('messages ·')
  expect(html).not.toContain('0 messages')
})

test('ExportDialog: the wide prototype width, not the default', () => {
  const html = renderToStaticMarkup(
    <ExportDialog
      title="T"
      fileName="t.txt"
      preview={{ status: 'pending' }}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('w-[580px]')
})
