import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerActionsBar } from './ComposerActionsBar.js'
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

test('the attach button reflects the disabled gate (echo-only stub)', () => {
  const enabled = render({ attachDisabled: false })
  expect(enabled).toContain('aria-label="Add attachment"')
  expect(enabled).not.toContain('disabled=""')
  const disabled = render({ attachDisabled: true })
  expect(disabled).toContain('disabled=""')
})
