/**
 * Settings field primitives (P4-3) — the source-badge system every setting row
 * reuses, rebuilt in TS/Tailwind from the prototype's `Settings.jsx`
 * (`SourceBadge` / `ManagedBadge` / `Field` / `PaneSection`). Over the REAL
 * settings model: a value's SOURCE is one of the five engine layers
 * (`SettingSourceId`), and it is editable, flag-overridden, or policy-managed.
 *
 * These are pure presentation — a panel (P4-12) supplies the control (`children`)
 * and the resolved source/managed/editable status from `settingsState.ts`
 * selectors. No engine reads, no inline `style` (per-source hues are the
 * `--color-source-*` tokens in `theme.css`).
 */

import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { SettingSourceId } from '../../shared/protocol.js'
import { SETTING_SOURCE_PRECEDENCE } from './settingsState.js'

/** Display label per source — mirrors `getSourceDisplayName` (constants.ts:46). */
const SOURCE_LABEL: Record<SettingSourceId, string> = {
  userSettings: 'User',
  projectSettings: 'Project',
  localSettings: 'Local',
  flagSettings: 'Flag',
  policySettings: 'Managed',
}

/**
 * Badge text/background/border classes per source, on the `--color-source-*`
 * tokens. Static strings (not interpolated) so Tailwind's scanner keeps them.
 */
const SOURCE_BADGE_CLASS: Record<SettingSourceId, string> = {
  userSettings: 'text-source-user bg-source-user/10 border-source-user/25',
  projectSettings:
    'text-source-project bg-source-project/10 border-source-project/25',
  localSettings: 'text-source-local bg-source-local/10 border-source-local/25',
  flagSettings: 'text-source-flag bg-source-flag/10 border-source-flag/25',
  policySettings:
    'text-source-policy bg-source-policy/10 border-source-policy/25',
}

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]'

export function LockIcon({ className = 'h-2.5 w-2.5' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.4"
      viewBox="0 0 24 24"
    >
      <rect height="11" rx="2" width="18" x="3" y="11" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[11px] w-[11px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.4"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  )
}

/**
 * The provenance badge: where a value is resolved from. Pass a real
 * `source` (the engine layer). `meta` is the prototype's escape hatch for a
 * caller with its OWN source taxonomy (e.g. AgentsPage, P4-7) — supply a
 * resolved `{ label, className, origin }` directly.
 */
export function SourceBadge({
  source,
  origin,
  meta,
}: {
  source?: SettingSourceId
  origin?: string | null
  meta?: { label: string; className: string; origin?: string }
}) {
  if (meta) {
    return (
      <span
        className={`${BADGE_BASE} ${meta.className}`}
        title={meta.origin ?? origin ?? undefined}
      >
        {meta.label}
      </span>
    )
  }
  // Honest provenance: with neither a real source nor an explicit meta, render
  // nothing rather than fabricate a "User" badge (a value with no resolved
  // source is at its built-in default — review LOW#3).
  if (!source) {
    return null
  }
  return (
    <span
      className={`${BADGE_BASE} ${SOURCE_BADGE_CLASS[source]}`}
      title={origin ?? undefined}
    >
      {SOURCE_LABEL[source]}
    </span>
  )
}

/** Marks a value locked by organization policy (read-only). */
export function ManagedBadge({ origin }: { origin?: string | null }) {
  return (
    <span
      className={`${BADGE_BASE} ${SOURCE_BADGE_CLASS.policySettings}`}
      title={origin ?? 'Managed by organization policy (read-only)'}
    >
      <LockIcon className="h-[9px] w-[9px]" />
      Managed
    </span>
  )
}

/**
 * A labeled, source-badged setting row — the primitive panels reuse. The panel
 * supplies the control as `children` plus the resolved status: `managed` shows
 * the lock badge, otherwise `source` shows the provenance badge; `editable`
 * (default true) gates the reset affordance for a flag-overridden value.
 */
export function Field({
  label,
  desc,
  source,
  managed = false,
  editable = true,
  modified = false,
  error,
  origin,
  onReset,
  children,
}: {
  label: string
  desc?: string
  source?: SettingSourceId
  managed?: boolean
  editable?: boolean
  modified?: boolean
  error?: string | null
  origin?: string | null
  onReset?: () => void
  children?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-[18px] border-b border-shell-seam py-[13px]">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-text-primary">
            {label}
          </span>
          {managed ? (
            <ManagedBadge origin={origin} />
          ) : source ? (
            <SourceBadge origin={origin} source={source} />
          ) : null}
        </div>
        {desc ? (
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-text-subtle">
            {desc}
          </div>
        ) : null}
        {error ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-tone-danger">
            <ErrorIcon />
            {error}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {children}
        {modified && !managed && editable && onReset ? (
          <button
            className="text-[11px] text-text-subtle transition-colors hover:text-text-muted"
            onClick={onReset}
            type="button"
          >
            Reset to default
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** A titled subsection within a settings pane. */
export function PaneSection({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <section className="mb-6">
      {title ? (
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-subtle">
          {title}
        </div>
      ) : null}
      <div>{children}</div>
    </section>
  )
}

/**
 * The "Resolution order" legend (Settings.jsx): the five sources in display
 * precedence (highest wins), each as a `SourceBadge`. Reads the real precedence
 * order — no fixture.
 */
export function ResolutionOrderLegend() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-shell-seam bg-shell-hover px-3 py-2 text-[11.5px] text-text-subtle">
      <span className="text-text-muted">Resolution order:</span>
      {SETTING_SOURCE_PRECEDENCE.map((source, index) => (
        <Fragment key={source}>
          {index > 0 ? <span className="text-text-subtle">▸</span> : null}
          <SourceBadge source={source} />
        </Fragment>
      ))}
      <span className="ml-1">highest wins</span>
    </div>
  )
}
