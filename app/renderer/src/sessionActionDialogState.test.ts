import { describe, expect, test } from 'bun:test'
import {
  branchPreviewLines,
  buildBulkExportDocument,
  bulkExportSavedMessage,
  describeSaveOutcome,
  exportFileName,
  selectBulkExportOutcome,
  selectExportPreview,
  selectLatchedExportPreview,
} from './sessionActionDialogState.js'

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

describe('describeSaveOutcome (P4-35)', () => {
  test('a written file is reported once, in the caller-supplied wording', () => {
    expect(describeSaveOutcome({ ok: true, saved: true }, 'Transcript saved')).toEqual({
      message: 'Transcript saved',
      tone: 'success',
    })
    expect(
      describeSaveOutcome({ ok: true, saved: true }, 'Saved 4 sessions to one file'),
    ).toEqual({ message: 'Saved 4 sessions to one file', tone: 'success' })
  })

  test('a dismissed save dialog says NOTHING', () => {
    // Cancelling IS the state the user just chose; restating it back is noise.
    expect(describeSaveOutcome({ ok: true, saved: false }, 'Transcript saved')).toBeNull()
  })

  test('a failure carries the message main sent, never a renderer guess', () => {
    expect(
      describeSaveOutcome(
        {
          ok: false,
          error: { code: 'write_failed', message: 'The file could not be written.' },
        },
        'Transcript saved',
      ),
    ).toEqual({ message: 'The file could not be written.', tone: 'warn' })
    expect(
      describeSaveOutcome(
        {
          ok: false,
          error: { code: 'invalid_name', message: 'That name cannot be used.' },
        },
        'Transcript saved',
      ),
    ).toEqual({ message: 'That name cannot be used.', tone: 'warn' })
  })
})

describe('buildBulkExportDocument (P4-35)', () => {
  test('each section is the engine text under its real title', () => {
    expect(
      buildBulkExportDocument([
        { title: 'Refactor auth', text: 'User: a\nAssistant: b' },
        { title: 'Fix the parser', text: 'User: c' },
      ]),
    ).toBe(
      '=== Refactor auth ===\n\nUser: a\nAssistant: b\n\n=== Fix the parser ===\n\nUser: c',
    )
  })

  test('the engine text is framed, never rewritten', () => {
    const text = 'line 1\n\n  indented\ntrailing   \n'
    expect(buildBulkExportDocument([{ title: 'T', text }])).toContain(text)
  })

  test('a session with no title gets an honest stand-in, not an empty heading', () => {
    for (const title of [null, '', '   ']) {
      expect(buildBulkExportDocument([{ title, text: 'x' }])).toBe(
        '=== Untitled session ===\n\nx',
      )
    }
  })

  test('one section produces no separator, and none produces nothing', () => {
    expect(buildBulkExportDocument([{ title: 'Only', text: 'x' }])).toBe(
      '=== Only ===\n\nx',
    )
    expect(buildBulkExportDocument([])).toBe('')
  })
})

describe('selectBulkExportOutcome (P4-35)', () => {
  const request = (sessionId: string, requestId: string, title: string | null = null) => ({
    sessionId,
    requestId,
    title,
  })
  const done = (requestId: string, exportText: string) => ({
    requestId,
    verb: 'export' as const,
    ok: true,
    message: 'Exported',
    exportText,
  })

  test('waits while ANY leg is still unsettled', () => {
    const requests = [request('s1', 'r1'), request('s2', 'r2')]
    expect(selectBulkExportOutcome(requests, {})).toEqual({ status: 'waiting' })
    expect(selectBulkExportOutcome(requests, { s1: done('r1', 'a') })).toEqual({
      status: 'waiting',
    })
  })

  test('settles into one section per session, in the order dispatched', () => {
    const outcome = selectBulkExportOutcome(
      [request('s1', 'r1', 'First'), request('s2', 'r2', 'Second')],
      { s2: done('r2', 'b'), s1: done('r1', 'a') },
    )
    expect(outcome).toEqual({
      status: 'settled',
      failed: 0,
      sections: [
        { title: 'First', text: 'a' },
        { title: 'Second', text: 'b' },
      ],
    })
  })

  test('a leg the sidecar could not render is COUNTED, not written into the file', () => {
    const outcome = selectBulkExportOutcome(
      [request('s1', 'r1', 'First'), request('s2', 'r2', 'Second')],
      {
        s1: done('r1', 'a'),
        s2: {
          requestId: 'r2',
          verb: 'export',
          ok: false,
          message: 'Transcript unreadable.',
        },
      },
    )
    expect(outcome.status).toBe('settled')
    if (outcome.status === 'settled') {
      expect(outcome.failed).toBe(1)
      expect(outcome.sections).toEqual([{ title: 'First', text: 'a' }])
    }
  })

  test('a leg whose engine died counts as failed instead of stranding the batch', () => {
    // An explicit null is the reducer recording a lifecycle reset. Waiting on it
    // would mean the other four transcripts never reach a file.
    const outcome = selectBulkExportOutcome(
      [request('s1', 'r1', 'First'), request('s2', 'r2')],
      { s1: done('r1', 'a'), s2: null },
    )
    expect(outcome).toEqual({
      status: 'settled',
      failed: 1,
      sections: [{ title: 'First', text: 'a' }],
    })
  })

  test('another action finishing mid-flight is never mistaken for this export', () => {
    // The runtime state keeps only the latest result per session. A rename result
    // landing in a leg's slot must read as pending, not as that leg completing.
    const requests = [request('s1', 'r1')]
    expect(
      selectBulkExportOutcome(requests, {
        s1: { requestId: 'other', verb: 'export', ok: true, message: 'ok', exportText: 'x' },
      }),
    ).toEqual({ status: 'waiting' })
    expect(
      selectBulkExportOutcome(requests, {
        s1: { requestId: 'r1', verb: 'rename', ok: true, message: 'Renamed' },
      }),
    ).toEqual({ status: 'waiting' })
  })

  test('every leg failing settles with no sections, so the caller can say so', () => {
    const outcome = selectBulkExportOutcome([request('s1', 'r1')], {
      s1: { requestId: 'r1', verb: 'export', ok: false, message: 'nope' },
    })
    expect(outcome).toEqual({ status: 'settled', failed: 1, sections: [] })
  })

  test('an empty batch is already settled', () => {
    expect(selectBulkExportOutcome([], {})).toEqual({
      status: 'settled',
      failed: 0,
      sections: [],
    })
  })
})

describe('bulkExportSavedMessage (P4-35)', () => {
  test('reports the count, and pluralizes it', () => {
    expect(bulkExportSavedMessage(1, 0)).toBe('Saved 1 session to one file')
    expect(bulkExportSavedMessage(4, 0)).toBe('Saved 4 sessions to one file')
  })

  test('names a shortfall only when there is one', () => {
    expect(bulkExportSavedMessage(4, 0)).not.toContain('of')
    expect(bulkExportSavedMessage(2, 3)).toBe(
      'Saved 2 of 5 sessions: the rest could not be read',
    )
  })

  test('carries no em dash and no engineering vocabulary (operator rules)', () => {
    for (const [ok, failed] of [
      [1, 0],
      [4, 0],
      [2, 3],
    ]) {
      const message = bulkExportSavedMessage(ok, failed)
      expect(message).not.toContain('—')
      expect(message).not.toMatch(/verb|frame|sidecar|requestId/i)
    }
  })
})
