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
    ruleMetadata: [],
    managedRulesOnly: false,
    permissionClassifierEnabled: false,
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

/**
 * A preview pane has no engine, and a live pane has not read
 * `permission.context` yet. Every session HAS a mode, so a face reading
 * "unknown" (or "none") states something about the operator's session that
 * this pane never received. Rendering nothing is the honest answer, and it is
 * what keeps the preview rail from showing a row of empty placeholders.
 */
test('no context yet → the chip renders nothing at all', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={null} onSetMode={() => {}} />,
  )
  expect(html).toBe('')
})

test('classifier-backed auto renders as Auto rather than the restrictive dontAsk policy', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('auto')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Auto')
  expect(html).toContain('aria-label="Permission mode: Auto"')
  expect(html).not.toContain("Don't ask")
})

test('dontAsk is presented under its truthful restrictive name', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('dontAsk')} onSetMode={() => {}} />,
  )
  expect(html).toContain("Don&#x27;t ask")
  expect(html).toContain('aria-label="Permission mode: Don&#x27;t ask"')
  expect(html).not.toContain('Permission mode: Auto')
})

test('bypassPermissions renders as "Bypass" (amber) — the prototype 5th mode', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('bypassPermissions')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Bypass')
  expect(html).toContain('aria-label="Permission mode: Bypass"')
  expect(html).toContain('text-amber-400')
})

test('an unrecognized mode uses a neutral label rather than leaking its raw name', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={ctx('someFutureMode')} onSetMode={() => {}} />,
  )
  expect(html).toContain('Unknown mode')
  expect(html).not.toContain('someFutureMode')
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

/**
 * A previewed session has no engine, but its cached transcript records the
 * mode it ran under. That is real data, so the rail shows it as a quiet face
 * rather than a gap — read-only, because there is no engine here to switch.
 */
test('no context but a cached mode → a read-only face, not a picker', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip
      context={null}
      readOnlyMode="acceptEdits"
      onSetMode={() => {}}
    />,
  )
  expect(html).toContain('Accept edits')
  // No trigger, so nothing suggests it can be changed.
  expect(html).not.toContain('<button')
  expect(html).not.toContain('aria-haspopup')
})

test('a cached auto session uses the same friendly label as a live session', () => {
  const html = renderToStaticMarkup(
    <PermissionModeChip context={null} readOnlyMode="auto" onSetMode={() => {}} />,
  )
  expect(html).toContain('Auto')
})
