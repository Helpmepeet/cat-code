/**
 * LeaseRoster (P4-8b, D2 `decisions/AGENT-CHROME.md`) — the orchestrator page's
 * "Leases" tab: which Codex accounts this session's agents draw on. Per D2 §2 the
 * lease roster is session-scoped + read-only; per the P4-8b brief it REUSES the
 * P4-5 accounts read-seam (`accountsState` selectors over `AccountsSnapshot`),
 * never a second accounts/lease seam.
 *
 * §0 DEGRADED (C3 extend-engine-vs-change-UI flag): the prototype's LeaseRoster
 * shows PER-OWNER lease bindings (`ownerId → account`, main/subagent rows,
 * `failoverCount ×N`, per-session `strategy`, and an `account.lease.failover`
 * event strip) sourced from `getCodexLeaseSnapshot` (`codexAccountLeaseManager.ts`,
 * fixture-fed in the prototype as `MOCK_CODEX_LEASES`). NONE of those per-owner
 * fields are on the `accounts.snapshot` wire — that frame carries the redacted
 * POOL status only (per-account health/usage/availability), not the owner→account
 * lease map. Rather than invent a lease frame or mock the binding (D2 C5 forbids
 * mock workers/leases), this tab renders the honest, real thing: the pool the
 * session leases from, active account first. Surfacing the per-owner lease map is
 * a flagged engine-extension (a session-scoped `lease.snapshot` frame), not built
 * here. No inline style; static tone→class maps only (`toneClasses`).
 */
import {
  selectAccountRows,
  selectActiveAccount,
  selectReadyLabel,
} from './accountsState.js'
import { statusDotTone } from './AccountsPage.js'
import { toneClasses } from './tone.js'
import type { AccountsSnapshot, AccountStatus } from '../../shared/protocol.js'

/** One pool account as a lease-source row (status dot · alias · availability · usage). */
function LeaseAccountRow({ account }: { account: AccountStatus }) {
  const tone = toneClasses(statusDotTone(account))
  const alias = account.alias ?? account.id
  const dimmed = account.status === 'dead'
  const usable = account.status === 'healthy'
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-shell-seam bg-shell-hover/20 px-3.5 py-2.5 ${
        dimmed ? 'opacity-55' : ''
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${tone.dot} ${
          account.status === 'quarantined' ? 'animate-pulse' : ''
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[12.5px] font-semibold text-text-primary">
            {alias}
          </span>
          {account.isDefault ? (
            <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-[0.06em] text-accent">
              active
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11px]">
          <span className={tone.text}>{account.availabilityLabel}</span>
          {account.lastError ? (
            <span className="text-text-subtle"> · {account.lastError}</span>
          ) : null}
        </div>
      </div>
      {usable && account.usagePrimary !== null ? (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-subtle">
          {account.usagePrimary}% <span className="text-text-subtle/60">5h</span>
        </span>
      ) : null}
    </div>
  )
}

export function LeaseRoster({ snapshot }: { snapshot: AccountsSnapshot | null }) {
  const rows = selectAccountRows(snapshot)
  const active = selectActiveAccount(snapshot)
  const rest = rows.filter(account => account.id !== active?.id)

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[10px] border border-shell-seam bg-shell-chrome px-3.5 py-3">
        <p className="text-[11.5px] leading-relaxed text-text-muted">
          The Codex accounts this session&apos;s agents lease from.{' '}
          <span className="text-text-subtle">
            Leases aren&apos;t locks — many agents can share one account.
          </span>
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-shell-seam px-6 py-9 text-center">
          <p className="text-[12.5px] font-medium text-text-muted">No active leases</p>
          <p className="mt-1 text-[11.5px] text-text-subtle">
            Agents lease a Codex account when they run.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-1">
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-subtle">
              Accounts in the pool · {rows.length}
            </span>
            <span className="font-mono text-[10.5px] text-text-subtle">
              {selectReadyLabel(snapshot)}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {active ? <LeaseAccountRow account={active} /> : null}
            {rest.map(account => (
              <LeaseAccountRow key={account.id} account={account} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
