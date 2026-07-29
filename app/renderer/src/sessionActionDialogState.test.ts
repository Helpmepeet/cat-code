import { describe, expect, test } from 'bun:test'
import {
  branchPreviewLines,
  exportFileName,
  selectExportPreview,
  selectLatchedExportPreview,
  sessionActionModalKeyAction,
} from './sessionActionDialogState.js'

describe('sessionActionModalKeyAction', () => {
  test('bare Escape closes the dialog', () => {
    expect(sessionActionModalKeyAction({ key: 'Escape' })).toBe('close')
  })

  test('any other key is not a dismissal', () => {
    for (const key of ['Enter', 'Tab', 'a', 'ArrowDown', 'escape']) {
      expect(sessionActionModalKeyAction({ key })).toBeNull()
    }
  })

  test('a modifier chord belongs to the app, not the dialog (⌘K still reaches the palette)', () => {
    expect(sessionActionModalKeyAction({ key: 'Escape', metaKey: true })).toBeNull()
    expect(sessionActionModalKeyAction({ key: 'Escape', ctrlKey: true })).toBeNull()
    expect(sessionActionModalKeyAction({ key: 'Escape', altKey: true })).toBeNull()
  })
})

describe('exportFileName', () => {
  test('slugifies the session title (the prototype rule)', () => {
    expect(exportFileName('Refactor auth')).toBe('refactor-auth.txt')
    expect(exportFileName('  Fix: the JWT/session bug!  ')).toBe(
      'fix-the-jwt-session-bug.txt',
    )
  })

  test('degrades to "session" rather than a bare extension', () => {
    expect(exportFileName(null)).toBe('session.txt')
    expect(exportFileName('')).toBe('session.txt')
    expect(exportFileName('!!!')).toBe('session.txt')
  })

  test('the extension follows the engine render path, which is text-only', () => {
    // md/json stay the owner-flagged §0 defer; the parameter exists so lifting
    // that defer is a one-line change, not a rewrite.
    expect(exportFileName('Refactor auth')).toEndWith('.txt')
    expect(exportFileName('Refactor auth', 'md')).toBe('refactor-auth.md')
  })
})

describe('selectExportPreview', () => {
  const ready = {
    requestId: 'req-1',
    verb: 'export' as const,
    ok: true,
    message: 'Exported.',
    exportText: '# transcript',
  }

  test('a matching successful export becomes the preview text', () => {
    expect(selectExportPreview(ready, 'req-1')).toEqual({
      status: 'ready',
      text: '# transcript',
    })
  })

  test('no result yet leaves the dialog pending', () => {
    expect(selectExportPreview(null, 'req-1')).toEqual({ status: 'pending' })
  })

  test('another request never renders as this dialog’s own result', () => {
    expect(selectExportPreview(ready, 'req-2')).toEqual({ status: 'pending' })
  })

  test('a rename/branch result that lands while the dialog is open is ignored', () => {
    const branch = { ...ready, verb: 'branch' as const }
    expect(selectExportPreview(branch, 'req-1')).toEqual({ status: 'pending' })
  })

  test('a failed export surfaces the sidecar’s real message, not an empty pane', () => {
    expect(
      selectExportPreview(
        { requestId: 'req-1', verb: 'export', ok: false, message: 'Transcript unreadable.' },
        'req-1',
      ),
    ).toEqual({ status: 'failed', message: 'Transcript unreadable.' })
  })

  test('ok with no text degrades to failed rather than an empty successful export', () => {
    expect(
      selectExportPreview(
        { requestId: 'req-1', verb: 'export', ok: true, message: 'Nothing to export.' },
        'req-1',
      ),
    ).toEqual({ status: 'failed', message: 'Nothing to export.' })
  })
})

describe('selectLatchedExportPreview', () => {
  const latched = {
    requestId: 'req-1',
    state: { status: 'ready', text: '# transcript' } as const,
  }

  test('a latched result survives a later unrelated action result', () => {
    // The regression this closes: the runtime state keeps only the LATEST result
    // per session, so a rename landing while the dialog is open used to blank the
    // rendered transcript back to pending and permanently re-disable Copy.
    expect(selectLatchedExportPreview(latched, 'req-1')).toEqual({
      status: 'ready',
      text: '# transcript',
    })
  })

  test('a SECOND export opens pending, never flashing the previous transcript', () => {
    expect(selectLatchedExportPreview(latched, 'req-2')).toEqual({
      status: 'pending',
    })
  })

  test('nothing latched yet reads pending', () => {
    expect(selectLatchedExportPreview(null, 'req-1')).toEqual({ status: 'pending' })
  })

  test('a latched FAILURE is kept too, not retried into pending', () => {
    const failed = {
      requestId: 'req-9',
      state: { status: 'failed', message: 'Transcript unreadable.' } as const,
    }
    expect(selectLatchedExportPreview(failed, 'req-9')).toEqual({
      status: 'failed',
      message: 'Transcript unreadable.',
    })
  })
})

describe('branchPreviewLines', () => {
  test('names the session it is forking', () => {
    expect(branchPreviewLines('Refactor auth').headline).toContain('Refactor auth')
  })

  test('falls back to a generic headline when the row has no title', () => {
    expect(branchPreviewLines(null).headline).toBe('A full copy of this session')
    expect(branchPreviewLines('   ').headline).toBe('A full copy of this session')
  })

  test('never invents the prototype’s "(branch)" name — the fork is named engine-side', () => {
    // `createFork` names the fork from its FIRST USER MESSAGE
    // (`sessionActionsDomain.ts:97-99`), which no frame carries before the
    // action runs. The callout states the rule instead of guessing the result.
    const { headline, detail } = branchPreviewLines('Refactor auth')
    expect(headline).not.toContain('(branch)')
    expect(detail).toContain('named after its first prompt')
  })

  test('never claims a keeps/drops split — the engine forks at HEAD and drops nothing', () => {
    const { detail } = branchPreviewLines('Refactor auth')
    expect(detail).toContain('Every message is copied')
    expect(detail).not.toMatch(/drops/i)
  })
})
