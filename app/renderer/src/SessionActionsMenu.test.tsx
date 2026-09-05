import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MergedSessionRow } from './sessionsCatalogState.js'
import { MENU_ITEM_SELECTOR } from './overlayFocus.js'
import { resolveSessionActions } from './sessionActions.js'
import {
  SessionActionsMenu,
  SessionRenamePopover,
} from './SessionActionsMenu.js'

const noop = () => {}

function row(overrides: Partial<MergedSessionRow> = {}): MergedSessionRow {
  return {
    sessionId: 'engine-1',
    appSessionId: 'app-1',
    cwd: '/w/proj',
    cwdExists: true,
    title: 'Refactor auth',
    displayLabel: 'Refactor auth',
    name: null,
    live: true,
    restorable: false,
    parked: false,
    status: 'ready',
    inRegistry: true,
    modifiedAtMs: 1,
    createdAtMs: 0,
    lastMessageSentAt: null,
    transcriptActivityAtMs: null,
    gitBranch: null,
    tag: null,
    mode: 'normal',
    agentSetting: null,
    prNumber: null,
    prRepository: null,
    ...overrides,
  }
}

function render(isActiveOpen: boolean, r: MergedSessionRow = row()): string {
  return renderToStaticMarkup(
    <SessionActionsMenu
      items={resolveSessionActions(r, { isActiveOpen })}
      anchor={{ top: 40, bottom: 58, left: 80 }}
      onAction={noop}
      onClose={noop}
    />,
  )
}

test('renders the menu with a scrim and the Session actions label', () => {
  const html = render(true)
  expect(html).toContain('Session actions')
  expect(html).toContain('role="menu"')
})

test('active-open row: Copy hosts a flyout and Inspect renders as a live menuitem button', () => {
  const html = render(true)
  // P4-30 — Copy became the flyout HOST (`SessionActions.jsx:174`): it renders
  // with a chevron and `aria-haspopup`, and it is NOT a dispatching button. Its
  // variants live in the submenu, which only opens on hover/focus.
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('Copy transcript for LLM')
  expect(html).toContain('Inspect metadata…')
  expect(html).toContain('<button')
})

test('P4-30: EVERY rendered row carries a glyph, including inside the flyout', () => {
  // Regression: `SessionActionIcon` fell through to `return null` for
  // `copy-text`, so that row drew an empty span in a `gap-2` flex and its label
  // sat a glyph-width left of its sibling. The union is now exhaustive at
  // compile time; this pins the rendered result.
  for (const item of resolveSessionActions(row(), { isActiveOpen: true })) {
    for (const each of [item, ...(item.flyout ?? [])]) {
      const html = renderToStaticMarkup(
        <SessionActionsMenu
          items={[each.flyout ? { ...each, flyout: undefined } : each]}
          anchor={{ top: 0, bottom: 0, left: 0 }}
          onAction={noop}
          onClose={noop}
        />,
      )
      expect(html).toContain('<svg')
    }
  }
})

test('P4-36: the hidden-row reveal renders as a live menuitem with its own glyph', () => {
  for (const hiddenRevealed of [false, true]) {
    const html = renderToStaticMarkup(
      <SessionActionsMenu
        items={resolveSessionActions(row(), {
          isActiveOpen: true,
          hasHiddenRows: true,
          hiddenRevealed,
        })}
        anchor={{ top: 0, bottom: 0, left: 0 }}
        onAction={noop}
        onClose={noop}
      />,
    )
    expect(html).toContain(
      hiddenRevealed ? 'Hide hidden messages' : 'Show hidden messages',
    )
    // The eye/eye-off pair: the struck-through variant carries the slash path,
    // which is how the two glyphs are told apart in static markup.
    expect(html.includes('M1 1l22 22')).toBe(hiddenRevealed)
  }
  // No hidden tier ⇒ the row is absent, not a disabled "soon" row.
  expect(render(true)).not.toContain('hidden messages')
})

test('P4-30: the flyout host is Tab-reachable, so folding Copy into it kept it keyboard-usable', () => {
  // Before the flyout, the copy verb was a plain <button> in the Tab order.
  // Without tabIndex the host is an unfocusable <div role="menuitem"> and the
  // onFocus open handler is dead code.
  const html = render(true)
  expect(html).toContain('tabindex="0"')
  expect(html).toContain('aria-haspopup="menu"')
})

test('P4-30: the menu renders leading icons, the View section label and the sa-pop entrance', () => {
  const html = render(true)
  // SA_IC icon slot — every row now carries a glyph, and the panel animates in.
  expect(html).toContain('animate-sa-pop')
  expect(html).toContain('<svg')
  expect(html).toContain('>View<')
})

test('Rename and Export render live while obsolete Branch and Rewind rows stay absent', () => {
  const html = render(true)
  expect(html).toContain('Rename')
  expect(html).toContain('Export…')
  expect(html).not.toContain('Branch from HEAD…')
  expect(html).not.toContain('Rewind…')
  expect(html).not.toContain('exportRenderer.tsx:91')
})

test('non-live row: Rename and Export render disabled with the live-engine reason', () => {
  const html = render(false, row({ live: false, restorable: true, status: 'exited' }))
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('live engine')
})

test('inactive row: Copy + Inspect are disabled with the open-first reason', () => {
  const html = render(false)
  expect(html).toContain('Open this session first')
})

test('cut verbs never render (no Tag/Archive/Delete)', () => {
  const html = render(true)
  expect(html).not.toContain('Archive')
  expect(html).not.toContain('Delete')
  expect(html.toLowerCase()).not.toContain('>tag<')
})

test('history-only row: Open is disabled, not a clickable button label', () => {
  const html = render(false, row({ appSessionId: null, inRegistry: false, live: false, status: 'history' }))
  expect(html).toContain('came from terminal history')
})

test('PEER-SESSIONS §6: the peer-reopen row renders as a checkable item that shows its state', () => {
  // A durable decision only the user can clear has to be READABLE after the menu
  // that set it closed. Rendering it as a plain verb row would leave the user no
  // way to tell a session that refuses peer wake-ups from one that does not.
  const off = render(true, row({ peerWakeBlocked: false }))
  expect(off).toContain('Don’t let peers reopen')
  expect(off).toContain('role="menuitemcheckbox"')
  expect(off).toContain('aria-checked="false"')

  const on = render(true, row({ peerWakeBlocked: true }))
  expect(on).toContain('aria-checked="true"')
  // The tick only exists in the checked render, and the label never changes.
  expect(on).toContain('20 6 9 17 4 12')
  expect(off).not.toContain('20 6 9 17 4 12')
  expect(on).toContain('Don’t let peers reopen')
})

test('PEER-SESSIONS §6: the peer-reopen row is arrow-key reachable like every other row', () => {
  // `menuitemcheckbox` is a role this menu's roving key handler had never seen.
  // The row renders as a real <button>, so Tab reaches it either way; only
  // MENU_ITEM_SELECTOR decides whether the ARROW keys do, and a row the arrows
  // skip reads as dead to anyone driving the menu from the keyboard.
  expect(render(true)).toContain('<button type="button" role="menuitemcheckbox"')
  expect(MENU_ITEM_SELECTOR).toContain(
    'button[role="menuitemcheckbox"]:not([disabled])',
  )
})

test('SessionRenamePopover prefills the input with the current title', () => {
  const html = renderToStaticMarkup(
    <SessionRenamePopover
      anchor={{ top: 40, bottom: 58, left: 80 }}
      initial="Refactor auth"
      onCommit={noop}
      onCancel={noop}
    />,
  )
  expect(html).toContain('role="dialog"')
  expect(html).toContain('aria-label="Rename session"')
  expect(html).toContain('value="Refactor auth"')
})

/**
 * P4-39 — the placement helper is unit-tested next door; these two pin that this
 * component actually CONSUMES it. A helper nothing calls was the failure mode
 * that produced this finding: the anchor's flip lived in a doc comment that
 * ceded it to call sites, and no call site implemented it.
 *
 * SSR has no window, so the panel is placed against the 1280x800 fallback.
 */
test('P4-39: a trigger near the bottom renders the menu anchored by `bottom`', () => {
  const html = renderToStaticMarkup(
    <SessionActionsMenu
      items={resolveSessionActions(row(), { isActiveOpen: true })}
      anchor={{ top: 700, bottom: 718, left: 800 }}
      onAction={noop}
      onClose={noop}
    />,
  )
  expect(html).toContain('bottom:104px')
  expect(html).not.toContain('top:718px')
})

test('P4-39: a raw right-click point past the right edge is clamped into the viewport', () => {
  const html = renderToStaticMarkup(
    <SessionActionsMenu
      items={resolveSessionActions(row(), { isActiveOpen: true })}
      anchor={{ top: 120, bottom: 120, left: 1270 }}
      onAction={noop}
      onClose={noop}
    />,
  )
  expect(html).toContain('left:1040px')
  expect(html).not.toContain('left:1270px')
})
