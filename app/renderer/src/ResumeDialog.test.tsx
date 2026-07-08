import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HydrationOverlay,
  ResumeConfirmDialog,
  resumeDialogActionForKey,
} from './ResumeDialog.js'

describe('ResumeConfirmDialog', () => {
  test('plain confirm copy + single cwd line when no cross-project diff', () => {
    const html = renderToStaticMarkup(
      <ResumeConfirmDialog
        cwd="/Users/pt/repo-a"
        onClose={() => {}}
        onConfirm={() => {}}
        title="repo-a"
      />,
    )
    expect(html).toContain('Resume session?')
    expect(html).not.toContain('Resume from a different project?')
    expect(html).toContain('/Users/pt/repo-a')
    expect(html).toContain('Resume here')
    expect(html).toContain('Cancel')
    // Cut per PARITY-LEDGER §28/FLOW-7: no MCP/plugins/permission diff list,
    // no copy-command escape hatch (TUI-only, N/A to desktop restore).
    expect(html).not.toContain('What will differ')
    expect(html).not.toContain('claude --resume')
  })

  test('cross-project framing + from->to badges only when cwd differs from the active tab', () => {
    const html = renderToStaticMarkup(
      <ResumeConfirmDialog
        currentCwd="/Users/pt/repo-b"
        cwd="/Users/pt/repo-a"
        onClose={() => {}}
        onConfirm={() => {}}
        title="repo-a"
      />,
    )
    expect(html).toContain('Resume from a different project?')
    expect(html).toContain('/Users/pt/repo-a')
    expect(html).toContain('/Users/pt/repo-b')
  })

  test('same cwd as the active tab does not trigger the cross-project framing', () => {
    const html = renderToStaticMarkup(
      <ResumeConfirmDialog
        currentCwd="/Users/pt/repo-a"
        cwd="/Users/pt/repo-a"
        onClose={() => {}}
        onConfirm={() => {}}
        title="repo-a"
      />,
    )
    expect(html).not.toContain('Resume from a different project?')
  })
})

describe('resumeDialogActionForKey', () => {
  test('Enter confirms, Escape cancels, everything else is ignored', () => {
    expect(resumeDialogActionForKey({ key: 'Enter' })).toBe('confirm')
    expect(resumeDialogActionForKey({ key: 'Escape' })).toBe('cancel')
    expect(resumeDialogActionForKey({ key: 'a' })).toBeNull()
  })
})

describe('HydrationOverlay', () => {
  test('loading state binds the real session title', () => {
    const html = renderToStaticMarkup(
      <HydrationOverlay
        onDismiss={() => {}}
        onRetry={() => {}}
        sessionTitle="repo-a"
        state="hydrating"
      />,
    )
    expect(html).toContain('Resuming')
    expect(html).toContain('repo-a')
    expect(html).toContain('Hydrating transcript from log')
    expect(html).not.toContain('Retry')
  })

  test('failed state renders the real error message when given one', () => {
    const html = renderToStaticMarkup(
      <HydrationOverlay
        message="transcript for session-1 is gone"
        onDismiss={() => {}}
        onRetry={() => {}}
        sessionTitle="repo-a"
        state="failed"
      />,
    )
    expect(html).toContain("Couldn")
    expect(html).toContain('transcript for session-1 is gone')
    expect(html).toContain('Retry')
    expect(html).toContain('Start fresh')
  })

  test('failed state falls back to the prototype copy when no message is given', () => {
    const html = renderToStaticMarkup(
      <HydrationOverlay
        onDismiss={() => {}}
        onRetry={() => {}}
        sessionTitle="repo-a"
        state="failed"
      />,
    )
    expect(html).toContain('failed to deserialize')
  })
})
