import { expect, test } from 'bun:test'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AccountSwitcherPanel,
  ComposerActionsBar,
  ContextUsagePanel,
} from './ComposerActionsBar.js'
import { handleMenuRovingKeyDown } from './composerPopover.js'
import type { ContextUsage } from './contextUsage.js'
import type {
  AccountStatus,
  PermissionContextSnapshot,
  RunControlsSnapshot,
} from '../../shared/protocol.js'

function runControls(
  over: {
    model?: Partial<RunControlsSnapshot['model']>
    effort?: Partial<RunControlsSnapshot['effort']>
    fast?: Partial<RunControlsSnapshot['fast']>
  } = {},
): RunControlsSnapshot {
  return {
    model: {
      current: 'gpt-5.6-terra',
      selected: 'gpt-5.6-terra',
      options: [
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
        { value: 'opus', label: 'Opus', provider: 'anthropic' },
      ],
      ...over.model,
    },
    effort: {
      current: 'high',
      supported: true,
      options: ['low', 'medium', 'high'],
      ...over.effort,
    },
    fast: {
      active: false,
      supportedByModel: true,
      available: true,
      unavailableReason: null,
      ...over.fast,
    },
  }
}

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

function account(overrides: Partial<AccountStatus> = {}): AccountStatus {
  return {
    id: 'acct-1',
    alias: 'hiby',
    status: 'healthy',
    statusReason: null,
    availability: 'available',
    availabilityLabel: 'Available',
    isDefault: true,
    hasVaultProfile: true,
    source: 'vault',
    usagePrimary: 10,
    usageWeekly: 20,
    usageLimitReached: false,
    usageResetAt: null,
    lastRefreshIso: null,
    lastError: null,
    planType: null,
    switchable: false,
    ...overrides,
  }
}

function permissionContext(
  overrides: Partial<PermissionContextSnapshot> = {},
): PermissionContextSnapshot {
  return {
    mode: 'default',
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    additionalWorkingDirectories: [],
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

const USAGE: ContextUsage = {
  usedTokens: 42_000,
  contextWindow: 200_000,
  percentUsed: 21,
}

function render(props: Partial<Parameters<typeof ComposerActionsBar>[0]> = {}) {
  return renderToStaticMarkup(
    <ComposerActionsBar
      attachDisabled={false}
      onAttach={() => {}}
      model={null}
      reasoningEffort={null}
      fastMode={false}
      permissionContext={permissionContext()}
      onSetMode={() => {}}
      account={null}
      contextUsage={null}
      {...props}
    />,
  )
}

test('renders the REAL active-account alias from the snapshot fixture', () => {
  const html = render({ account: account({ alias: 'hiby' }) })
  expect(html).toContain('hiby')
  // Borderless face (the prototype's ColumnChipFace) — the real status rides the
  // title; healthy shows the quiet grey tone, not a dot.
  expect(html).toContain('Active account: hiby · healthy')
})

test('the account alias is always the prototype grey face; real status rides the title, not a tint', () => {
  const capped = render({ account: account({ status: 'capped' }) })
  expect(capped).toContain('Active account: hiby · capped')
  expect(capped).not.toContain('text-tone-warn')
  const dead = render({ account: account({ status: 'dead' }) })
  expect(dead).toContain('Active account: hiby · dead')
  expect(dead).not.toContain('text-tone-danger')
})

test('no account chip when there is no active account (cold start, never a stub)', () => {
  const html = render({ account: null })
  expect(html).not.toContain('Active account:')
})

test('an account with a null alias renders no alias chip (honest omission)', () => {
  const html = render({ account: account({ alias: null }) })
  expect(html).not.toContain('Active account:')
})

test('the permission MODE chip is always present (shows the real mode label)', () => {
  // The engine `default` mode is shown as "Ask" (the prototype label), not "Default".
  const html = render({ permissionContext: permissionContext({ mode: 'default' }) })
  expect(html).toContain('Ask')
  expect(html).not.toContain('Default')
  const plan = render({ permissionContext: permissionContext({ mode: 'plan' }) })
  expect(plan).toContain('Plan')
})

test('the context donut appears only when a real ContextUsage is present', () => {
  const withUsage = render({ contextUsage: USAGE })
  expect(withUsage).toContain('Context 21% used')
  const withoutUsage = render({ contextUsage: null })
  expect(withoutUsage).not.toContain('Context 21% used')
  expect(withoutUsage).not.toContain('% used')
})

test('the MODEL chip shows the resolved session model, never a fabricated label', () => {
  const withModel = render({ model: 'gpt-5.6-terra' })
  expect(withModel).toContain('gpt-5.6-terra')
  expect(withModel).toContain('Model: gpt-5.6-terra')

  // Absent before the snapshot arrives (null); never the prototype's mock literal.
  const cold = render({ model: null })
  expect(cold).not.toContain('Model:')
  expect(cold).not.toContain('GPT-5.4')
})

test('the REASONING chip shows the real effort tier, Title-cased, only when set', () => {
  const withEffort = render({ reasoningEffort: 'high' })
  expect(withEffort).toContain('High')
  expect(withEffort).toContain('Reasoning effort: high')

  // null = running at the provider default → no chip, not a fabricated "High".
  const noEffort = render({ reasoningEffort: null })
  expect(noEffort).not.toContain('Reasoning effort:')
})

test('effort labels match cat-code — xhigh renders "Extra high", not "Xhigh"', () => {
  const html = render({ reasoningEffort: 'xhigh' })
  expect(html).toContain('Extra high')
  expect(html).not.toContain('Xhigh')
})

test('the FAST ⚡ face renders only when fast mode is actually on', () => {
  const on = render({ fastMode: true })
  expect(on).toContain('Fast mode on')
  const off = render({ fastMode: false })
  expect(off).not.toContain('Fast mode on')
})

test('P4-24c — with runControls + handlers, the MODEL face becomes an interactive picker', () => {
  const html = render({
    model: 'gpt-5.6-terra',
    // Only the model face is interactive here (effort unsupported, fast off/unsupported),
    // so exactly TWO menu triggers render: the permission-mode chip + the model chip.
    runControls: runControls({
      effort: { supported: false, current: null },
      fast: { supportedByModel: false },
    }),
    onSetModel: () => {},
  })
  expect(html).toContain('gpt-5.6-terra')
  expect(html).toContain('Model: gpt-5.6-terra')
  expect(countOccurrences(html, 'aria-haspopup="menu"')).toBe(2)
})

test('P4-24c — the REASONING picker offers Auto even when no explicit tier is set', () => {
  const html = render({
    reasoningEffort: null,
    runControls: runControls({ effort: { supported: true, current: null } }),
    onSetEffort: () => {},
  })
  // Static path would omit the reasoning face when the tier is null; the interactive
  // picker shows the "Auto" face so the user can still pick a tier.
  expect(html).toContain('Auto')
  expect(html).toContain('Reasoning effort: auto')
})

test('P4-24c — the FAST toggle offers an enable affordance when off but supported', () => {
  const html = render({
    fastMode: false,
    runControls: runControls({ fast: { active: false, supportedByModel: true, available: true } }),
    onSetFast: () => {},
  })
  expect(html).toContain('Enable fast mode')
})

test('P4-24c — the FAST toggle is disabled with the real reason when unavailable', () => {
  const html = render({
    fastMode: false,
    runControls: runControls({
      fast: {
        active: false,
        supportedByModel: true,
        available: false,
        unavailableReason: 'Fast mode requires a paid subscription',
      },
    }),
    onSetFast: () => {},
  })
  expect(html).toContain('Fast mode requires a paid subscription')
  expect(html).toContain('disabled=""')
})

test('P4-24c — the FAST toggle is hidden when off AND the model cannot run fast', () => {
  const html = render({
    fastMode: false,
    runControls: runControls({ fast: { active: false, supportedByModel: false } }),
    onSetFast: () => {},
  })
  expect(html).not.toContain('Enable fast mode')
  expect(html).not.toContain('Fast mode on')
})

test('P4-24c — without runControls, the faces stay the P4-24 read-only static faces', () => {
  const html = render({ model: 'gpt-5.6-terra', reasoningEffort: 'high', fastMode: true })
  // The read-only fast face title (static), not the interactive toggle title.
  expect(html).toContain('Fast mode on')
  expect(html).not.toContain('Enable fast mode')
  // No model/effort menu triggers — only the permission-mode chip.
  expect(countOccurrences(html, 'aria-haspopup="menu"')).toBe(1)
})

// ── Profile account-switcher popover (the prototype's `AccountChip`) ──────────

test('with a switch handler, the account face becomes an interactive menu trigger', () => {
  // Read-only (no handler) → a <span> face, no menu trigger (existing tests). WITH
  // onSwitchAccount → the face is a <button aria-haspopup="menu"> that opens the
  // switcher. No runControls/model here, so the only OTHER trigger is the perm chip.
  const readOnly = render({ account: account({ alias: 'hiby' }) })
  expect(countOccurrences(readOnly, 'aria-haspopup="menu"')).toBe(1)

  const interactive = render({
    account: account({ alias: 'hiby' }),
    onSwitchAccount: () => {},
  })
  expect(countOccurrences(interactive, 'aria-haspopup="menu"')).toBe(2)
  // Same alias + title contract as the read-only face (real status on the title).
  expect(interactive).toContain('hiby')
  expect(interactive).toContain('Active account: hiby · healthy')
})

function pool(): AccountStatus[] {
  return [
    account({ id: 'a-hiby', alias: 'hiby', isDefault: true, switchable: false, usagePrimary: 10, usageWeekly: 20 }),
    account({ id: 'a-yox', alias: 'yoxrent', isDefault: false, switchable: true, usagePrimary: 55, usageWeekly: 40 }),
    account({
      id: 'a-cap',
      alias: 'oldcap',
      status: 'capped',
      availabilityLabel: 'Limit reached (resets in 2h)',
      isDefault: false,
      switchable: false,
      usageResetAt: null,
    }),
  ]
}

test('AccountSwitcherPanel lists the real pool with a healthy count', () => {
  const rows = pool()
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  expect(html).toContain('hiby')
  expect(html).toContain('yoxrent')
  expect(html).toContain('oldcap')
  // 2 of 3 healthy (hiby + yoxrent; oldcap is capped).
  expect(html).toContain('/3 healthy')
  expect(html).toContain('>2</span>/3 healthy')
})

test('AccountSwitcherPanel: only a switchable non-active row is an enabled switch target', () => {
  const rows = pool()
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  // The one switchable non-active row carries the switch affordance...
  expect(html).toContain('Switch to yoxrent')
  // ...and the active row + the capped row are BOTH unavailable as a switch
  // target (ACCT-6: aria-disabled, not native `disabled` — they stay in the
  // tab order so a keyboard user can still perceive their state).
  expect(countOccurrences(html, 'aria-disabled="true"')).toBe(2)
  expect(countOccurrences(html, 'aria-disabled="false"')).toBe(1)
  expect(html).not.toContain('disabled=""')
  expect(html).not.toContain('Switch to hiby')
  expect(html).not.toContain('Switch to oldcap')
})

test('AccountSwitcherPanel: a capped account shows its real availability label, not a hardcoded "Capped" (ACCT-1)', () => {
  const rows = pool()
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  expect(html).toContain('Limit reached (resets in 2h)')
  expect(html).not.toContain('>Capped<')
  // Only the capped row implies reset timing (the "· ↺" suffix).
  expect(html).toContain('· ↺ soon')
  // Healthy rows show real used-percent (10% / 20% for the active account).
  expect(html).toContain('10%')
  expect(html).toContain('20%')
})

test('AccountSwitcherPanel: dead and quarantined rows show their real label, never "Capped" (ACCT-1)', () => {
  const rows = [
    account({
      id: 'a-dead',
      alias: 'deadacct',
      status: 'dead',
      availabilityLabel: 'Needs re-login',
      switchable: false,
      usageResetAt: null,
    }),
    account({
      id: 'a-quarantined',
      alias: 'quaracct',
      status: 'quarantined',
      availabilityLabel: 'Connection issue (retrying)',
      switchable: false,
      usageResetAt: null,
    }),
  ]
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  expect(html).toContain('Needs re-login')
  expect(html).toContain('Connection issue (retrying)')
  expect(html).not.toContain('>Capped<')
  // Neither dead nor quarantined implies a reset timer.
  expect(html).not.toContain('↺')
})

test('AccountSwitcherPanel: the header count excludes a healthy account that hit its usage limit (ACCT-4)', () => {
  const rows = [
    account({ id: 'a-1', alias: 'one', status: 'healthy', usageLimitReached: false }),
    account({ id: 'a-2', alias: 'two', status: 'healthy', usageLimitReached: true }),
  ]
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  // Only 1 of 2 is truly ready, even though both report status 'healthy' —
  // matches the sidecar's readyCount predicate, not a bare status check.
  expect(html).toContain('>1</span>/2 healthy')
})

test('AccountSwitcherPanel: clicking a switchable row invokes onSwitch with its real id (ACCT-9)', () => {
  // This package has no DOM/click-simulation harness (see AccountsPage.test.tsx's
  // header comment) — the sibling convention is to exercise the EXACT handler a
  // click would fire, not a re-implementation, by calling the component function
  // directly and invoking the onClick prop off the returned element tree. Static
  // markup alone (the prior coverage) never proves the wiring is correct — it
  // can't fire a click, so a broken id or a dropped handler still renders fine.
  type ButtonEl = ReactElement<{ onClick?: () => void; children?: ReactNode }>
  type DivEl = ReactElement<{ className?: string; children?: ReactNode }>

  const rows = pool()
  const switched: string[] = []
  const element = AccountSwitcherPanel({
    active: rows[0]!,
    pool: rows,
    onSwitch: id => switched.push(id),
  })
  // Locate the rows container by its own marker className rather than a fixed
  // positional index, so inserting/reordering a sibling element in the panel's
  // JSX can't silently make this grab the wrong node.
  const rowsContainer = (element.props.children as DivEl[]).find(child =>
    child?.props?.className?.includes('max-h-[300px]'),
  )!
  const buttons = rowsContainer.props.children as ButtonEl[]

  const yoxRow = buttons.find(b => b.key === 'a-yox')!
  expect(typeof yoxRow.props.onClick).toBe('function')
  yoxRow.props.onClick?.()
  expect(switched).toEqual(['a-yox'])

  // The active row and the unavailable (capped) row are not switch targets —
  // no click handler is attached at all, so a click can never fire onSwitch.
  const activeRow = buttons.find(b => b.key === 'a-hiby')!
  expect(activeRow.props.onClick).toBeUndefined()
  const cappedRow = buttons.find(b => b.key === 'a-cap')!
  expect(cappedRow.props.onClick).toBeUndefined()
})

test('AccountSwitcherPanel: the Manage footer appears only when a handler is wired', () => {
  const rows = pool()
  const withManage = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} onManage={() => {}} />,
  )
  expect(withManage).toContain('Manage accounts →')
  const without = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  expect(without).not.toContain('Manage accounts →')
})

// ── Context donut usage popover (the prototype's `ContextChip`) ───────────────

test('the context donut is an interactive dialog trigger when usage is present (ACCT-3: informational, not a menu)', () => {
  // No runControls/account here, so the only OTHER trigger is the perm chip.
  const html = render({ contextUsage: USAGE })
  expect(countOccurrences(html, 'aria-haspopup="menu"')).toBe(1)
  expect(countOccurrences(html, 'aria-haspopup="dialog"')).toBe(1)
  // The donut visual + its readout survive (real percent, never fabricated).
  expect(html).toContain('Context 21% used')
})

test('ContextUsagePanel shows Plan usage (5h + weekly) plus the real Context total', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel
      usage={USAGE}
      account={account({ usagePrimary: 10, usageWeekly: 20, usageResetAt: null })}
    />,
  )
  expect(html).toContain('Plan usage')
  expect(html).toContain('5-hour limit')
  expect(html).toContain('Weekly · all models')
  expect(html).toContain('10%')
  expect(html).toContain('20%')
  // The 5h row carries the pool's single reset hint; null → the canonical "soon".
  expect(html).toContain('resets soon')
  // Aggregate Context row: real percent + "42k / 200k" (fmt), never a per-category bar.
  expect(html).toContain('Context')
  expect(html).toContain('42k / 200k')
})

test('ContextUsagePanel with no account shows the Context total only (no plan usage)', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} account={null} />,
  )
  expect(html).not.toContain('Plan usage')
  expect(html).toContain('Context')
  expect(html).toContain('42k / 200k')
})

test('ContextUsagePanel with an account whose usage is not yet fetched suppresses Plan usage (ACCT-10)', () => {
  // A real pre-poll state: the account exists but both usage fields are still
  // null (usage snapshot broadcast before refreshAccountsUsageOnce completes).
  // The gate is `account != null && (usagePrimary != null || usageWeekly != null)`
  // — this exercises the untested "account present, both usages null" branch.
  const html = renderToStaticMarkup(
    <ContextUsagePanel
      usage={USAGE}
      account={account({ usagePrimary: null, usageWeekly: null })}
    />,
  )
  expect(html).not.toContain('Plan usage')
  expect(html).not.toContain('5-hour limit')
  expect(html).not.toContain('Weekly · all models')
  expect(html).toContain('Context')
  expect(html).toContain('42k / 200k')
})

test('the attach button reflects the disabled gate (echo-only stub)', () => {
  const enabled = render({ attachDisabled: false })
  expect(enabled).toContain('aria-label="Add attachment"')
  expect(enabled).not.toContain('disabled=""')
  const disabled = render({ attachDisabled: true })
  expect(disabled).toContain('disabled=""')
})

// ── Feature #4: keyboard entry + roving faces ─────────────────────────────────
// Static-markup only (this package has no keydown-simulation harness): assert the
// faces are focusable with correct roles + roving tabindex. Live keyboard behavior
// (arrow roving, ArrowDown-to-open, Escape-to-textarea, the App.tsx entry points)
// is operator-GUI verified — SSR cannot fire a keydown.

test('the action bar is an ARIA toolbar (keyboard-navigable face group)', () => {
  const html = render()
  expect(html).toContain('role="toolbar"')
  expect(html).toContain('aria-label="Composer actions"')
  expect(html).toContain('aria-orientation="horizontal"')
})

test('roving tabindex: the first face (attach) is the single tab stop; others are -1', () => {
  // Default render → two interactive faces: the attach glyph + the permission chip.
  const html = render()
  // The attach glyph is always first and rests as the toolbar's single tab stop.
  expect(html).toContain('data-composer-face="attach" tabindex="0"')
  // Every other face is out of the tab order (-1); reached with the arrow keys.
  expect(html).toContain('data-composer-face="mode" tabindex="-1"')
  // Exactly one tab stop across the whole bar (the roving invariant).
  expect(countOccurrences(html, 'tabindex="0"')).toBe(1)
})

test('every interactive face carries a data-composer-face marker for roving + entry', () => {
  // A maximal bar: attach + model + effort + mode + fast + account + context.
  const html = render({
    model: 'gpt-5.6-terra',
    runControls: runControls(),
    onSetModel: () => {},
    onSetEffort: () => {},
    onSetFast: () => {},
    account: account({ alias: 'hiby' }),
    onSwitchAccount: () => {},
    contextUsage: USAGE,
  })
  for (const id of [
    'attach',
    'model',
    'effort',
    'mode',
    'fast',
    'account',
    'context',
  ]) {
    expect(html).toContain(`data-composer-face="${id}"`)
  }
  // Still exactly one tab stop (attach); the other six faces are all -1.
  expect(html).toContain('data-composer-face="attach" tabindex="0"')
  expect(countOccurrences(html, 'tabindex="0"')).toBe(1)
  expect(countOccurrences(html, 'tabindex="-1"')).toBe(6)
})

test('read-only faces (no handlers) are not roving triggers', () => {
  // Read-only model/effort/account render as <span> display faces, not buttons,
  // so they never join the roving group — only attach + the perm chip do.
  const html = render({ model: 'gpt-5.6-terra', reasoningEffort: 'high' })
  expect(countOccurrences(html, 'data-composer-face')).toBe(2)
  expect(html).toContain('data-composer-face="attach"')
  expect(html).toContain('data-composer-face="mode"')
  expect(html).not.toContain('data-composer-face="model"')
  expect(html).not.toContain('data-composer-face="effort"')
})

// ── Feature #13: in-panel arrow roving inside the popovers ────────────────────
// The pure roving math (wrap-around, Home/End, non-roving-key fall-through) is
// unit-tested in composerPopover.test.ts. Here we prove the shared handler is
// actually WIRED onto a real menu panel — the account switcher is the one open
// panel reachable without a DOM (AccountSwitcherPanel is exported + pure). The
// Model / Reasoning / Permission-mode panels only mount on client open-state, so
// their identical `onKeyDown={handleMenuRovingKeyDown}` wiring + the live key
// behaviour of ALL four are operator-GUI owed (SSR cannot fire a keydown).

test('AccountSwitcherPanel wires the shared in-panel roving handler onto its menu (Feature #13)', () => {
  const rows = pool()
  const element = AccountSwitcherPanel({ active: rows[0]!, pool: rows, onSwitch: () => {} })
  expect(element.props.role).toBe('menu')
  expect(element.props.onKeyDown).toBe(handleMenuRovingKeyDown)
})

test('AccountSwitcherPanel rows carry no native `disabled`, so roving includes the aria-disabled active/capped rows (ACCT-6)', () => {
  // The roving selector excludes only natively `disabled` items; aria-disabled
  // rows stay focusable landing spots. Proven here by the absence of any native
  // `disabled=""` on the account rows (they are aria-disabled instead).
  const rows = pool()
  const html = renderToStaticMarkup(
    <AccountSwitcherPanel active={rows[0]!} pool={rows} onSwitch={() => {}} />,
  )
  expect(html).not.toContain('disabled=""')
  expect(countOccurrences(html, 'aria-disabled="true"')).toBe(2)
})
