/**
 * Accounts page (P4-5) — the real Codex account pool + lifecycle surface,
 * rebuilt from the prototype's `AccountsPage`/`CodexPool`/`AccountLifecycle`
 * (Pages.jsx:374-575, AccountLifecycle.jsx) in TS/Tailwind on the P0-2 tokens.
 *
 * §0 DEFERRED (fixture-only): the prototype AccountsPage's large usage-analytics
 * section (Trends "Tokens by Account" / "Daily Tokens by Model" charts; the
 * By-Account / By-Model / Main-vs-Subagents / Cache breakdown bars; the
 * "Tokens Today / This Week / Cache Hit Rate" stat cards) has NO real per-account
 * or per-model token backing — the prototype's own comments call it DEMO-ONLY
 * ("cat-code has no per-account token series today", "DERIVABLE-IF-LOGGED"). It
 * is deferred to a future usage-logging session and is NOT built here. This page
 * ships the real spine: the pool table + lifecycle verbs + active headroom, all
 * from the real redacted `AccountsSnapshot` read-seam. The one genuinely-real
 * summary stat ("N of M ready") is kept in the header.
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
  AccountDeleteMessage,
  AccountLoginMessage,
  AccountLogoutMessage,
  AccountRenameMessage,
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AccountSwitchMessage,
  AccountTouchAllMessage,
  AccountVerbMessage,
} from '../../shared/protocol.js'
import {
  selectAccountRows,
  selectActiveAccount,
  selectCapAccount,
  selectHasOtherSwitchable,
  selectReadyLabel,
  selectTakenAliases,
} from './accountsState.js'
import { useToast, type ToastTone } from './ToastHost.js'
import { toneClasses, type Tone } from './tone.js'

/* ── pure helpers (unit-tested without a DOM, like tone.ts / toastReducer) ── */

const newRequestId = (): string => crypto.randomUUID()

export function switchVerb(accountId: string): AccountSwitchMessage {
  return { type: 'account.switch', requestId: newRequestId(), accountId }
}
export function renameVerb(accountId: string, alias: string): AccountRenameMessage {
  return { type: 'account.rename', requestId: newRequestId(), accountId, alias }
}
export function deleteVerb(accountId: string): AccountDeleteMessage {
  return { type: 'account.delete', requestId: newRequestId(), accountId, confirm: true }
}
export function logoutVerb(): AccountLogoutMessage {
  return { type: 'account.logout', requestId: newRequestId() }
}
export function touchAllVerb(): AccountTouchAllMessage {
  return { type: 'account.touchAll', requestId: newRequestId() }
}
export function loginVerb(): AccountLoginMessage {
  return { type: 'account.login', requestId: newRequestId() }
}

/** Toast tone for a verb outcome (success on ok, danger otherwise). */
export function resultToastTone(ok: boolean): ToastTone {
  return ok ? 'success' : 'danger'
}

/** Bar/number tone by usage pressure: ≥90 danger, ≥65 warn, else good. */
export function usageTone(pct: number | null): Tone {
  const p = pct ?? 0
  return p >= 90 ? 'danger' : p >= 65 ? 'warn' : 'good'
}

/** Status-dot tone for a pool row (prompt mapping, redacted fields only). */
export function statusDotTone(account: AccountStatus): Tone {
  if (account.status === 'healthy' && account.usageLimitReached) return 'warn'
  if (account.isDefault) return 'accent'
  if (account.status === 'healthy') return 'good'
  if (account.status === 'capped') return 'warn'
  if (account.status === 'dead') return 'danger'
  return 'warn' // quarantined — transient, shown as a (pulsing) warn dot
}

export type AccountMenuKey = 'switch' | 'rename' | 'logout' | 'delete'
export type AccountMenuItem = { key: AccountMenuKey; label: string; danger?: boolean }

/**
 * Row ⋯ menu items, gated on the REAL redacted fields (never a renderer guess):
 * switch ← `switchable`; rename/delete ← `hasVaultProfile`; sign out ← `isDefault`.
 */
export function selectAccountMenuItems(account: AccountStatus): AccountMenuItem[] {
  const items: AccountMenuItem[] = []
  if (account.switchable) items.push({ key: 'switch', label: 'Switch to this account' })
  if (account.hasVaultProfile) items.push({ key: 'rename', label: 'Rename' })
  if (account.isDefault) items.push({ key: 'logout', label: 'Sign out' })
  if (account.hasVaultProfile) items.push({ key: 'delete', label: 'Delete', danger: true })
  return items
}

const ALIAS_RE = /^[a-zA-Z0-9_-]{1,32}$/

/**
 * Client-side rename validation for INSTANT feedback only — the sidecar is
 * authoritative (`validateCodexAccountAlias` re-runs there). Returns null when ok.
 */
export function renameError(
  value: string,
  currentAlias: string | null,
  takenAliases: string[],
): string | null {
  if (!value) return 'Alias required'
  if (!ALIAS_RE.test(value)) return '1–32 chars · letters, numbers, - or _'
  const taken = takenAliases
    .filter(a => a !== currentAlias)
    .map(a => a.toLowerCase())
  if (taken.includes(value.toLowerCase())) return 'That alias is already in use'
  return null
}

/** Human reset label from the pool's Unix-SECONDS reset hint. */
export function formatResetLabel(sec: number | null): string {
  if (!sec) return 'soon'
  const ms = sec * 1000 - Date.now()
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`
}

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
      className="rounded-lg border border-shell-seam px-3.5 py-2 text-[12.5px] font-medium text-text-muted transition-colors hover:bg-shell-hover"
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

function HeadroomBar({ label, pct }: { label: string; pct: number | null }) {
  const p = pct ?? 0
  const t = toneClasses(usageTone(pct))
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-6 shrink-0 text-[10px] tabular-nums text-text-subtle">
        {label}
      </span>
      <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-shell-hover">
        {/* §0 EXCEPTION: data-driven percent width Tailwind can't express — the
            single allowed inline style here (width only), per the P4-5 brief. */}
        <div className={`h-full rounded-full ${t.dot}`} style={{ width: `${p}%` }} />
      </div>
      <span
        className={`w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums ${t.text}`}
      >
        {p}%
      </span>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      role="presentation"
      onClick={onClose}
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
        className="animate-toast-in w-[460px] max-w-[calc(100%-48px)] overflow-hidden rounded-xl border border-shell-seam bg-surface-panel shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <div className="border-b border-shell-seam px-[18px] py-4">
          <div className="text-[14.5px] font-semibold text-text-primary">
            {title}
          </div>
          {sub ? (
            <div className="mt-1 text-[12px] leading-relaxed text-text-subtle">
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

function AddAccountDialog({
  onAuthorize,
  onClose,
}: {
  onAuthorize: () => void
  onClose: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  return (
    <ALDialog
      title="Add Codex account"
      sub="Signs in with your ChatGPT Plus/Pro subscription via OAuth."
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
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-shell-seam border-t-accent" />
          Handing off to the engine's sign-in flow…
        </div>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-text-muted">
          We&apos;ll open your browser to authorize, then capture the callback
          locally on{' '}
          <code className="font-mono text-text-primary">127.0.0.1:1455</code>. No
          API key — this is an OpenAI account (ChatGPT subscription) login.
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
        className={`w-full rounded-lg border bg-app-bg px-3 py-2.5 font-mono text-[13px] text-text-primary outline-none ${
          err && value ? 'border-tone-danger/40' : 'border-shell-seam'
        }`}
      />
      {err && value ? (
        <div className="mt-1.5 text-[11px] text-tone-danger">{err}</div>
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
        disk — delete it separately to remove it entirely.
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
              className="flex items-center justify-between rounded-[7px] border border-shell-seam bg-shell-hover/30 px-2.5 py-[7px]"
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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const items = selectAccountMenuItems(account)
  if (items.length === 0) return null

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-label="Account actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={`flex h-7 w-7 items-center justify-center rounded-md text-[17px] leading-none text-text-muted transition-colors hover:bg-shell-hover ${
          open ? 'bg-shell-hover' : ''
        }`}
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-8 z-[20] min-w-[180px] rounded-[10px] border border-shell-seam bg-surface-raised p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
        >
          {items.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onAction(it.key, account)
              }}
              className={`block w-full rounded-[7px] px-2.5 py-[7px] text-left text-[12.5px] transition-colors ${
                it.danger
                  ? 'text-tone-danger hover:bg-tone-danger/10'
                  : 'text-text-muted hover:bg-shell-hover'
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
  const alias = account.alias ?? account.id
  return (
    <div
      className={`flex items-center gap-3.5 border px-4 py-3 ${
        hero
          ? 'rounded-xl border-accent/25 bg-accent/5'
          : 'rounded-lg border-shell-seam bg-shell-hover/20'
      } ${dimmed ? 'opacity-55' : ''}`}
    >
      <span
        className={`shrink-0 rounded-full ${hero ? 'h-[9px] w-[9px]' : 'h-2 w-2'} ${t.dot} ${
          account.status === 'quarantined' ? 'animate-pulse' : ''
        }`}
      />
      <div className="w-[150px] shrink-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`truncate font-semibold ${hero ? 'text-[14.5px]' : 'text-[13px]'} text-text-primary`}
          >
            {alias}
          </span>
          {account.isDefault ? (
            <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.06em] text-accent">
              active
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11px]">
          <span className={pressured ? 'text-tone-warn' : t.text}>
            {pressured ? 'Near limit' : account.availabilityLabel}
          </span>
          {account.lastError ? (
            <span className="text-text-subtle"> · {account.lastError}</span>
          ) : null}
        </div>
      </div>
      {usable ? (
        <div className="flex flex-1 flex-col gap-1.5">
          <HeadroomBar label="5h" pct={account.usagePrimary} />
          <HeadroomBar label="wk" pct={account.usageWeekly} />
        </div>
      ) : (
        <div className="flex-1 text-[11px] text-text-subtle">
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
    <div className="rounded-[10px] border border-accent/20 bg-accent/5 px-4 py-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="font-mono text-[12.5px] font-semibold text-text-primary">
          {account.alias ?? account.id}
        </span>
        <span className="rounded bg-accent/10 px-1.5 py-px text-[8.5px] font-bold uppercase tracking-[0.06em] text-accent">
          active
        </span>
        <span className="ml-0.5 text-[10.5px] text-text-subtle">used</span>
      </div>
      <div className="flex gap-[18px]">
        {([['5h', account.usagePrimary], ['Weekly', account.usageWeekly]] as const).map(
          ([k, pct]) => {
            const t = toneClasses(usageTone(pct))
            const p = pct ?? 0
            return (
              <div key={k} className="min-w-[78px]">
                <div className="mb-1.5 flex items-baseline gap-1.5">
                  <span className={`text-[18px] font-bold tabular-nums ${t.text}`}>
                    {p}%
                  </span>
                  <span className="text-[10px] uppercase tracking-[0.06em] text-text-subtle">
                    {k}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-shell-hover">
                  {/* §0 EXCEPTION: data-driven percent width — the single allowed inline style. */}
                  <div
                    className={`h-full rounded-full ${t.dot}`}
                    style={{ width: `${p}%` }}
                  />
                </div>
              </div>
            )
          },
        )}
      </div>
    </div>
  )
}

function WaitingState() {
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div className="text-sm font-semibold text-text-muted">
        Waiting for the engine&apos;s account pool snapshot…
      </div>
      <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-relaxed text-text-subtle">
        This page does not use prototype fixtures. It fills once the sidecar sends
        the real redacted Codex account pool for the active session.
      </p>
    </section>
  )
}

/* ── page ── */

type DialogState =
  | { kind: 'add' }
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
  onVerb,
}: {
  snapshot: AccountsSnapshot | null
  lastResult: AccountResultFrame | null
  onVerb: (verb: AccountVerbMessage) => void
}): ReactElement {
  const toast = useToast()
  const [dialog, setDialog] = useState<DialogState>(null)
  const [capDismissed, setCapDismissed] = useState(false)
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
  const rest = rows.filter(a => a.id !== active?.id)
  const capSwitchTarget = capAccount
    ? rows.find(a => a.id !== capAccount.id && a.switchable) ?? null
    : null

  // Dispatch a toast-and-close verb; `tone` overrides the ok/err default (login
  // uses 'info' for the P4-15-deferred message).
  function submit(verb: AccountVerbMessage, tone?: ToastTone): void {
    pendingRef.current = {
      requestId: verb.requestId,
      onDone: result => {
        toast(result.message, { tone: tone ?? resultToastTone(result.ok) })
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
    <main className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[1000px]">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Accounts
            </h1>
            <p className="mt-1 text-[13px] text-text-subtle">
              Your Codex pool and what it&apos;s burning.{' '}
              <span className="text-text-muted">{readyLabel}</span>
            </p>
          </div>
          {active && active.status === 'healthy' ? (
            <ActiveHeadroom account={active} />
          ) : null}
        </header>

        {capAccount && !capDismissed ? (
          <div className="mb-[18px] flex items-center gap-3 rounded-lg border border-tone-danger/25 bg-tone-danger/5 px-3.5 py-3">
            <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full bg-tone-danger" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-tone-danger">
                {(capAccount.alias ?? capAccount.id)}: usage limit reached
              </div>
              <div className="mt-0.5 text-[11.5px] text-text-muted">
                This account is capped. Switch to another account or wait for the
                reset.
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
                className="rounded-[7px] border border-shell-seam px-3 py-1.5 text-[12px] text-text-muted transition-colors hover:bg-shell-hover"
              >
                Resets {formatResetLabel(capAccount.usageResetAt)}
              </button>
              <button
                type="button"
                onClick={() => setCapDismissed(true)}
                className="rounded-[7px] border border-shell-seam px-2.5 py-1.5 text-[12px] text-text-subtle transition-colors hover:bg-shell-hover"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {!snapshot ? (
          <WaitingState />
        ) : (
          <section className="mb-[22px]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[13px] font-bold uppercase tracking-[0.08em] text-text-subtle">
                  Codex Pool
                </h2>
                <span className="text-[12px] tabular-nums text-text-subtle">
                  {readyLabel}
                </span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setDialog({ kind: 'touchall' })}
                  className="rounded-[7px] border border-shell-seam px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-shell-hover"
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
        )}
      </div>

      {dialog?.kind === 'add' ? (
        <AddAccountDialog
          onAuthorize={() => submit(loginVerb(), 'info')}
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
