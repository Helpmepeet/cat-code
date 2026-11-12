/**
 * Provider defaults and account lifecycle from the redacted AccountsSnapshot.
 * Usage history is not available on this wire and must not be invented.
 *
 * Writes go ONLY through the `onVerb` prop. App-level account management uses
 * main's account worker; destructive profile mutations use their one-shot
 * host workers. Both re-resolve
 * the target from engine-owned pool state. Optimistic UI is forbidden: a dialog
 * dispatches its verb, remembers the minted `requestId`, and closes + toasts only
 * when the matching `account.result` (`lastResult`) arrives.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AnthropicAccountStatus,
  AccountVerbMessage,
  SignedOutCodexProfileStatus,
} from '../../shared/protocol.js'
import type {
  AccountSignOutOverlay,
} from './accountsState.js'
import {
  selectAccountRows,
  selectCapAccount,
  selectHasOtherSwitchable,
  selectReadyLabel,
  useAccountsPoolPresentationState,
} from './accountsState.js'
import {
  capIncidentKey,
  accountRecoveryReason,
  accountTakenAliases,
  accountPlanLabel,
  claudeRateLimitTier,
  claudeOrganizationName,
  anthropicAccountName,
  anthropicCredentialLabel,
  deleteVerb,
  formatResetLabel,
  loginVerb,
  logoutVerb,
  nextDismissedCapKey,
  renameError,
  renameVerb,
  resultToastTone,
  selectAccountMenuItems,
  selectAnthropicReadyLabel,
  shouldShowCapBanner,
  statusDotTone,
  statusLabelTone,
  switchVerb,
  touchAllVerb,
  usageTone,
  type AccountMenuItem,
  type AccountMenuKey,
} from './accountsPageModel.js'
import {
  handleMenuRovingKeyDown,
  usePopover,
} from './composerPopover.js'
import { useModalFocus } from './overlayFocus.js'
import { useToast } from './toastContext.js'
import { toneClasses, type Tone } from './tone.js'
import { useAccountUsageWindows } from './welcomeUsage.js'
import { getBridge } from './bridge.js'
import { ProviderLogo } from './ProviderLogo.js'
import './accountsPage.css'

/* ── pure helpers (unit-tested without a DOM, like tone.ts / toastReducer) ── */

/* ── small shared button + bar primitives (token-based) ── */

function PrimaryBtn({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-on-fill transition-opacity disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function GhostBtn({
  children,
  onClick,
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-shell-seam px-3.5 py-2 text-[12.5px] font-medium text-text-muted transition-colors hover:bg-shell-hover"
    >
      {children}
    </button>
  )
}

function DangerBtn({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-[light-dark(#dc2626,#ef4444)] px-3.5 py-2 text-[13px] font-semibold text-[#fff] disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function HeadroomBar({
  label,
  pct,
  resetAt,
  showReset,
}: {
  label: string
  pct: number | null
  resetAt?: number | null
  showReset?: boolean
}) {
  return (
    <div className="accounts-metric" data-tone={usageTone(pct)}>
      <div className="accounts-metric-row">
        <span className="accounts-metric-label">{label}</span>
        <UsageTrack label={label} pct={pct} />
        <UsageValue label={label} pct={pct} />
      </div>
      {showReset && resetAt != null ? <div className="accounts-metric-reset">resets {formatResetLabel(resetAt)}</div> : null}
    </div>
  )
}

function UsageTrack({ label, pct }: { label: string; pct: number | null }) {
  return <progress className="accounts-usage-track" aria-label={`${label} usage`} aria-valuetext={pct === null ? 'Usage unavailable' : `${pct}%`} max={100} value={Math.max(0, Math.min(100, pct ?? 0))} />
}

function UsageValue({ label, pct }: { label: string; pct: number | null }) {
  return <span className={`accounts-usage-value${pct === null ? ' is-unavailable' : ''}`}
    aria-label={pct === null ? `${label} usage unavailable` : undefined}
    title={pct === null ? 'Usage unavailable' : undefined}>{pct === null ? '–' : `${pct}%`}</span>
}

function StaleUsage() {
  return <span className="accounts-stale" title="Showing the last successful usage check.">Usage may be out of date</span>
}

function DefaultTag() {
  return <span className="accounts-default-tag">Default</span>
}

/* ── dialog shell ── */

function ALDialog({
  title,
  sub,
  children,
  footer,
  onClose,
}: {
  title: string
  sub?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useModalFocus({
    open: true,
    containerRef: dialogRef,
    onEscape: onClose,
  })
  return (
    <div
      role="presentation"
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-scrim backdrop-blur-sm"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="animate-toast-in w-[460px] max-w-[calc(100%-48px)] overflow-hidden rounded-[14px] border border-shell-seam bg-surface-panel shadow-[var(--elev-modal)]"
      >
        <div className="border-b border-shell-seam px-[18px] py-4">
          <div className="text-[14.5px] font-semibold text-text-primary">
            {title}
          </div>
          {sub ? (
            <div className="mt-[3px] text-[12px] leading-[1.45] text-text-subtle">
              {sub}
            </div>
          ) : null}
        </div>
        <div className="px-[18px] py-[18px]">{children}</div>
        {footer ? (
          <div className="flex justify-end gap-2 border-t border-shell-seam px-[18px] py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ── lifecycle dialogs ── */

type Provider = 'anthropic' | 'openai'
type AccountLabel = Pick<AccountStatus, 'id' | 'alias'>
type LogoutTarget = AccountLabel & Pick<AccountStatus, 'hasVaultProfile' | 'isDefault' | 'credentialGeneration'>

type DeleteTarget = AccountLabel & {
  expectedCredentialGeneration: number
  isDefault: boolean
  signedOut: boolean
  provider?: Provider
}

/**
 * Restoring an account whose credentials died. Adding one needs no dialog: the
 * sign-in surface opens straight away. This one exists for its warning.
 * `account.login` carries no account id: which account a sign-in lands on is
 * decided by whoever the user picks in the browser, and the sidecar re-links by
 * comparing the returned identity against the pool (`accountsDomain.ts`
 * `createRealOAuthLoginRunner`). Naming the expected account is the only thing
 * standing between a repair and a silently-added second account.
 */
function RelinkAccountDialog({
  account,
  onAuthorize,
  onClose,
}: {
  account: AccountLabel
  onAuthorize: () => void
  onClose: () => void
}) {
  const name = account.alias ?? account.id
  return (
    <ALDialog
      title={`Sign in to ${name} again`}
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={onAuthorize}>Sign in</PrimaryBtn>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-text-muted">
        Pick the same account in the browser. A different one is added as a new
        account.
      </p>
    </ALDialog>
  )
}

function RenameAccountDialog({
  account,
  takenAliases,
  onSubmit,
  onClose,
}: {
  account: AccountLabel
  takenAliases: string[]
  onSubmit: (alias: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(account.alias ?? '')
  const err = renameError(value, account.alias, takenAliases)
  const save = () => {
    if (err) return
    onSubmit(value)
  }
  return (
    <ALDialog
      title="Rename account"
      sub={`Currently “${account.alias ?? account.id}”. Aliases are unique, 1–32 chars.`}
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={save} disabled={!!err}>
            Rename
          </PrimaryBtn>
        </>
      }
    >
      <input
        autoFocus
        aria-label="New alias"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
        }}
        className={`w-full rounded-lg border bg-white/[0.03] px-3 py-2.5 font-mono text-[13px] text-text-primary outline-none ${
          err && value ? 'border-tone-danger/40' : 'border-white/10'
        }`}
      />
      {err && value ? (
        <div className="mt-[7px] text-[11px] text-[light-dark(#dc2626,#fca5a5)]">{err}</div>
      ) : null}
    </ALDialog>
  )
}

function DeleteAccountDialog({
  target,
  hasOtherSwitchable,
  onConfirm,
  onClose,
}: {
  target: DeleteTarget
  hasOtherSwitchable: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const alias = target.alias ?? target.id
  const [submitting, setSubmitting] = useState(false)
  return (
    <ALDialog
      title={`Delete “${alias}”?`}
      sub="Removes the saved account profile and releases its leases. This can't be undone."
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <DangerBtn
            disabled={submitting}
            onClick={() => {
              if (submitting) return
              setSubmitting(true)
              onConfirm()
            }}
          >
            Delete account
          </DangerBtn>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-text-muted">
        {target.signedOut ? 'The saved name for ' : 'The credentials and saved name for '}
        <span className="font-mono text-text-primary">{alias}</span> will be
        removed.
        {target.isDefault ? (
          <span className="text-tone-warn">
            {hasOtherSwitchable
              ? ' This is the default for new chats, so another account will become the default.'
              : ' This is the default for new chats, and no other usable account remains. Sign in or switch accounts before starting a new chat.'}
          </span>
        ) : null}
      </div>
      <p className="mt-3 text-[12px] text-tone-warn">Close older Cat Code versions before signing out or deleting accounts.</p>
    </ALDialog>
  )
}

function LogoutAccountDialog({
  account,
  hasOtherSwitchable,
  onConfirm,
  onClose,
}: {
  account: LogoutTarget
  hasOtherSwitchable: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const alias = account.alias ?? account.id
  const [submitting, setSubmitting] = useState(false)
  return (
    <ALDialog
      title={`Sign out “${alias}”?`}
      sub={
        account.hasVaultProfile
          ? 'Cat Code stops using this account and removes it from active credential stores. The saved profile stays so you can sign in again or delete it.'
          : 'Cat Code stops using this account and removes it from active credential stores. No saved profile will be created.'
      }
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn
            disabled={submitting}
            onClick={() => {
              if (submitting) return
              setSubmitting(true)
              onConfirm()
            }}
          >
            Sign out
          </PrimaryBtn>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-text-muted">
        {account.isDefault ? (
          <>
            {hasOtherSwitchable
              ? 'Another usable account will become the default for new chats.'
              : 'No other usable account remains. Sign in or switch accounts before starting a new chat.'}
          </>
        ) : (
          <>The default account for new chats will not change.</>
        )}
      </div>
      <p className="mt-3 text-[12px] text-tone-warn">Close older Cat Code versions before signing out or deleting accounts.</p>
    </ALDialog>
  )
}

function TouchAllDialog({
  onVerb,
  lastResult,
  onClose,
}: {
  onVerb: (verb: AccountVerbMessage) => void
  lastResult: AccountResultFrame | null
  onClose: () => void
}) {
  const requestIdRef = useRef<string | null>(null)
  const [running, setRunning] = useState(true)

  function refresh(): void {
    const verb = touchAllVerb()
    requestIdRef.current = verb.requestId
    setRunning(true)
    onVerb(verb)
  }

  // Dispatch once on open; this dialog self-correlates (it RENDERS the per-account
  // results rather than toast+close, so it stays out of the page's generic pending).
  useEffect(() => {
    refresh()
  }, [])

  const matched =
    !!lastResult &&
    lastResult.requestId === requestIdRef.current &&
    lastResult.verb === 'account.touchAll'
  const results = matched ? lastResult.touchAllResults ?? [] : []
  const failed = matched && !lastResult.ok

  useEffect(() => {
    if (matched) setRunning(false)
  }, [matched])

  const resultTone: Record<'OK' | 'LOCKED' | 'FAILED', string> = {
    OK: 'text-tone-good',
    LOCKED: 'text-text-muted',
    FAILED: 'text-tone-danger',
  }

  return (
    <ALDialog
      title="Refresh all accounts"
      sub="Refreshes OAuth tokens for every unlocked account."
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>{running || failed ? 'Close' : 'Done'}</GhostBtn>
          {!running && failed ? <PrimaryBtn onClick={refresh}>Try again</PrimaryBtn> : null}
        </>
      }
    >
      {running ? (
        <div className="flex items-center gap-2.5 text-[12.5px] text-text-muted">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-shell-seam border-t-text-muted" />
          Refreshing…
        </div>
      ) : failed ? (
        <div role="alert" className="text-[12.5px] text-tone-danger">
          {lastResult.message}
        </div>
      ) : results.length === 0 ? (
        <div className="text-[12.5px] text-text-subtle">
          No unlocked vault accounts were refreshed.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {results.map((r, i) => (
            <div
              key={`${r.alias ?? 'unnamed'}-${i}`}
              className="flex items-center justify-between rounded-[7px] border border-white/[0.05] bg-white/[0.02] px-2.5 py-[7px]"
            >
              <span className="font-mono text-[12.5px] text-text-primary">
                {r.alias ?? 'unnamed'}
              </span>
              <span
                className={`text-[10.5px] font-bold tracking-[0.06em] ${resultTone[r.result]}`}
              >
                {r.result}
              </span>
            </div>
          ))}
        </div>
      )}
    </ALDialog>
  )
}

/* ── pool row + ⋯ menu ── */

function AccountRowMenu({
  account,
  signOutState,
  onAction,
}: {
  account: AccountStatus
  signOutState?: 'submitting' | 'checking' | 'refreshing'
  onAction: (key: AccountMenuKey, account: AccountStatus) => void
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()

  const items = selectAccountMenuItems(account, signOutState)
  if (items.length === 0) return null

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={`flex h-7 w-7 items-center justify-center rounded-[7px] text-[17px] leading-none text-text-muted transition-colors hover:bg-shell-hover ${
          open ? 'bg-white/[0.08]' : ''
        }`}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account actions"
          onKeyDown={handleMenuRovingKeyDown}
          className="absolute right-0 top-8 z-[20] min-w-[180px] rounded-[10px] border border-white/[0.12] bg-[light-dark(#ffffff,#141417)] p-[5px] shadow-[var(--elev-menu)]"
        >
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                close()
                onAction(it.key, account)
              }}
              className={`block w-full rounded-[7px] px-2.5 py-[7px] text-left text-[12.5px] transition-colors ${
                it.danger
                  ? 'text-tone-danger hover:bg-tone-danger/10'
                  : 'text-text-primary hover:bg-white/[0.06]'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PoolRow({
  account,
  signOutState,
  onAction,
}: {
  account: AccountStatus
  signOutState?: 'submitting' | 'checking' | 'refreshing'
  onAction: (key: AccountMenuKey, account: AccountStatus) => void
}) {
  const usable = account.status === 'healthy'
  const pressured = usable && account.usageLimitReached
  const expired = account.status === 'dead'
  const t = toneClasses(expired ? 'danger' : statusDotTone(account))
  const labelTone = toneClasses(statusLabelTone(account))
  const usage = useAccountUsageWindows(account)
  const alias = account.alias ?? account.id
  const transitionLabel =
    signOutState === 'submitting'
      ? 'Signing out…'
      : signOutState === 'checking'
        ? 'Checking sign-out status'
        : signOutState === 'refreshing'
          ? 'Refreshing account…'
          : null
  return (
    <div className="accounts-row">
      <span className={`accounts-dot ${t.dot} ${account.status === 'quarantined' ? 'animate-pulse' : ''}`} />
      <div className="accounts-identity">
        <div className="accounts-name">
          <span className="truncate" title={alias}>{alias}</span>
          {account.isDefault ? <DefaultTag /> : null}
        </div>
        {account.email && account.email !== alias ? <div className="accounts-sub" title={account.email}>{account.email}</div> : null}
        {transitionLabel || expired || !usable || pressured ? <div className={`accounts-sub ${expired ? 'text-tone-danger' : labelTone.text}`}>
          {transitionLabel ?? (expired ? 'Sign-in expired' : pressured ? 'Near limit' : account.availabilityLabel)}
        </div> : null}
        {account.lastError ? <div className="accounts-sub" title={account.lastError}>{account.lastError}</div> : null}
        {account.usageStale && (usage.fiveHour || usage.weekly) ? <div className="accounts-sub"><StaleUsage /></div> : null}
      </div>
      <span className="accounts-plan">{accountPlanLabel(account.planType)}</span>
      {usable ? (
        <>
          <HeadroomBar
            label="5h"
            pct={usage.fiveHour?.percent ?? null}
            resetAt={usage.fiveHour?.resetAt}
            showReset
          />
          <HeadroomBar
            label="wk"
            pct={usage.weekly?.percent ?? null}
            resetAt={usage.weekly?.resetAt}
            showReset
          />
        </>
      ) : (
        <div className="accounts-row-note">
          {account.status === 'capped'
            ? `Resets ${formatResetLabel(account.usageResetAt)}`
            : ''}
        </div>
      )}
      <div className="accounts-inline-action">
        {!signOutState && expired ? <button type="button" className="accounts-button is-fix" onClick={() => onAction('relink', account)}>Sign in again</button>
          : !signOutState && usable && !account.isDefault && account.switchable ? <button type="button" className="accounts-button is-quiet" onClick={() => onAction('switch', account)}>Make default</button> : null}
      </div>
      <div className="accounts-menu"><AccountRowMenu
        account={account}
        signOutState={signOutState}
        onAction={onAction}
      /></div>
    </div>
  )
}

function SignedOutProfileMenu({
  profile,
  onRelink,
  onDelete,
}: {
  profile: SignedOutCodexProfileStatus
  onRelink: () => void
  onDelete: () => void
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  const canDelete =
    profile.lifecycleGeneration !== null ||
    profile.credentialGeneration !== null
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className={`flex h-7 w-7 items-center justify-center rounded-[7px] text-[17px] leading-none text-text-muted transition-colors hover:bg-shell-hover ${
          open ? 'bg-white/[0.08]' : ''
        }`}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account actions"
          onKeyDown={handleMenuRovingKeyDown}
          className="absolute right-0 top-8 z-[20] min-w-[180px] rounded-[10px] border border-white/[0.12] bg-[light-dark(#ffffff,#141417)] p-[5px] shadow-[var(--elev-menu)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              onRelink()
            }}
            className="block w-full rounded-[7px] px-2.5 py-[7px] text-left text-[12.5px] text-text-primary transition-colors hover:bg-white/[0.06]"
          >
            Sign in again
          </button>
          {canDelete ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                close()
                onDelete()
              }}
              className="block w-full rounded-[7px] px-2.5 py-[7px] text-left text-[12.5px] text-tone-danger transition-colors hover:bg-tone-danger/10"
            >
              Delete account
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SignedOutProfileRow({
  profile,
  onRelink,
  onDelete,
}: {
  profile: SignedOutCodexProfileStatus
  onRelink: () => void
  onDelete: () => void
}) {
  return (
    <div className="accounts-row is-signed-out">
      <span className="accounts-dot bg-text-ghost" />
      <div className="accounts-identity">
        <div className="accounts-name">
          {profile.alias ?? profile.email ?? profile.id}
        </div>
        {profile.email && profile.alias && profile.email !== profile.alias ? <div className="accounts-sub">{profile.email}</div> : null}
      </div>
      <span className="accounts-plan" />
      <div className="accounts-row-note" title={profile.recoveryReason ? accountRecoveryReason(profile.recoveryReason) : undefined}>{profile.recoveryReason ? 'Saved sign-in changed' : 'Signed out'}</div>
      <div className="accounts-inline-action"><button type="button" className="accounts-button is-quiet" onClick={onRelink}>Sign in again</button></div>
      <div className="accounts-menu"><SignedOutProfileMenu
        profile={profile}
        onRelink={onRelink}
        onDelete={onDelete}
      /></div>
    </div>
  )
}

/* ── header pieces ── */

type SummaryWindow = { percent: number | null; resetAt?: number | null } | null | undefined

function ProviderMark({ provider }: { provider: Provider }) {
  return <span className={provider === 'anthropic' ? 'text-provider-claude' : 'text-provider-openai'}><ProviderLogo provider={provider} size={14} /></span>
}

function ProviderSummary({ provider, readyLabel, name, detail, stale, fiveHour, weekly }: {
  provider: Provider
  readyLabel: string
  name: string
  detail?: string | null
  stale?: boolean
  fiveHour?: SummaryWindow
  weekly?: SummaryWindow
}) {
  return <section className="accounts-summary-card" data-window-card aria-label={`${provider === 'anthropic' ? 'Claude' : 'Codex'} default account`}>
    <div className="accounts-summary-top"><span className="accounts-provider"><ProviderMark provider={provider} />{provider === 'anthropic' ? 'Claude' : 'Codex'}</span><span className="accounts-count">{readyLabel}</span></div>
    <div className="accounts-summary-label">New chats use</div>
    <div className="accounts-summary-name" title={name}>{name}</div>
    <div className="accounts-summary-sub">{detail ? <span>{detail}</span> : null}{stale ? <StaleUsage /> : null}</div>
    <div className="accounts-summary-windows">
      {([['5-hour', fiveHour], ['Weekly', weekly]] as const).map(([label, usage]) => <div key={label} data-tone={usageTone(usage?.percent ?? null)}>
        <div className="accounts-summary-value"><UsageValue label={label} pct={usage?.percent ?? null} /><span>{label}</span></div>
        <UsageTrack label={label} pct={usage?.percent ?? null} />
        <div className="accounts-summary-reset">{usage?.resetAt != null ? `resets ${formatResetLabel(usage.resetAt)}` : '\u00a0'}</div>
      </div>)}
    </div>
  </section>
}

function CodexSummary({ account, readyLabel }: { account: AccountStatus; readyLabel: string }) {
  const usage = useAccountUsageWindows(account)
  const name = account.alias ?? account.email ?? account.id
  return <ProviderSummary provider="openai" readyLabel={readyLabel} name={name}
    detail={[account.email && account.email !== name ? account.email : null, accountPlanLabel(account.planType)].filter(Boolean).join(' · ')}
    stale={account.usageStale && !!(usage.fiveHour || usage.weekly)} fiveHour={usage.fiveHour} weekly={usage.weekly} />
}

function ClaudeRow({ account, onAction }: { account: AnthropicAccountStatus; onAction: (key: string) => void }) {
  const name = anthropicAccountName(account)
  const credentialLabel = anthropicCredentialLabel(account)
  const needsSignIn = account.status === 'dead' || !!credentialLabel
  const plan = claudeRateLimitTier(account.rateLimitTier) ?? accountPlanLabel(account.subscriptionType)
  const org = claudeOrganizationName(account)
  return <div className="accounts-row">
    <span className={`accounts-dot ${needsSignIn ? 'bg-tone-danger' : account.isDefault ? 'bg-accent' : 'bg-tone-good'}`} />
    <div className="accounts-identity">
      <div className="accounts-name"><span className="truncate" title={name.title}>{name.title}</span>{account.isDefault ? <DefaultTag /> : null}</div>
      {name.detail ? <div className="accounts-sub" title={name.detail}>{name.detail}</div> : null}
      {needsSignIn ? <div className="accounts-sub text-tone-danger" title={credentialLabel ?? undefined}>Sign-in expired</div> : null}
      {account.usageStale && [account.usageFiveHour, account.usageWeekly, account.usageWeeklyOpus, account.usageWeeklySonnet].some(value => value != null) ? <div className="accounts-sub"><StaleUsage /></div> : null}
      {org ? <div className="accounts-sub" title={org}>{org}</div> : null}
      {account.extraUsage?.isEnabled ? <div className="accounts-sub">Extra usage: {account.extraUsage.usedCredits ?? '–'} / {account.extraUsage.monthlyLimit ?? '–'} credits</div> : !account.extraUsage && account.hasExtraUsageEnabled ? <div className="accounts-sub">Extra usage enabled</div> : null}
    </div>
    <span className="accounts-plan">{plan}</span>
    {needsSignIn ? <div className="accounts-row-note" /> : <>
      <HeadroomBar label="5h" pct={account.usageFiveHour ?? null} resetAt={account.usageFiveHourResetAt} showReset />
      <div className="accounts-weekly-metrics">
        <HeadroomBar label="wk" pct={account.usageWeekly ?? null} resetAt={account.usageWeeklyResetAt} showReset />
        {account.usageWeeklyOpus != null ? <HeadroomBar label="Opus" pct={account.usageWeeklyOpus} resetAt={account.usageWeeklyOpusResetAt} showReset /> : null}
        {account.usageWeeklySonnet != null ? <HeadroomBar label="Sonnet" pct={account.usageWeeklySonnet} resetAt={account.usageWeeklySonnetResetAt} showReset /> : null}
      </div>
    </>}
    <div className="accounts-inline-action">{needsSignIn ? <button type="button" className="accounts-button is-fix" onClick={() => onAction('relink')}>Sign in again</button> : !account.isDefault ? <button type="button" className="accounts-button is-quiet" onClick={() => onAction('switch')}>Make default</button> : null}</div>
    <div className="accounts-menu"><ClaudeRowMenu account={account} onAction={onAction} /></div>
  </div>
}

/** Main does not publish failed reads. Bound loading locally while sign-in remains available. */
function WaitingState({ onRetry, onSignIn }: {
  onRetry: () => void
  onSignIn: (provider: 'anthropic' | 'openai') => void
}) {
  const presentation = useAccountsPoolPresentationState(false)
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div role="status" className="text-sm font-semibold text-text-muted">
        {presentation === 'unavailable' ? 'Accounts could not be loaded.' : 'Loading accounts…'}
      </div>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {presentation === 'unavailable' ? <GhostBtn onClick={onRetry}>Try again</GhostBtn> : null}
        <button type="button" className="accounts-button" onClick={() => onSignIn('anthropic')}>+ Add Claude account</button>
        <button type="button" className="accounts-button" onClick={() => onSignIn('openai')}>+ Add Codex account</button>
      </div>
    </section>
  )
}

/* ── page ── */

function SignInDialog({ provider, onAuthorize, onClose }: {
  provider: Provider
  onAuthorize: (makeDefault: boolean) => void
  onClose: () => void
}) {
  const [makeDefault, setMakeDefault] = useState(false)
  return <ALDialog title={`Sign in to ${provider === 'anthropic' ? 'Claude' : 'Codex'}`} onClose={onClose}
    footer={<><GhostBtn onClick={onClose}>Cancel</GhostBtn><PrimaryBtn onClick={() => onAuthorize(makeDefault)}>Sign in</PrimaryBtn></>}>
    <label className="flex items-center gap-2 text-[12.5px] text-text-muted">
      <input type="checkbox" checked={makeDefault} onChange={event => setMakeDefault(event.target.checked)} />
      Make default for new chats
    </label>
  </ALDialog>
}

function ClaudeRowMenu({ account, onAction }: {
  account: AnthropicAccountStatus
  onAction: (key: string) => void
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  const items = [
    ...(!account.isDefault && account.status === 'healthy' ? [{ key: 'switch', label: 'Make default for new chats' }] : []),
    { key: 'check', label: 'Check sign-in' },
    { key: 'relink', label: 'Sign in again' },
    ...(account.hasVaultProfile ? [{ key: 'rename', label: 'Rename' }] : []),
    ...(account.loginGeneration !== undefined ? [
      { key: 'logout', label: 'Sign out' },
      ...(account.hasVaultProfile ? [{ key: 'delete', label: 'Delete' }] : []),
    ] : []),
  ]
  return <div ref={ref} className="relative shrink-0">
    <button ref={triggerRef} type="button" aria-label="Account actions" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} className="h-7 w-7 rounded-[7px] text-text-muted hover:bg-shell-hover">⋯</button>
    {open ? <div role="menu" aria-label="Account actions" onKeyDown={handleMenuRovingKeyDown}
      className="absolute right-0 top-8 z-[20] min-w-[180px] rounded-[10px] border border-shell-seam bg-surface-panel p-[5px] shadow-[var(--elev-menu)]">
      {items.map(item => <button key={item.key} type="button" role="menuitem"
        className="block w-full rounded-[7px] px-2.5 py-[7px] text-left text-[12.5px] text-text-primary hover:bg-shell-hover"
        onClick={() => { close(); onAction(item.key) }}>{item.label}</button>)}
    </div> : null}
  </div>
}

type DialogState =
  | { kind: 'login'; provider: Provider }
  | { kind: 'relink'; account: AccountLabel; provider?: Provider }
  | { kind: 'touchall' }
  | { kind: 'rename'; account: AccountLabel; provider?: Provider }
  | { kind: 'delete'; target: DeleteTarget }
  | { kind: 'logout'; account: LogoutTarget; provider?: Provider }
  | null

type Pending = {
  requestId: string
  onDone: (result: AccountResultFrame) => void
}

export function AccountsPage({
  snapshot,
  lastResult,
  signOutOverlays = {},
  onVerb,
}: {
  snapshot: AccountsSnapshot | null
  switchScope?: { provider: 'openai' | 'anthropic'; accountId: string | null; boundLoginGeneration?: number }
  lastResult: AccountResultFrame | null
  signOutOverlays?: Record<string, AccountSignOutOverlay>
  onVerb: (verb: AccountVerbMessage) => void
  onSignInAndReconnect?: (accountId: string) => void
}): ReactElement {
  const toast = useToast()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [dismissedCapKey, setDismissedCapKey] = useState<string | null>(null)
  const [pendingAccountId, setPendingAccountId] = useState<string | null>(null)
  const [accountLoadAttempt, setAccountLoadAttempt] = useState(0)
  const pendingRef = useRef<Pending | null>(null)

  // Correlate a dispatched verb with its `account.result` by requestId: NO
  // optimistic UI — we toast + close only when the real outcome arrives.
  useEffect(() => {
    const pending = pendingRef.current
    if (lastResult && pending && lastResult.requestId === pending.requestId) {
      pendingRef.current = null
      setPendingAccountId(null)
      pending.onDone(lastResult)
    }
  }, [lastResult])

  const switchSnapshot = snapshot ? {
    ...snapshot,
    accounts: snapshot.accounts.map(account => ({ ...account,
      isDefault: account.id === (snapshot.savedDefaultAccountId !== undefined ? snapshot.savedDefaultAccountId : snapshot.activeAccountId),
      switchable: account.switchable || (account.id === snapshot.effectiveDefaultAccountId &&
        account.id !== snapshot.savedDefaultAccountId && account.availability !== 'blocked'),
    })),
    anthropicAccounts: snapshot.anthropicAccounts.map(account => ({ ...account,
      boundLoginGeneration: undefined,
      isDefault: account.id === (snapshot.anthropicSavedDefaultAccountId !== undefined ? snapshot.anthropicSavedDefaultAccountId : snapshot.anthropicActiveAccountId),
    })),
  } : null
  const rows = selectAccountRows(switchSnapshot)
  const active = snapshot?.accounts.find(account => account.id === (snapshot.effectiveDefaultAccountId !== undefined ? snapshot.effectiveDefaultAccountId : snapshot.activeAccountId)) ?? null
  const activeClaude = snapshot?.anthropicAccounts.find(account => account.id === (snapshot.anthropicEffectiveDefaultAccountId !== undefined ? snapshot.anthropicEffectiveDefaultAccountId : snapshot.anthropicActiveAccountId)) ?? null
  const capAccount = selectCapAccount(snapshot)
  const readyLabel = selectReadyLabel(snapshot)
  const anthropicReadyLabel = selectAnthropicReadyLabel(snapshot)
  const capSwitchTarget = capAccount
    ? rows.find(a => a.id !== capAccount.id && !a.isDefault && a.switchable) ?? null
    : null
  const capKey = capIncidentKey(capAccount)

  useEffect(() => {
    setDismissedCapKey(prev => nextDismissedCapKey(prev, capKey))
  }, [capKey])

  // Dispatch a toast-and-close verb.
  function submit(verb: AccountVerbMessage, targetAccountId?: string): void {
    if (targetAccountId) setPendingAccountId(targetAccountId)
    pendingRef.current = {
      requestId: verb.requestId,
      onDone: result => {
        toast(result.message, { tone: resultToastTone(result.ok) })
        setDialog(null)
      },
    }
    onVerb(verb)
  }

  // Start a sign-in. The app-level sign-in surface takes over at once and shows
  // its progress, so a started sign-in needs no toast; a refused one still gets
  // one, since nothing else would say so.
  function beginSignIn(provider: Provider): void {
    setDialog({ kind: 'login', provider })
  }

  function authorize(provider: Provider, makeDefault = false): void {
    setDialog(null)
    const verb = loginVerb(provider, makeDefault)
    pendingRef.current = {
      requestId: verb.requestId,
      onDone: result => {
        if (!result.ok) toast(result.message, { tone: resultToastTone(false) })
      },
    }
    onVerb(verb)
  }

  function onRowAction(key: AccountMenuKey, account: AccountStatus): void {
    if (key === 'switch') {
      submit(switchVerb(account.id))
      return
    }
    // Destructive actions affect the shared pool, not the retained chat.
    account = snapshot?.accounts.find(row => row.id === account.id) ?? account
    if (key === 'retry_logout') {
      const overlay = signOutOverlays[account.id]
      if (!overlay || overlay.phase !== 'checking') return
      submit(
        logoutVerb(
          overlay.accountId,
          overlay.expectedCredentialGeneration,
          overlay.operationId,
        ),
        account.id,
      )
      return
    }
    if (key === 'delete') {
      setDialog({
        kind: 'delete',
        target: {
          id: account.id,
          alias: account.alias,
          expectedCredentialGeneration: account.credentialGeneration,
          isDefault: account.isDefault,
          signedOut: false,
        },
      })
      return
    }
    setDialog({ kind: key, account })
  }

  function claudeAction(key: string, account: AnthropicAccountStatus): void {
    if (key === 'switch') { submit(switchVerb(account.id, 'anthropic')); return }
    if (key === 'check') { submit(touchAllVerb('anthropic', account.id)); return }
    if (key === 'relink') { setDialog({ kind: 'relink', account: { ...account, alias: account.alias ?? account.email }, provider: 'anthropic' }); return }
    if (key === 'rename') { setDialog({ kind: 'rename', account, provider: 'anthropic' }); return }
    if (account.loginGeneration === undefined) return
    if (key === 'delete') setDialog({ kind: 'delete', target: { ...account, expectedCredentialGeneration: account.loginGeneration, signedOut: false, provider: 'anthropic' } })
    if (key === 'logout') setDialog({ kind: 'logout', provider: 'anthropic', account: {
      ...account, credentialGeneration: account.loginGeneration,
    } })
  }

  function signOutStateFor(
    accountId: string,
  ): 'submitting' | 'checking' | 'refreshing' | undefined {
    if (pendingAccountId === accountId) return 'submitting'
    const phase = signOutOverlays[accountId]?.phase
    return phase === 'checking' || phase === 'refreshing' ? phase : undefined
  }

  return (
    <main className="accounts-page">
      <div className="accounts-wrap">
        <header className="accounts-header">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Accounts
            </h1>
            <p className="mt-1 text-[13px] text-text-faint">
              New chats use each provider's default account.
            </p>
          </div>
          {snapshot ? <div className="text-[11.5px] text-text-subtle">{(['openai', 'anthropic'] as const).map(provider => {
            const saved = provider === 'openai' ? snapshot.savedDefaultAccountId : snapshot.anthropicSavedDefaultAccountId
            const effective = provider === 'openai' ? snapshot.effectiveDefaultAccountId : snapshot.anthropicEffectiveDefaultAccountId
            const legacy = provider === 'openai' ? snapshot.activeAccountId : snapshot.anthropicActiveAccountId
            const actual = effective !== undefined ? effective : legacy
            if (saved === undefined || saved === actual) return null
            const pool = provider === 'openai' ? snapshot.accounts : snapshot.anthropicAccounts
            const name = (id: string | null) => { const account = pool.find(a => a.id === id); return account?.alias ?? account?.email ?? id ?? 'none' }
            return <p key={provider}>{provider === 'openai' ? 'Codex' : 'Claude'}: Saved default: {name(saved)}; New chats: {name(actual)}</p>
          })}</div> : null}
        </header>

        {capAccount && shouldShowCapBanner(capKey, dismissedCapKey) ? (
          <div className="mb-[18px] flex items-center gap-3 rounded-[10px] border border-tone-danger/[0.28] bg-tone-danger/[0.07] px-3.5 py-3">
            <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-tone-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[light-dark(#dc2626,#fca5a5)]">
                {(capAccount.alias ?? capAccount.id)}: usage limit reached
              </div>
              <div className="mt-[1px] text-[11.5px] text-text-muted">
                This account has hit its usage limit. Switch to another
                account or wait for the reset.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {capSwitchTarget ? (
                <button
                  type="button"
                  onClick={() => submit(switchVerb(capSwitchTarget.id))}
                  className="accounts-button"
                >
                  Switch
                </button>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  toast(`Resets ${formatResetLabel(capAccount.usageResetAt)}`, {
                    tone: 'info',
                  })
                }
                className="rounded-[7px] border border-white/10 px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-shell-hover"
              >
                Resets {formatResetLabel(capAccount.usageResetAt)}
              </button>
              <button
                type="button"
                onClick={() => setDismissedCapKey(capKey)}
                className="rounded-[7px] border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-text-subtle transition-colors hover:bg-shell-hover"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {!snapshot ? (
          <WaitingState
            key={accountLoadAttempt}
            onSignIn={beginSignIn}
            onRetry={() => {
              getBridge().refreshAccountsPool()
              setAccountLoadAttempt(attempt => attempt + 1)
            }}
          />
        ) : (
          <>
          <div className="accounts-summaries">
            <ProviderSummary provider="anthropic" readyLabel={anthropicReadyLabel}
              name={activeClaude ? anthropicAccountName(activeClaude).title : snapshot.anthropicRouteAvailable ? 'Configured route' : 'No default account'}
              detail={activeClaude ? [anthropicAccountName(activeClaude).detail, claudeRateLimitTier(activeClaude.rateLimitTier) ?? accountPlanLabel(activeClaude.subscriptionType)].filter(Boolean).join(' · ') : null}
              stale={activeClaude?.usageStale}
              fiveHour={activeClaude ? { percent: activeClaude.usageFiveHour ?? null, resetAt: activeClaude.usageFiveHourResetAt } : null}
              weekly={activeClaude ? { percent: activeClaude.usageWeekly ?? null, resetAt: activeClaude.usageWeeklyResetAt } : null} />
            {active ? <CodexSummary account={active} readyLabel={readyLabel} /> : <ProviderSummary provider="openai" readyLabel={readyLabel} name="No default account" />}
          </div>
          <section className="accounts-section" aria-label="Claude accounts">
            <div className="accounts-section-header">
              <h2><ProviderMark provider="anthropic" />Claude accounts <span className="accounts-count">{snapshot.anthropicAccounts.length}</span></h2>
              <div className="accounts-section-actions">
                <button type="button" onClick={() => submit(touchAllVerb('anthropic'))} className="accounts-button">Check sign-ins</button>
                <button type="button" aria-label="Add Claude account" onClick={() => beginSignIn('anthropic')} className="accounts-button">+ Add account</button>
              </div>
            </div>
            <div className="accounts-list" data-window-card>
              {snapshot.anthropicAccounts.length === 0 ? <div className="accounts-empty">
                {snapshot.anthropicRouteAvailable ? 'Anthropic route configured through an API key or cloud provider.' : 'No Claude accounts linked yet.'}
              </div> : switchSnapshot!.anthropicAccounts.map(account => <ClaudeRow key={account.id} account={account} onAction={key => claudeAction(key, account)} />)}
            {(snapshot.anthropicSignedOutProfiles ?? []).length > 0 ? <>
              <div className="accounts-group">Signed out <span className="accounts-count">{snapshot.anthropicSignedOutProfiles!.length}</span></div>
              {snapshot.anthropicSignedOutProfiles!.map(profile => <SignedOutProfileRow key={profile.id}
                profile={{ ...profile, credentialGeneration: profile.loginGeneration, lifecycleGeneration: profile.loginGeneration,
                  state: 'signed_out', credentialGenerationState: null, lifecycleState: 'signed_out', lifecycleReadStatus: 'valid' }}
                onRelink={() => setDialog({ kind: 'relink', provider: 'anthropic', account: { ...profile, alias: profile.alias ?? profile.email } })}
                onDelete={() => setDialog({ kind: 'delete', target: { ...profile, provider: 'anthropic',
                  expectedCredentialGeneration: profile.loginGeneration, signedOut: true, isDefault: false } })} />)}
            </> : null}
            </div>
            {snapshot.anthropicCredentialSource && !['claude_subscription', 'none'].includes(snapshot.anthropicCredentialSource.kind) ? <p className="accounts-credential-source">Credential source: {snapshot.anthropicCredentialSource.variableName ?? snapshot.anthropicCredentialSource.kind.replaceAll('_', ' ')}</p> : null}
          </section>

          <section className="accounts-section" aria-label="Codex accounts">
            <div className="accounts-section-header">
              <h2><ProviderMark provider="openai" />Codex accounts <span className="accounts-count">{rows.length}</span></h2>
              <div className="accounts-section-actions">
                <button
                  type="button"
                  onClick={() => setDialog({ kind: 'touchall' })}
                  className="accounts-button"
                >
                  Refresh all
                </button>
                <button
                  type="button"
                  aria-label="Add Codex account"
                  onClick={() => beginSignIn('openai')}
                  className="accounts-button"
                >
                  + Add account
                </button>
              </div>
            </div>

            <div className="accounts-list" data-window-card>
            {rows.length === 0 ? (
              <div className="accounts-empty">
                {snapshot.signedOutProfiles.length > 0
                  ? 'No Codex accounts are signed in. Sign in again or add another account.'
                  : 'No Codex accounts are signed in.'}
              </div>
            ) : (
              <>
                  {rows.map(account => (
                    <PoolRow
                      key={account.id}
                      account={account}
                      signOutState={signOutStateFor(account.id)}
                      onAction={onRowAction}
                    />
                  ))}
              </>
            )}
            {snapshot.signedOutProfiles.length > 0 ? (
              <>
                <div className="accounts-group">Signed out <span className="accounts-count">{snapshot.signedOutProfiles.length}</span></div>
                  {snapshot.signedOutProfiles.map(profile => (
                    <SignedOutProfileRow
                      key={profile.id}
                      profile={profile}
                      onRelink={() =>
                        setDialog({ kind: 'relink', account: profile })
                      }
                      onDelete={() => {
                        const expectedCredentialGeneration =
                          profile.lifecycleGeneration ??
                          profile.credentialGeneration
                        if (expectedCredentialGeneration === null) return
                        setDialog({
                          kind: 'delete',
                          target: {
                            id: profile.id,
                            alias: profile.alias,
                            expectedCredentialGeneration,
                            isDefault: false,
                            signedOut: true,
                          },
                        })
                      }}
                    />
                  ))}
              </>
            ) : null}
            </div>
          </section>

          </>
        )}
      </div>

      {dialog?.kind === 'login' ? <SignInDialog provider={dialog.provider} onAuthorize={makeDefault => authorize(dialog.provider, makeDefault)} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'relink' ? (
        <RelinkAccountDialog
          account={dialog.account}
          onAuthorize={() => authorize(dialog.provider ?? 'openai')}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'touchall' ? (
        <TouchAllDialog
          onVerb={onVerb}
          lastResult={lastResult}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <RenameAccountDialog
          account={dialog.account}
          takenAliases={accountTakenAliases(snapshot)}
          onSubmit={alias => submit(renameVerb(dialog.account.id, alias, dialog.provider))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteAccountDialog
          target={dialog.target}
          hasOtherSwitchable={dialog.target.provider === 'anthropic'
            ? !!snapshot?.anthropicAccounts.some(a => a.id !== dialog.target.id && a.status === 'healthy')
            : selectHasOtherSwitchable(snapshot, dialog.target.id)}
          onConfirm={() =>
            submit(
              deleteVerb(
                dialog.target.id,
                dialog.target.expectedCredentialGeneration,
                dialog.target.provider,
              ),
              dialog.target.id,
            )
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'logout' ? (
        <LogoutAccountDialog
          account={dialog.account}
          hasOtherSwitchable={dialog.provider === 'anthropic'
            ? !!snapshot?.anthropicAccounts.some(a => a.id !== dialog.account.id && a.status === 'healthy')
            : selectHasOtherSwitchable(
            snapshot,
            dialog.account.id,
          )}
          onConfirm={() =>
            submit(
              logoutVerb(
                dialog.account.id,
                dialog.account.credentialGeneration,
                undefined,
                dialog.provider,
              ),
              dialog.account.id,
            )
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
    </main>
  )
}
