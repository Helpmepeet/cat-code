/**
 * Accounts page (P4-5, #14 fidelity rebuild) — the real Codex account pool +
 * lifecycle surface, rebuilt element-by-element from the prototype's
 * `AccountsPage`/`CodexPool`/`HeadroomBar`/`AccountLifecycle`
 * (Pages.jsx:354-471,506-575 + AccountLifecycle.jsx) in TS/Tailwind on the P0-2
 * tokens. Every inline `style` in the prototype was translated to its nearest
 * theme token/arbitrary utility: resting greys use `text-faint` /
 * `text-ghost`, bar tracks use `bg-white/[0.07]`, the status-dot tones
 * mirror POOL_STATUS (capped=danger, dead=warn, quarantined=grey), and the hero
 * row + active dot carry the prototype's pink glow.
 *
 * §0 DEFERRED (mock-backed, no real data source): the prototype AccountsPage's
 * large usage-analytics region — the 4-column stat grid (Pages.jsx:589), the
 * "Tokens by Account" / "Daily Tokens by Model" time-series charts
 * (AccountBars/ProfileLineChart with the 7d/30d toggle, Pages.jsx:609-686), and
 * the By-Account / By-Model / Main-vs-Subagents / Cache breakdown grids
 * (Pages.jsx:690,704) — has NO per-account daily-token history on the desktop
 * wire (the prototype's own comments call it DEMO-ONLY / "DERIVABLE-IF-LOGGED";
 * `AccountStatus` carries only 5h/weekly used-percent, not a token series). It is
 * NOT built here and MUST NOT be faked; it is deferred pending a real
 * usage-history data source/session. This page ships the real spine: pool table
 * + lifecycle verbs + active headroom, all from the redacted `AccountsSnapshot`.
 *
 * §0 DATA GAP (rendered faithfully, not faked): the prototype shows a per-window
 * reset under each headroom bar (`fiveHourReset`/`weeklyReset`). The wire carries
 * ONE `usageResetAt` (the primary/5h window), so the ↺-reset indicator is shown
 * only on the 5h bar and left blank on the weekly bar — never invented.
 *
 * Writes go ONLY through the `onVerb` prop (the HC3 `accountVerb` channel); the
 * sidecar re-resolves + re-validates every target (T6). Optimistic UI is
 * forbidden: a dialog dispatches its verb, remembers the minted `requestId`, and
 * closes + toasts only when the matching `account.result` (`lastResult`) arrives.
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
  AccountVerbMessage,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../../shared/protocol.js'
import { AccountsUsageSection } from './AccountsUsageSection.js'
import {
  selectAccountRows,
  selectActiveAccount,
  selectCapAccount,
  selectHasOtherSwitchable,
  selectReadyLabel,
  selectTakenAliases,
} from './accountsState.js'
import {
  deleteVerb,
  formatResetLabel,
  loginVerb,
  logoutVerb,
  renameError,
  renameVerb,
  resultToastTone,
  selectAccountMenuItems,
  selectAnthropicReadyLabel,
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
import type { ToastTone } from './toastModel.js'
import { toneClasses, type Tone } from './tone.js'

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
      className="rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-app-bg transition-opacity disabled:opacity-50"
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
      className="rounded-lg border border-white/[0.12] px-3.5 py-2 text-[12.5px] font-medium text-text-muted transition-colors hover:bg-shell-hover"
    >
      {children}
    </button>
  )
}

function DangerBtn({
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
      className="rounded-lg bg-[#ef4444] px-3.5 py-2 text-[13px] font-semibold text-white"
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
  const p = pct ?? 0
  const t = toneClasses(usageTone(pct))
  return (
    <div className="flex items-center gap-[9px]">
      <span className="w-7 shrink-0 text-[10px] tabular-nums text-text-faint">
        {label}
      </span>
      <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-white/[0.07]">
        {/* §0 EXCEPTION: data-driven percent width Tailwind can't express — the
            single allowed inline style here (width only), per the P4-5 brief. */}
        <div className={`h-full rounded-full ${t.dot}`} style={{ width: `${p}%` }} />
      </div>
      <span
        className={`w-8 shrink-0 text-right text-[11px] font-semibold tabular-nums ${t.text}`}
      >
        {p}%
      </span>
      {showReset ? (
        <span className="w-[54px] shrink-0 text-[10px] tabular-nums text-text-ghost">
          {resetAt != null ? `↺ ${formatResetLabel(resetAt)}` : ''}
        </span>
      ) : null}
    </div>
  )
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
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className="animate-toast-in w-[460px] max-w-[calc(100%-48px)] overflow-hidden rounded-[14px] border border-white/10 bg-[#0c0c0e] shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
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

/**
 * Sign-in, in both of its meanings: adding an account and restoring one whose
 * credentials died. It is deliberately ONE dialog on ONE verb, because the
 * engine flow is one flow. `account.login` carries no account id: which account
 * a sign-in lands on is decided by whoever the user picks in the browser, and
 * the sidecar re-links by comparing the returned identity against the pool
 * (`accountsDomain.ts:263`).
 *
 * That is exactly why the repair copy exists. The identity is chosen out in the
 * browser where nothing can guard it, so naming the expected account is the only
 * thing standing between a repair and a silently-added second account.
 */
function AddAccountDialog({
  account,
  onAuthorize,
  onClose,
}: {
  /** The account being restored, or undefined when adding a new one. */
  account?: AccountStatus
  onAuthorize: () => void
  onClose: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const name = account ? account.alias ?? account.id : null
  return (
    <ALDialog
      title={account ? 'Sign in again' : 'Add Codex account'}
      sub={
        account
          ? `Restores ${name}. Its name and history stay as they are.`
          : 'Signs in with your ChatGPT Plus/Pro subscription via OAuth.'
      }
      onClose={onClose}
      footer={
        submitting ? (
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
        ) : (
          <>
            <GhostBtn onClick={onClose}>Cancel</GhostBtn>
            <PrimaryBtn
              onClick={() => {
                setSubmitting(true)
                onAuthorize()
              }}
            >
              Open browser to sign in
            </PrimaryBtn>
          </>
        )
      }
    >
      {submitting ? (
        <div className="flex items-center gap-2.5 text-[13px] text-text-muted">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-text-ghost border-t-accent" />
          Opening your browser…
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-text-muted">
          We&apos;ll open your browser to authorize, then capture the callback
          locally on{' '}
          <code className="font-mono text-text-primary">127.0.0.1:1455</code>.{' '}
          {account ? (
            <>
              Pick the same ChatGPT account you used for{' '}
              <span className="font-semibold text-text-primary">{name}</span>:
              signing in with a different one adds a second account instead of
              restoring this one.
            </>
          ) : (
            <>
              No API key needed: this is an OpenAI account (ChatGPT subscription)
              login.
            </>
          )}
        </p>
      )}
    </ALDialog>
  )
}

function RenameAccountDialog({
  account,
  takenAliases,
  onSubmit,
  onClose,
}: {
  account: AccountStatus
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
        <div className="mt-[7px] text-[11px] text-[#fca5a5]">{err}</div>
      ) : null}
    </ALDialog>
  )
}

function DeleteAccountDialog({
  account,
  hasOtherSwitchable,
  onConfirm,
  onClose,
}: {
  account: AccountStatus
  hasOtherSwitchable: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const alias = account.alias ?? account.id
  return (
    <ALDialog
      title={`Delete “${alias}”?`}
      sub="Removes the saved account profile from disk and releases its leases. This can't be undone."
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <DangerBtn onClick={onConfirm}>Delete account</DangerBtn>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-text-muted">
        The OAuth token and alias for{' '}
        <span className="font-mono text-text-primary">{alias}</span> are erased.
        {account.isDefault ? (
          <span className="text-tone-warn">
            {hasOtherSwitchable
              ? ' This is the active account, so another will be activated.'
              : ' This is the active account, and no other usable account remains. You’ll have none active until you sign in.'}
          </span>
        ) : null}
      </div>
    </ALDialog>
  )
}

function LogoutAccountDialog({
  account,
  onConfirm,
  onClose,
}: {
  account: AccountStatus
  onConfirm: () => void
  onClose: () => void
}) {
  const alias = account.alias ?? account.id
  return (
    <ALDialog
      title={`Sign out “${alias}”?`}
      sub="Clears the active session's credentials. The saved profile stays on disk, so you can sign back in any time, or delete it separately."
      onClose={onClose}
      footer={
        <>
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={onConfirm}>Sign out</PrimaryBtn>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-text-muted">
        The saved profile for{' '}
        <span className="font-mono text-text-primary">{alias}</span> stays on
        disk. Delete it separately to remove it entirely.
      </div>
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

  // Dispatch once on open; this dialog self-correlates (it RENDERS the per-account
  // results rather than toast+close, so it stays out of the page's generic pending).
  useEffect(() => {
    const verb = touchAllVerb()
    requestIdRef.current = verb.requestId
    onVerb(verb)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const matched =
    !!lastResult &&
    lastResult.requestId === requestIdRef.current &&
    lastResult.verb === 'account.touchAll'
  const results = matched ? lastResult.touchAllResults ?? [] : []

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
      footer={<GhostBtn onClick={onClose}>{running ? 'Cancel' : 'Done'}</GhostBtn>}
    >
      {running ? (
        <div className="flex items-center gap-2.5 text-[12.5px] text-text-muted">
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-shell-seam border-t-text-muted" />
          Refreshing…
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
  onAction,
}: {
  account: AccountStatus
  onAction: (key: AccountMenuKey, account: AccountStatus) => void
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()

  const items = selectAccountMenuItems(account)
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
          className="absolute right-0 top-8 z-[20] min-w-[180px] rounded-[10px] border border-white/[0.12] bg-[#141417] p-[5px] shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
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
  hero,
  onAction,
}: {
  account: AccountStatus
  hero?: boolean
  onAction: (key: AccountMenuKey, account: AccountStatus) => void
}) {
  const usable = account.status === 'healthy'
  const pressured = usable && account.usageLimitReached
  const dimmed = account.status === 'dead'
  const t = toneClasses(statusDotTone(account))
  // The availability LABEL follows pure STATUS colour (no default→pink); only the
  // DOT carries the pink-for-default override — decoupled per the prototype
  // (Pages.jsx:409 dot vs :417 label).
  const labelTone = toneClasses(statusLabelTone(account))
  const alias = account.alias ?? account.id
  return (
    <div
      className={`flex items-center gap-3.5 border ${
        hero
          ? 'rounded-xl border-accent/[0.28] bg-accent/5 px-4 py-[14px] shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.06),0_8px_24px_-12px_rgb(var(--accent-rgb)/0.25)]'
          : 'rounded-[10px] border-white/[0.06] bg-white/[0.018] px-3.5 py-[11px]'
      } ${dimmed ? 'opacity-55' : ''}`}
    >
      <span
        className={`shrink-0 rounded-full ${
          hero ? 'h-[9px] w-[9px] shadow-[0_0_8px_rgb(var(--accent-rgb)/0.6)]' : 'h-2 w-2'
        } ${t.dot} ${account.status === 'quarantined' ? 'animate-pulse' : ''}`}
      />
      <div className="w-[150px] shrink-0">
        <div className="flex items-center gap-[7px]">
          <span
            className={`truncate font-semibold ${hero ? 'text-[14.5px]' : 'text-[13px]'} text-text-primary`}
          >
            {alias}
          </span>
          {account.isDefault ? (
            <span className="shrink-0 rounded bg-accent/[0.12] px-[5px] py-[1.5px] text-[8px] font-bold uppercase tracking-[0.06em] text-accent">
              active
            </span>
          ) : null}
        </div>
        <div className="mt-[1px] truncate text-[11px]">
          <span className={pressured ? 'text-tone-warn' : labelTone.text}>
            {pressured ? 'Near limit' : account.availabilityLabel}
          </span>
          {account.lastError ? (
            <span className="text-text-faint"> · {account.lastError}</span>
          ) : null}
        </div>
      </div>
      {usable ? (
        <div className={`flex flex-1 flex-col ${hero ? 'gap-[7px]' : 'gap-1.5'}`}>
          <HeadroomBar
            label="5h"
            pct={account.usagePrimary}
            resetAt={account.usageResetAt}
            showReset
          />
          <HeadroomBar label="wk" pct={account.usageWeekly} resetAt={null} showReset />
        </div>
      ) : (
        <div className="flex-1 text-[11px] text-text-faint">
          {account.status === 'capped'
            ? `Resets ${formatResetLabel(account.usageResetAt)}`
            : ''}
        </div>
      )}
      <AccountRowMenu account={account} onAction={onAction} />
    </div>
  )
}

/* ── header pieces ── */

function ActiveHeadroom({ account }: { account: AccountStatus }) {
  return (
    <div className="rounded-[10px] border border-accent/[0.18] bg-accent/[0.04] px-4 py-2.5">
      <div className="mb-[9px] flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_6px_rgb(var(--accent-rgb)/0.6)]" />
        <span className="font-mono text-[12.5px] font-semibold text-text-primary">
          {account.alias ?? account.id}
        </span>
        <span className="rounded bg-accent/[0.12] px-[5px] py-[1.5px] text-[8.5px] font-bold uppercase tracking-[0.06em] text-accent">
          active
        </span>
        <span className="ml-0.5 text-[10.5px] text-text-faint">used</span>
      </div>
      <div className="flex gap-[18px]">
        {(
          [
            ['5h', account.usagePrimary, account.usageResetAt],
            ['Weekly', account.usageWeekly, null],
          ] as const
        ).map(([k, pct, resetAt]) => {
          const t = toneClasses(usageTone(pct))
          const p = pct ?? 0
          return (
            <div key={k} className="min-w-[78px]">
              <div className="mb-1.5 flex items-baseline gap-1.5">
                <span className={`text-[18px] font-bold tabular-nums ${t.text}`}>
                  {p}%
                </span>
                <span className="text-[10px] uppercase tracking-[0.06em] text-text-faint">
                  {k}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.07]">
                {/* §0 EXCEPTION: data-driven percent width — the single allowed inline style. */}
                <div
                  className={`h-full rounded-full ${t.dot}`}
                  style={{ width: `${p}%` }}
                />
              </div>
              <div className="mt-1 text-[9.5px] tabular-nums text-text-ghost">
                {resetAt != null ? `↺ resets ${formatResetLabel(resetAt)}` : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Shown only until the first pool refresh lands (accounts owner: main polls a
 * disposable worker, `decisions/ACCOUNTS-OWNERSHIP.md`), so this is a brief load
 * rather than a "needs a session" state. Copy carries no internal vocabulary
 * per CLAUDE.md §7: what the page is waiting on is our problem, not the user's.
 */
function WaitingState() {
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div className="text-sm font-semibold text-text-muted">
        Loading accounts…
      </div>
    </section>
  )
}

/* ── page ── */

type DialogState =
  | { kind: 'add' }
  | { kind: 'relink'; account: AccountStatus }
  | { kind: 'touchall' }
  | { kind: 'rename'; account: AccountStatus }
  | { kind: 'delete'; account: AccountStatus }
  | { kind: 'logout'; account: AccountStatus }
  | null

type Pending = {
  requestId: string
  onDone: (result: AccountResultFrame) => void
}

export function AccountsPage({
  snapshot,
  lastResult,
  usageStats = null,
  activeStatsRange = '7d',
  onRangeChange,
  onVerb,
}: {
  snapshot: AccountsSnapshot | null
  lastResult: AccountResultFrame | null
  usageStats?: UsageStatsSnapshot | null
  activeStatsRange?: UsageStatsRange
  onRangeChange?: (range: UsageStatsRange) => void
  onVerb: (verb: AccountVerbMessage) => void
}): ReactElement {
  const toast = useToast()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [capDismissed, setCapDismissed] = useState(false)
  const [localRange, setLocalRange] = useState<UsageStatsRange>(activeStatsRange)
  const currentRange = onRangeChange ? activeStatsRange : localRange

  function handleRangeChange(newRange: UsageStatsRange): void {
    setLocalRange(newRange)
    onRangeChange?.(newRange)
  }
  const pendingRef = useRef<Pending | null>(null)

  // Correlate a dispatched verb with its `account.result` by requestId: NO
  // optimistic UI — we toast + close only when the real outcome arrives.
  useEffect(() => {
    const pending = pendingRef.current
    if (lastResult && pending && lastResult.requestId === pending.requestId) {
      pendingRef.current = null
      pending.onDone(lastResult)
    }
  }, [lastResult])

  const rows = selectAccountRows(snapshot)
  const active = selectActiveAccount(snapshot)
  const capAccount = selectCapAccount(snapshot)
  const readyLabel = selectReadyLabel(snapshot)
  const anthropicReadyLabel = selectAnthropicReadyLabel(snapshot)
  const rest = rows.filter(a => a.id !== active?.id)
  const capSwitchTarget = capAccount
    ? rows.find(a => a.id !== capAccount.id && a.switchable) ?? null
    : null

  // Dispatch a toast-and-close verb; `tone` softens the SUCCESS tone only (a
  // started sign-in is an 'info', not a completion). A refusal keeps the failure
  // tone whatever the caller asked for: the sign-in verbs are refused outright
  // when no session is open, and an override would paint that refusal as neutral
  // news while nothing had happened.
  function submit(verb: AccountVerbMessage, tone?: ToastTone): void {
    pendingRef.current = {
      requestId: verb.requestId,
      onDone: result => {
        toast(result.message, {
          tone: result.ok ? tone ?? resultToastTone(true) : resultToastTone(false),
        })
        setDialog(null)
      },
    }
    onVerb(verb)
  }

  function onRowAction(key: AccountMenuKey, account: AccountStatus): void {
    if (key === 'switch') {
      submit(switchVerb(account.id))
      return
    }
    setDialog({ kind: key, account })
  }

  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-7 py-7">
      <div className="mx-auto w-full max-w-[1000px]">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Accounts
            </h1>
            <p className="mt-1 text-[13px] text-text-faint">
              Anthropic and Codex subscription accounts available to Cat Code.
            </p>
          </div>
          {active && active.status === 'healthy' ? (
            <ActiveHeadroom account={active} />
          ) : null}
        </header>

        {capAccount && !capDismissed ? (
          <div className="mb-[18px] flex items-center gap-3 rounded-[10px] border border-tone-danger/[0.28] bg-tone-danger/[0.07] px-3.5 py-3">
            <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-tone-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[#fca5a5]">
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
                  className="rounded-[7px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-app-bg"
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
                onClick={() => setCapDismissed(true)}
                className="rounded-[7px] border border-white/[0.08] px-2.5 py-1.5 text-[12px] text-text-subtle transition-colors hover:bg-shell-hover"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {!snapshot ? (
          <WaitingState />
        ) : (
          <>
          <section className="mb-[22px]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-text-subtle">
                  Anthropic Pool
                </h2>
                <span className="text-[12px] tabular-nums text-text-faint">
                  {anthropicReadyLabel}
                </span>
              </div>
              <button
                type="button"
                onClick={() => submit(loginVerb('anthropic'), 'info')}
                className="rounded-[7px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-app-bg"
              >
                + Add Anthropic
              </button>
            </div>
            {snapshot.anthropicAccounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-7 text-center text-[12.5px] text-text-subtle">
                {snapshot.anthropicRouteAvailable
                  ? 'Anthropic route configured through an API key or cloud provider.'
                  : 'No Anthropic accounts linked yet.'}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {snapshot.anthropicAccounts.map(account => (
                  <div
                    key={account.id}
                    className="flex items-center gap-3 rounded-[10px] border border-shell-seam bg-surface-panel px-4 py-3"
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        account.status !== 'healthy'
                          ? 'bg-tone-danger'
                          : account.isDefault
                            ? 'bg-accent'
                            : 'bg-tone-good'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] text-text-primary">
                          {account.alias ?? account.email}
                        </span>
                        {account.isDefault ? (
                          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-accent">
                            active
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-text-subtle">
                        {account.email}
                      </div>
                    </div>
                    <span className="text-[11.5px] capitalize text-text-muted">
                      {account.status === 'healthy'
                        ? account.subscriptionType ?? account.status
                        : account.status}
                    </span>
                    {!account.isDefault && account.status === 'healthy' ? (
                      <button
                        type="button"
                        onClick={() =>
                          submit(switchVerb(account.id, 'anthropic'))
                        }
                        className="rounded-md border border-shell-seam px-2.5 py-1 text-[11px] font-semibold text-text-subtle hover:bg-shell-hover hover:text-text-primary"
                      >
                        Switch
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="mb-[22px]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-text-subtle">
                  Codex Pool
                </h2>
                <span className="text-[12px] tabular-nums text-text-faint">
                  {readyLabel}
                </span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setDialog({ kind: 'touchall' })}
                  className="rounded-[7px] border border-white/10 px-[11px] py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:border-white/20 hover:text-text-primary"
                >
                  Refresh all
                </button>
                <button
                  type="button"
                  onClick={() => setDialog({ kind: 'add' })}
                  className="rounded-[7px] bg-accent px-3 py-1.5 text-[12px] font-semibold text-app-bg"
                >
                  + Add account
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center text-[12.5px] text-text-subtle">
                No Codex accounts in the pool yet. Add one to sign in.
              </div>
            ) : (
              <>
                {active ? (
                  <div className="mb-2">
                    <PoolRow account={active} hero onAction={onRowAction} />
                  </div>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  {rest.map(account => (
                    <PoolRow
                      key={account.id}
                      account={account}
                      onAction={onRowAction}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          {/* Real engine-backed usage analytics (7d / 30d global range filter) */}
          <AccountsUsageSection
            stats={usageStats}
            activeRange={currentRange}
            onRangeChange={handleRangeChange}
          />
          </>
        )}
      </div>

      {dialog?.kind === 'add' ? (
        <AddAccountDialog
          onAuthorize={() => submit(loginVerb('openai'), 'info')}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'relink' ? (
        <AddAccountDialog
          account={dialog.account}
          onAuthorize={() => submit(loginVerb('openai'), 'info')}
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
          takenAliases={selectTakenAliases(snapshot)}
          onSubmit={alias => submit(renameVerb(dialog.account.id, alias))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteAccountDialog
          account={dialog.account}
          hasOtherSwitchable={selectHasOtherSwitchable(snapshot, dialog.account.id)}
          onConfirm={() => submit(deleteVerb(dialog.account.id))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'logout' ? (
        <LogoutAccountDialog
          account={dialog.account}
          onConfirm={() => submit(logoutVerb())}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </main>
  )
}
