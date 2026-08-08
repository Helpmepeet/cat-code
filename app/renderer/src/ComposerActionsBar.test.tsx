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
  AnthropicAccountStatus,
  PermissionContextSnapshot,
  RunControlsSnapshot,
} from '../../shared/protocol.js'

function runControls(
  over: {
    model?: Partial<RunControlsSnapshot['model']>
    effort?: Partial<RunControlsSnapshot['effort']>
    fast?: Partial<RunControlsSnapshot['fast']>
    autoCompact?: Partial<RunControlsSnapshot['autoCompact']>
  } = {},
): RunControlsSnapshot {
  return {
    model: {
      current: 'gpt-5.6-terra',
      currentLabel: 'GPT-5.6 Terra',
      contextWindow: 372_000,
      selected: 'gpt-5.6-terra',
      provider: 'openai',
      providerSwitchLocked: false,
      options: [
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
        { value: 'opus', label: 'Opus', provider: 'anthropic' },
      ],
      ...over.model,
    },
    effort: {
      current: 'high',
      selected: 'high',
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
    autoCompact: {
      // Default: thresholds absent, so the warning glyph stays hidden and the
      // pre-existing rail assertions keep counting only the faces they were
      // written for.
      enabled: true,
      threshold: null,
      warningThreshold: null,
      ...over.autoCompact,
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

function anthropicAccount(
  overrides: Partial<AnthropicAccountStatus> = {},
): AnthropicAccountStatus {
  return {
    id: 'anthropic-1',
    alias: 'claude-main',
    email: 'user@example.com',
    status: 'healthy',
    isDefault: true,
    hasVaultProfile: true,
    subscriptionType: 'max',
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
    ruleMetadata: [],
    managedRulesOnly: false,
    permissionClassifierEnabled: false,
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
  expect(html).toContain('Active account: hiby · Available')
})

test('the account tooltip reads the pool label, never the raw status word', () => {
  // The tooltip used to append `account.status`, so a user hovering a limited
  // account read the word "capped" — an internal enum, not the pool's own
  // sentence about it (the same label the switcher rows already show).
  const capped = render({
    account: account({
      status: 'capped',
      availabilityLabel: 'Limit reached (resets in 2h)',
    }),
  })
  expect(capped).toContain('Active account: hiby · Limit reached (resets in 2h)')
  expect(capped).not.toContain('· capped')
  expect(capped).not.toContain('text-tone-warn')
  const dead = render({
    account: account({ status: 'dead', availabilityLabel: 'Needs re-login' }),
  })
  expect(dead).toContain('Active account: hiby · Needs re-login')
  expect(dead).not.toContain('· dead')
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

test('an Anthropic-routed session renders its Claude account instead of a Codex account', () => {
  const html = render({
    account: null,
    anthropicAccount: anthropicAccount(),
  })
  expect(html).toContain('claude-main')
  // A named state, not the raw `healthy`/`dead` enum the wire carries.
  expect(html).toContain('Active Anthropic account: claude-main · Ready')
  expect(html).not.toContain('· healthy')
  expect(html).not.toContain('Active account: hiby')

  const dead = render({
    account: null,
    anthropicAccount: anthropicAccount({ status: 'dead' }),
  })
  expect(dead).toContain('Active Anthropic account: claude-main · Needs re-login')
  expect(dead).not.toContain('· dead')
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
      effort: { supported: false, current: null, selected: null },
      fast: { supportedByModel: false },
    }),
    onSetModel: () => {},
  })
  expect(html).toContain('GPT-5.6 Terra')
  expect(html).toContain('Model: GPT-5.6 Terra')
  expect(countOccurrences(html, 'aria-haspopup="menu"')).toBe(2)
})

/**
 * The bug: picking "Haiku 4.5" left the face reading `claude-haiku-4-5-20251001`.
 * `model.current` is what the engine RESOLVES the selection to, and the picker
 * offers Haiku under the family alias `haiku`, so neither the raw current nor a
 * row lookup by `selected` would print the name the user just clicked. The face
 * reads the engine's own display name for the resolved model instead.
 */
test('the MODEL face shows the engine display name, never the resolved model id', () => {
  const html = render({
    runControls: runControls({
      model: {
        current: 'claude-haiku-4-5-20251001',
        currentLabel: 'Haiku 4.5',
        contextWindow: 200_000,
        selected: 'haiku',
        provider: 'anthropic',
        options: [{ value: 'haiku', label: 'Haiku 4.5', provider: 'anthropic' }],
      },
    }),
    onSetModel: () => {},
  })
  expect(html).toContain('Haiku 4.5')
  expect(html).toContain('Model: Haiku 4.5')
  expect(html).not.toContain('claude-haiku-4-5-20251001')
})

/**
 * A model the engine has no marketing name for (a custom model, a Foundry
 * deployment id) still has to say WHAT is running, so the id is the fallback.
 * Blanking the face would be a worse answer than the id the operator objected to.
 */
test('a model with no engine display name falls back to its id, not to nothing', () => {
  const html = render({
    runControls: runControls({
      model: {
        current: 'my-foundry-deployment',
        currentLabel: null,
        contextWindow: null,
        selected: 'my-foundry-deployment',
        options: [
          { value: 'my-foundry-deployment', label: 'Custom', provider: 'foundry' },
        ],
      },
    }),
    onSetModel: () => {},
  })
  expect(html).toContain('Model: my-foundry-deployment')
})

test('P4-24c — the REASONING picker offers Auto even when no explicit tier is set', () => {
  const html = render({
    reasoningEffort: null,
    runControls: runControls({
      effort: { supported: true, current: null, selected: null },
    }),
    onSetEffort: () => {},
  })
  // Static path would omit the reasoning face when the tier is null; the interactive
  // picker shows the "Auto" face so the user can still pick a tier.
  expect(html).toContain('Auto')
  expect(html).toContain('Reasoning effort: auto')
})

test('P4-24c — reasoning shows the effective tier while preserving Auto selection', () => {
  const html = render({
    reasoningEffort: null,
    runControls: runControls({
      effort: { supported: true, current: 'medium', selected: null },
    }),
    onSetEffort: () => {},
  })
  expect(html).toContain('Medium (Auto)')
  expect(html).toContain('Reasoning effort: medium (auto)')
})

test('P4-24c — the FAST toggle offers an enable affordance when off but supported', () => {
  const html = render({
    fastMode: false,
    runControls: runControls({ fast: { active: false, supportedByModel: true, available: true } }),
    onSetFast: () => {},
  })
  expect(html).toContain('Enable fast mode')
})

test('P4-24c — the FAST toggle visibly distinguishes off from on', () => {
  const off = render({
    runControls: runControls({ fast: { active: false, supportedByModel: true, available: true } }),
    onSetFast: () => {},
  })
  const offFast = off.match(/<button[^>]*data-composer-face="fast"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
  expect(offFast).toContain('data-composer-face="fast"')
  expect(offFast).toContain('h-[22px] w-[22px]')
  expect(offFast).toContain('fill="none"')
  expect(offFast).toContain('stroke="currentColor"')
  expect(offFast).toContain('border-transparent')
  expect(offFast).toContain('text-text-ghost')

  const on = render({
    runControls: runControls({ fast: { active: true, supportedByModel: true, available: true } }),
    onSetFast: () => {},
  })
  const onFast = on.match(/<button[^>]*data-composer-face="fast"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
  expect(onFast).toContain('data-composer-face="fast"')
  expect(onFast).toContain('h-[22px] w-[22px]')
  expect(onFast).toContain('fill="currentColor"')
  expect(onFast).toContain('stroke="none"')
  expect(onFast).toContain('border-tone-warn/30')
  expect(onFast).toContain('bg-tone-warn/10')
  expect(onFast).toContain('text-tone-warn')
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

test('P4-24c — the FAST toggle is hidden for Anthropic model snapshots', () => {
  const html = render({
    model: 'claude-opus-5',
    runControls: runControls({
      model: {
        current: 'claude-opus-5',
        currentLabel: 'Opus 5',
        selected: 'claude-opus-5',
        provider: 'anthropic',
      },
      fast: { active: false, supportedByModel: false },
    }),
    onSetFast: () => {},
  })
  expect(html).toContain('claude-opus-5')
  expect(html).not.toContain('data-composer-face="fast"')
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
  expect(interactive).toContain('Active account: hiby · Available')
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

// Plan usage (5h/weekly quota) was dropped from this popover entirely
// (operator call, 2026-08-05): it is about the context WINDOW, not the
// account's rate limits, and the quota is visible elsewhere.
test('ContextUsagePanel never shows Plan usage, only the real Context total', () => {
  const html = renderToStaticMarkup(<ContextUsagePanel usage={USAGE} />)
  expect(html).not.toContain('Plan usage')
  expect(html).not.toContain('5-hour limit')
  expect(html).not.toContain('Weekly · all models')
  expect(html).toContain('Context')
  expect(html).toContain('42k / 200k')
})

test('ContextUsagePanel draws a per-category donut, legend and Free row', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel
      usage={USAGE}
      breakdown={{
        categories: [
          {
            label: 'System prompt',
            tokens: 4_200,
            colorKey: 'promptBorder',
            deferred: false,
          },
          { label: 'Messages', tokens: 21_000, colorKey: 'claude', deferred: false },
          {
            label: 'MCP tools (deferred)',
            tokens: 9_000,
            colorKey: 'inactive',
            deferred: true,
          },
        ],
        usedTokens: 25_200,
        freeTokens: 174_800,
        contextWindow: 200_000,
        model: 'gpt-5.6-luna',
      }}
    />,
  )
  // The engine's own category names, not the prototype's cosmetic labels.
  expect(html).toContain('System prompt')
  expect(html).toContain('Messages')
  expect(html).toContain('4.2k')
  expect(html).toContain('21k')
  // Free = window - used.
  expect(html).toContain('Free')
  expect(html).toContain('175k')
  // A deferred category occupies nothing, so it earns neither a row nor a segment.
  expect(html).not.toContain('MCP tools (deferred)')
  // The donut ring: one arc per category, coloured by its own hue, an SVG
  // presentation attribute rather than a Tailwind class.
  expect(html).toContain('stroke="#a1a1aa"') // System prompt
  expect(html).toContain('stroke="#c084fc"') // Messages
  // Segments are notched apart, not butted: the ring is drawn at the thinner
  // stroke that keeps the notches readable, and the first arc already starts a
  // half-gap in (nothing drawn before it, so the offset is the half-gap alone).
  expect(html).toContain('stroke-width="6"')
  expect(html).toContain('stroke-dashoffset="-1.5"')
  // Center readout: the same percent the header line states.
  expect(countOccurrences(html, '21%')).toBeGreaterThanOrEqual(2)
})

test('ContextUsagePanel without a breakdown keeps the aggregate row alone, no donut', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} breakdown={null} />,
  )
  expect(html).toContain('42k / 200k')
  expect(html).not.toContain('Free')
  expect(html).not.toContain('System prompt')
  expect(html).not.toContain('<svg')
})

/**
 * The Compact row. `onCompact` is absent whenever no engine can take the submit
 * (preview pane, spawning, dead, or a session whose composer gate is not
 * sendable), and the row is then not drawn at all — a permanently dead button on
 * a popover with no room to explain itself is worse than no button.
 */
test('ContextUsagePanel draws the Compact row only when a submit can land', () => {
  const withAction = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} onCompact={() => {}} />,
  )
  expect(withAction).toContain('Compact')
  // Accent-tinted and inset in its own footer well, so the panel's one action
  // reads as a button rather than as another row of the readout.
  expect(withAction).toContain('bg-accent/[0.12]')
  expect(withAction).toContain('text-accent')

  const without = renderToStaticMarkup(<ContextUsagePanel usage={USAGE} />)
  expect(without).not.toContain('Compact')
})

/**
 * The action escalates past the pressure threshold, and the two forms are
 * mutually exclusive: an accent button offering the action, or a strip in the
 * pressure tone telling the operator to take it. Two footers at once would give
 * the panel two competing actions.
 */
test('past the pressure threshold the accent button becomes a warning strip', () => {
  const calm = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} onCompact={() => {}} />,
  )
  expect(calm).toContain('bg-accent/[0.12]')
  expect(calm).not.toContain('Running low')

  const pressed = renderToStaticMarkup(
    <ContextUsagePanel
      usage={{ usedTokens: 172_000, contextWindow: 200_000, percentUsed: 86 }}
      onCompact={() => {}}
    />,
  )
  expect(pressed).toContain('Running low, compact now')
  expect(pressed).toContain('bg-tone-warn/10')
  expect(pressed).not.toContain('bg-accent/[0.12]')

  // The ladder is `pressureTone`'s, so the strip follows the percent above it all
  // the way to danger rather than stopping at the warn band.
  const critical = renderToStaticMarkup(
    <ContextUsagePanel
      usage={{ usedTokens: 190_000, contextWindow: 200_000, percentUsed: 95 }}
      onCompact={() => {}}
    />,
  )
  expect(critical).toContain('bg-tone-danger/10')
})

// Every user-visible string on this panel, checked against the operator's
// no-em-dash rule for on-screen text (CLAUDE.md §7).
test('the escalated strip states the ask without an em dash', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel
      usage={{ usedTokens: 172_000, contextWindow: 200_000, percentUsed: 86 }}
      onCompact={() => {}}
    />,
  )
  expect(html).not.toContain('—')
})

// The arcs are stroked circles with no fill, so without this the hit area is the
// whole 76px disc and the topmost segment answers for every pointer position.
test('donut arcs take the pointer on the stroke, not the disc', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel
      usage={USAGE}
      breakdown={{
        categories: [
          { label: 'System prompt', tokens: 4_200, colorKey: 'promptBorder', deferred: false },
          { label: 'Messages', tokens: 21_000, colorKey: 'claude', deferred: false },
        ],
        usedTokens: 25_200,
        freeTokens: 174_800,
        contextWindow: 200_000,
        model: 'gpt-5.6-luna',
      }}
    />,
  )
  expect(html).toContain('[pointer-events:stroke]')
})

// The footer well already pads the panel's bottom edge; a body padding underneath
// the last row would stack with it and float `Free` clear of the seam.
test('the breakdown sits directly on the footer seam, with no padding between', () => {
  const withFooter = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} onCompact={() => {}} />,
  )
  expect(withFooter).not.toContain('pb-3.5')

  // With no footer there is no well to borrow padding from, so the body keeps its own.
  const alone = renderToStaticMarkup(<ContextUsagePanel usage={USAGE} />)
  expect(alone).toContain('pb-3.5')
})

// The breakdown is a separate seam that may never arrive; the aggregate percent
// alone is already reason enough to compact, so the row must not ride on it.
test('the Compact row survives a session with no breakdown snapshot yet', () => {
  const html = renderToStaticMarkup(
    <ContextUsagePanel usage={USAGE} breakdown={null} onCompact={() => {}} />,
  )
  expect(html).toContain('Compact')
  expect(html).not.toContain('System prompt')
})

/**
 * The Context readout's formatter deviates from the prototype's k-only `fmt`
 * (Surfaces.jsx:475), which renders a 1M window as "1000k". Claude 5 sessions
 * carry a 1M window, so they hit that on sight. The sub-million rows here are the
 * prototype's original behavior and must stay byte-for-byte: this table exists so a
 * later edit cannot regress them while adjusting the millions tier.
 *
 * `fmtTokens` is module-private, so drive it through the rendered panel — both
 * halves of `{used} / {window}` go through it, so one row exercises both call sites.
 */
test('the Context readout compacts millions ("1M") without changing sub-million formatting', () => {
  const rows: [number, string][] = [
    [1_000_000, '1M'],
    [1_500_000, '1.5M'],
    [2_000_000, '2M'],
    [999_999, '1000k'],
    [372_000, '372k'],
    [42_000, '42k'],
    [1_500, '1.5k'],
    [999, '999'],
  ]
  for (const [tokens, expected] of rows) {
    const html = renderToStaticMarkup(
      <ContextUsagePanel
        usage={{ usedTokens: tokens, contextWindow: tokens, percentUsed: 100 }}
      />,
    )
    expect(html).toContain(`${expected} / ${expected}`)
  }
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
// (arrow roving, ArrowDown-to-open, Escape-to-composer, the App.tsx entry points)
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

/* --------------------------------------------------------------------------- *
 * P4-33 — the auto-compact warning glyph (the prototype's `TokenWarning`,
 * Surfaces.jsx:415, in the rail at `:779`). The glyph is INVISIBLE below the
 * threshold, so a fresh-session render proves nothing on its own: every test
 * below names which side of the threshold it is on.
 * --------------------------------------------------------------------------- */

/** Illustrative thresholds (see tokenWarning.test.ts) — the sidecar supplies the
 * real ones. Warning at 167k, auto-compact at 187k. */
const WARN_THRESHOLDS = {
  enabled: true,
  threshold: 187_000,
  warningThreshold: 167_000,
} as const

test('P4-33 — BELOW the threshold the warning glyph is absent entirely', () => {
  const html = render({
    contextUsage: { usedTokens: 120_000, contextWindow: 200_000, percentUsed: 60 },
    runControls: runControls({ autoCompact: WARN_THRESHOLDS }),
  })
  expect(html).not.toContain('until auto-compact')
  expect(html).not.toContain('Context low')
  // The donut it rides beside is still there — absence of the glyph is not
  // absence of the rail.
  expect(html).toContain('Context 60% used')
})

test('P4-33 — ABOVE the threshold the amber glyph appears with the engine percentage', () => {
  const html = render({
    contextUsage: { usedTokens: 175_000, contextWindow: 200_000, percentUsed: 88 },
    runControls: runControls({ autoCompact: WARN_THRESHOLDS }),
  })
  // (187000-175000)/187000 = 6%.
  expect(html).toContain('6% until auto-compact')
  // Amber comes from the shared token (theme.css `--tone-warn` IS #fbbf24), never
  // an inlined hex or an interpolated arbitrary class (Tailwind v4 would no-op it).
  expect(html).toContain('text-tone-warn')
  expect(html).not.toContain('#fbbf24')
})

test('P4-33 — with auto-compact OFF the glyph says the user must act', () => {
  const html = render({
    contextUsage: { usedTokens: 175_000, contextWindow: 200_000, percentUsed: 88 },
    runControls: runControls({
      autoCompact: { ...WARN_THRESHOLDS, enabled: false },
    }),
  })
  // The engine words this case differently because nothing recovers on its own
  // (`TokenWarning.tsx:169`): the title states the headroom AND names the fix.
  expect(html).toContain('Context low · 6% remaining')
  expect(html).not.toContain('until auto-compact')
})

test('P4-33 — the glyph joins the toolbar roving order as its own face', () => {
  const html = render({
    contextUsage: { usedTokens: 175_000, contextWindow: 200_000, percentUsed: 88 },
    runControls: runControls({ autoCompact: WARN_THRESHOLDS }),
  })
  // Roving is a DOM query over [data-composer-face]; a glyph without one would be
  // keyboard-unreachable while every neighbouring face is reachable.
  expect(html).toContain('data-composer-face="token-warning"')
})

test('P4-33 — no thresholds on the wire keeps the glyph hidden at any usage', () => {
  const html = render({
    contextUsage: { usedTokens: 900_000, contextWindow: 200_000, percentUsed: 100 },
    runControls: runControls(),
  })
  expect(html).not.toContain('until auto-compact')
  expect(html).not.toContain('data-composer-face="token-warning"')
})

/* --------------------------------------------------------------------- *
 * a session whose engine went away (disconnect / park / crash)
 * --------------------------------------------------------------------- *
 *
 * The bug this pins: the rail read ONE seam for both "what is this session" and
 * "may I change it", so losing the process blanked the model, effort, fast,
 * account and mode faces at once. The pane now passes the last-known values as
 * the read-only props while `runControls`/`permissionContext` stay null, and
 * these assert what that actually renders.
 */

function renderDetached(props: Partial<Parameters<typeof ComposerActionsBar>[0]> = {}) {
  return render({
    // No engine: neither seam that arms a control is present.
    runControls: null,
    permissionContext: null,
    onSwitchAccount: undefined,
    // What the session last reported, which none of the above changes.
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    fastMode: true,
    permissionModeReadOnly: 'auto',
    account: account({ alias: 'hiby' }),
    contextUsage: { usedTokens: 143_841, contextWindow: 372_000, percentUsed: 39 },
    ...props,
  })
}

test('a detached session still names its model, effort, mode, fast and account', () => {
  const html = renderDetached()
  expect(html).toContain('gpt-5.6-sol')
  expect(html).toContain('Model: gpt-5.6-sol')
  expect(html).toContain('Reasoning effort: high')
  expect(html).toContain('Permission mode: Auto mode')
  expect(html).toContain('Active account: hiby · Available')
  // The context donut keeps the session's EXACT window, not the 200k default.
  expect(html).toContain('Context 39% used')
})

test('none of those faces is a control while there is no engine to take the verb', () => {
  const html = renderDetached()
  // A picker announces itself with aria-haspopup; the read-only faces are spans.
  expect(html).not.toContain('aria-label="Model"')
  expect(html).not.toContain('aria-label="Reasoning effort"')
  expect(html).not.toContain('aria-label="Permission mode: Auto"')
  expect(countOccurrences(html, 'aria-haspopup="menu"')).toBe(0)
  // The donut is the one face that stays clickable without an engine: it opens a
  // read-only popover, and its recompute is gated by the pane, not by this bar.
  expect(html).toContain('aria-haspopup="dialog"')
})

test('a face whose value was never reported still renders nothing', () => {
  // Retaining the last snapshot must not become "invent a value": a session that
  // never reported an effort (an Anthropic run) shows no effort face at all.
  const html = renderDetached({ reasoningEffort: null, fastMode: false })
  expect(html).not.toContain('Reasoning effort')
  expect(html).toContain('gpt-5.6-sol')
})
