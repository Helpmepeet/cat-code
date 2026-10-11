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

import type { ReactNode } from 'react'
import type { SettingSourceId } from '../../shared/protocol.js'
import { SOURCE_LABEL } from './settingsFieldModel.js'

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
  resetLabel = 'Reset to default',
  note,
  settingKey,
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
  resetLabel?: string
  note?: ReactNode
  settingKey?: string
  children?: ReactNode
}) {
  return (
    <div
      className="flex min-h-[69px] scroll-mt-[30px] items-center justify-between gap-4 border-b border-shell-seam py-4 last:border-b-0 sm:gap-8"
      data-setting-key={settingKey}
      tabIndex={settingKey ? -1 : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium leading-[21px] text-text-primary">{label}</div>
        {desc ? (
          <div className="mt-0.5 max-w-[58ch] text-[13px] leading-5 text-text-subtle">
            {desc}
          </div>
        ) : null}
        {managed || source || note || (modified && !managed && editable && onReset) ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-[17px] text-text-subtle">
            {managed ? (
              <ManagedBadge origin={origin} />
            ) : source ? (
              <SourceBadge origin={origin} source={source} />
            ) : null}
            {note}
            {modified && !managed && editable && onReset ? (
              <button
                className="text-text-muted underline decoration-text-muted/50 underline-offset-[3px] transition-colors hover:text-text-primary"
                onClick={onReset}
                type="button"
              >
                {resetLabel}
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-tone-danger">
            <ErrorIcon />
            {error}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-[118px] max-w-[240px] shrink-0 flex-col items-end gap-1.5" data-setting-control>
        {children}
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
    <section className="mb-7">
      {title ? (
        <div className="mb-1 text-[13px] font-semibold text-text-primary">
          {title}
        </div>
      ) : null}
      <div>{children}</div>
    </section>
  )
}
