import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerActionsBar } from './ComposerActionsBar.js'
import type { ContextUsage } from './contextUsage.js'
import type {
  AccountStatus,
  PermissionContextSnapshot,
} from '../../shared/protocol.js'

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
      modelOverride={null}
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
  // The health dot is tinted from the real status via the static tone map.
  expect(html).toContain('bg-tone-good')
})

test('a non-healthy account tints its dot from the real status (not fabricated)', () => {
  const html = render({ account: account({ status: 'capped' }) })
  expect(html).toContain('bg-tone-warn')
  const dead = render({ account: account({ status: 'dead' }) })
  expect(dead).toContain('bg-tone-danger')
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
  const html = render({ permissionContext: permissionContext({ mode: 'default' }) })
  expect(html).toContain('Default')
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

test('the MODEL chip appears only when a real override is present, never fabricated', () => {
  const overridden = render({ modelOverride: 'gpt-5.6-terra' })
  expect(overridden).toContain('gpt-5.6-terra')
  expect(overridden).toContain('Model')

  const defaulted = render({ modelOverride: null })
  expect(defaulted).not.toContain('Model')
  // And never the prototype's mock literal.
  expect(defaulted).not.toContain('GPT-5.4')
})

test('the attach button reflects the disabled gate (echo-only stub)', () => {
  const enabled = render({ attachDisabled: false })
  expect(enabled).toContain('aria-label="Add attachment"')
  expect(enabled).not.toContain('disabled=""')
  const disabled = render({ attachDisabled: true })
  expect(disabled).toContain('disabled=""')
})
