/**
 * P4-30 — `ExportDialog` (PARITY-LEDGER §17 rows 1281-1300).
 *
 * The state matrix each dialog is checked against: open-default, a long title,
 * the disabled/invalid button state, and (export) the pending / ready / failed
 * preview. Interaction handlers are read off the element the way
 * `SAModal.test.tsx` does, since this package has no DOM click harness.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportDialog } from './SessionActionDialogs.js'

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

test('ExportDialog: Copy and Download are wired to the transcript that actually arrived', () => {
  let copied = 0
  let downloaded = 0
  const el = ExportDialog({
    title: 'Refactor auth',
    fileName: 'refactor-auth.txt',
    preview: { status: 'ready', text: 'body' },
    onCopy: () => (copied += 1),
    onDownload: () => (downloaded += 1),
    onClose: () => {},
  }) as never as { props: { footer: { props: { children: { props: Record<string, unknown> }[] } } } }
  const [, copy, download] = el.props.footer.props.children
  expect(copy.props.label).toBe('Copy')
  ;(copy.props.onClick as () => void)()
  expect(copied).toBe(1)

  // P4-35 — Download is live now that a file sink exists (`saveTextToFile`), and
  // it is the PRIMARY, as the prototype has it.
  expect(download.props.label).toBe('Download')
  expect(download.props.variant).toBe('primary')
  expect(download.props.disabled).toBeUndefined()
  ;(download.props.onClick as () => void)()
  expect(downloaded).toBe(1)
  // The disabled reason and its `soon` marker are gone with the gap.
  expect(download.props.reason).toBeUndefined()
  expect(download.props.marker).toBeUndefined()
})

test('ExportDialog: neither action is live before a transcript arrives', () => {
  // The Potemkin case: a primary that looks pressable and saves nothing. Both
  // buttons wait on the SAME condition and say the same honest thing.
  for (const preview of [
    { status: 'pending' } as const,
    { status: 'failed', message: 'nope' } as const,
  ]) {
    const el = ExportDialog({
      title: 'T',
      fileName: 't.txt',
      preview,
      onCopy: () => {},
      onDownload: () => {},
      onClose: () => {},
    }) as never as {
      props: { footer: { props: { children: { props: Record<string, unknown> }[] } } }
    }
    const [, copy, download] = el.props.footer.props.children
    for (const button of [copy, download]) {
      expect(button.props.disabled).toBe(true)
      expect(button.props.onClick).toBeUndefined()
      expect(String(button.props.reason)).toContain('still rendering')
    }
  }

  // And a ready transcript with no handler supplied stays disabled rather than
  // rendering a live button over a missing callback.
  const orphan = ExportDialog({
    title: 'T',
    fileName: 't.txt',
    preview: { status: 'ready', text: 'x' },
    onClose: () => {},
  }) as never as {
    props: { footer: { props: { children: { props: Record<string, unknown> }[] } } }
  }
  const [, , orphanDownload] = orphan.props.footer.props.children
  expect(orphanDownload.props.disabled).toBe(true)
})

test('ExportDialog: the export gap marker is gone from the rendered footer', () => {
  const html = renderToStaticMarkup(
    <ExportDialog
      title="T"
      fileName="t.txt"
      preview={{ status: 'ready', text: 'x' }}
      onCopy={() => {}}
      onDownload={() => {}}
      onClose={() => {}}
    />,
  )
  expect(html).not.toContain('>soon<')
  expect(html).not.toContain('not available')
})

test('ExportDialog: the subtitle carries the title only — no invented message count', () => {
  // The bounded catalog intentionally omits a message count
  // (`sessionsCatalogState.ts:374`), so the prototype's "N messages · title"
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
