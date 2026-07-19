import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionModeChip } from './PermissionModeChip.js'
import type { PermissionContextSnapshot } from '../../shared/protocol.js'

// Minimal permission context (the popover's rule lists are empty).
function ctx(mode: string): PermissionContextSnapshot {
  return {
    mode,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: [],
    isBypassPermissionsModeAvailable: false,
  }
}

// renderToStaticMarkup shows the chip FACE only (the popover is client state);
// these assert the tinted label + accessible name mapping.

test('renders the current mode with a friendly label + accessible name', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('plan')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Plan')
  expect(html).toContain('aria-label="Permission mode: Plan"')
  expect(html).toContain('text-sky-400')
})

test('the engine `default` mode is presented as "Ask" (the prototype label), not "Default"', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('default')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Ask')
  expect(html).toContain('aria-label="Permission mode: Ask"')
  expect(html).not.toContain('Default')
})

test('acceptEdits maps to its friendly label + tone', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('acceptEdits')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Accept edits')
  expect(html).toContain('text-emerald-400')
})

test('no context yet → disabled chip, unknown label', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={null} onSetMode={() => {}} />,
  )
  expect(html).toContain('disabled')
  expect(html).toContain('aria-label="Permission mode: unknown"')
})

test('bypassPermissions renders as "Bypass" (amber) — the prototype 5th mode', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('bypassPermissions')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Bypass')
  expect(html).toContain('aria-label="Permission mode: Bypass"')
  expect(html).toContain('text-amber-400')
})

test('an unrecognized mode falls back to its raw name (no crash)', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('someFutureMode')} onSetMode={() => {}} />,
  )
  expect(html).toContain('someFutureMode')
})

// ── Feature #13: adopting the shared usePopover lifecycle + in-panel roving ────
// The chip now shares the run-control chips' popover machinery (composerPopover):
// first-item focus on open, Escape/selection focus-restore to the trigger, and
// ArrowUp/Down/Home/End roving over the mode rows (bypass is natively `disabled`
// and skipped). The pure roving math is in composerPopover.test.ts; the live key
// behaviour is operator-GUI owed — SSR renders only the CLOSED face (the popover
// is client open-state, and the component uses hooks so it can't be called as a
// plain function). These guard that the refactor kept the closed-face contract.

test('the trigger stays a menu button and still spreads the roving-tabindex faceProps (Feature #4/#13)', () => {
  // `ref={triggerRef}` now precedes the faceProps spread — assert the spread still
  // wins so the chip keeps joining the toolbar roving group.
  const html = renderToStaticMarkup(
    <PermissionModeChip
      context={ctx('plan')}
      onSetMode={() => {}}
      faceProps={{ 'data-composer-face': 'mode', tabIndex: 0, onFocus: () => {} }}
    />,
  )
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('data-composer-face="mode"')
  expect(html).toContain('tabindex="0"')
})
