import {
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react'
import {
  formatResetLabel,
  statusDotTone,
  usageTone,
} from './accountsPageModel.js'
import { handleMenuRovingKeyDown, usePopover } from './composerPopover.js'
import { ContextGauge } from './ContextGauge.js'
import type { ContextUsage } from './contextUsage.js'
import { PermissionModeChip } from './PermissionModeChip.js'
import { toneClasses } from './tone.js'
import type {
  AccountStatus,
  PermissionContextSnapshot,
  PermissionSetModeMode,
  RunControlModelOption,
  RunControlsSnapshot,
} from '../../shared/protocol.js'

/**
 * P4-24 composer actions row — the desktop analog of the prototype's composer
 * `ChipStrip` (`Chat.jsx:1454` → `Surfaces.jsx:745`). The prototype's rail is
 * NOT the bordered-pill `Chip` (`Surfaces.jsx:40`); it is `ColumnChipFace`
 * (`Surfaces.jsx:222`) — a BORDERLESS, background-less face that shows only the
 * quiet colored value text (the label is the hover tooltip, and the `icon`/`dot`
 * props are destructured-but-never-rendered, `Surfaces.jsx:240-243`), separated
 * by faint `·` dots. Left→right: attach glyph · [model] · permission MODE · ——
 * · [active account] · context donut.
 *
 * REAL DATA ONLY (the prototype's chip values are mock fixtures — source wins):
 *  - MODEL renders the RESOLVED session model (`DiagnosticsSnapshot`
 *    `mainLoopModelForSession`, the sidecar's `getMainLoopModel()` — the same
 *    resolver the QueryEngine uses at request time). Absent only before the
 *    snapshot arrives; never a fabricated label.
 *  - REASONING renders the session's real effort tier (`reasoningEffort` ←
 *    `AppState.effortValue`, seeded from `getInitialEffortSetting()` in the
 *    sidecar). Absent when no explicit effort is set (running at the provider
 *    default) — not fabricated into a "High".
 *  - FAST ⚡ renders only when fast mode is actually ON (`fastMode` ←
 *    `AppState.fastMode`). It is a toggle that is off until explicitly enabled,
 *    so this READ-ONLY bar shows it when true; flipping it is a follow-up
 *    session (a new inbound verb, like the agent-mode toggle).
 *  - ACCOUNT renders the real active alias (`selectActiveAccount`,
 *    `accountsState.ts:88`) as the prototype's quiet grey face — ALWAYS
 *    `text-text-muted`, never health-tinted (the prototype's `AccountChip` face
 *    is unconditionally `#a1a1aa`; health lives in the title + the future
 *    switcher popover, P4-5). The renderer never invents a switcher here.
 *  - CONTEXT donut is ALWAYS shown (the prototype's `ContextChip` never hides,
 *    `Surfaces.jsx:471-473`): `selectContextUsage` returns real result-frame usage
 *    once a turn provides it, and a 0% / default-window gauge before then.
 *
 * The prototype's RECAP icon (Chat.jsx:1438) is intentionally omitted (user
 * decision, 2026-07-13) — only the attach glyph remains in the icon slot.
 *
 * Tailwind discipline: the account tone rides a STATIC class map (no interpolated
 * `text-[…]` — the v4 dynamic-class trap); the model's cyan echo is a STATIC
 * arbitrary class (`text-[#22d3ee]`, allowed — only interpolation no-ops).
 */

/**
 * Feature #4 — roving-tabindex props applied to one action-bar face (its trigger
 * button). Per the ARIA toolbar pattern, exactly one visible face is the toolbar's
 * single tab stop (`tabIndex 0`); the others are `-1` and reached with the arrow
 * keys (Left/Right/Home/End) or Tab/Shift+Tab. `data-composer-face` marks the
 * roving triggers so the toolbar keydown + {@link focusFirstComposerFace} can
 * enumerate them; `onFocus` keeps the tab stop on whichever face was focused last.
 */
export type ComposerFaceProps = {
  'data-composer-face': string
  tabIndex: number
  onFocus: () => void
}

/**
 * Feature #4 — focus the first enabled face of a composer action bar (pass its
 * `toolbarRef` node). This is the keyboard ENTRY POINT from the composer textarea:
 * `App.tsx`'s composer keydown calls it for Tab and for ArrowDown-when-empty to
 * move focus into the chip row. Skips disabled / `aria-disabled` faces (a disabled
 * attach or fast toggle is not a landing spot); returns whether a face actually
 * took focus so the caller only swallows the key when the move happened.
 */
// The prototype's `ColumnChipFace` face (Surfaces.jsx:228-244): quiet inline
// text, no border/background, 12.5px medium, ellipsised, brightening on hover.
const RAIL_FACE =
  'inline-flex max-w-[170px] shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-[5px] py-[3px] text-[12.5px] font-medium transition-colors'

/** The prototype's faint `·` divider (Surfaces.jsx:751 `Sep`, colour #3f3f46). */
function RailSep() {
  return (
    <span aria-hidden className="shrink-0 select-none text-[12px] text-white/20">
      ·
    </span>
  )
}

/**
 * Effort level → cat-code's own display label (`getEffortLevelLabel`,
 * `src/utils/effort.ts:275`): only `xhigh` is special-cased ("Extra high"); every
 * other level (low/medium/high/max/ultra) is Title-cased. Kept in sync with that
 * one function so the composer reads the same as `/effort`.
 */
function formatEffort(effort: string): string {
  if (effort === 'xhigh') return 'Extra high'
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/** The prototype's fast-mode ⚡ (Surfaces.jsx:694 `FastChip`) — the READ-ONLY face,
 * shown only when fast mode is on (the no-interactive-handler fallback). */
function FastFace() {
  return (
    <span
      className={`${RAIL_FACE} text-accent`}
      title="Fast mode on"
      aria-label="Fast mode on"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
      </svg>
    </span>
  )
}

/* --------------------------------------------------------------------------- *
 * P4-24c — INTERACTIVE run-control chips (the prototype's `RunChip` :99 /
 * `ReasoningChip` :137 / `FastChip` :694 popovers). Borderless faces driving the
 * REAL values + the real sidecar setters (via the app-owned `*.set` verbs). The
 * popover pattern (open state + outside-click/Escape dismiss, upward panel, in-panel
 * arrow roving) lives in `composerPopover.ts` (shared with `PermissionModeChip`).
 * Tailwind v4: only STATIC arbitrary classes.
 * --------------------------------------------------------------------------- */

const POPOVER_PANEL =
  'absolute bottom-full left-0 z-40 mb-2 rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-lg'
const POPOVER_HEADING =
  'px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle'
// The account/context cluster rides `ml-auto` at the rail's right edge, so its
// popovers anchor right (a `left-0` panel would overflow off-screen). Own padding
// per section (no panel-wide `p-1.5`), matching the prototype's sectioned popovers.
const POPOVER_PANEL_RIGHT =
  'absolute bottom-full right-0 z-40 mb-2 overflow-hidden rounded-lg border border-shell-seam bg-surface-raised shadow-lg'

/** Interactive MODEL face → a popover of the REAL selectable models (`model.set`). */
function ModelChip({
  current,
  selected,
  options,
  onSelect,
  faceProps,
}: {
  current: string | null
  selected: string | null
  options: RunControlModelOption[]
  onSelect: (value: string) => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? `Model: ${current}` : 'Select model'}
        onClick={() => setOpen(value => !value)}
        className={`${RAIL_FACE} text-[#22d3ee] hover:text-text-primary`}
      >
        {current ?? 'Model'}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Model"
          onKeyDown={handleMenuRovingKeyDown}
          className={`${POPOVER_PANEL} max-h-[320px] w-64 overflow-auto`}
        >
          <div className={POPOVER_HEADING}>Model</div>
          {options.map(option => {
            const active = selected === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(option.value)
                  close()
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 ${
                  active ? 'bg-white/[0.06]' : ''
                }`}
              >
                <span
                  className={`min-w-0 truncate text-xs ${active ? 'text-[#22d3ee]' : 'text-text-primary'}`}
                >
                  {option.label}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-subtle">
                  {option.provider === 'openai' ? 'OpenAI' : 'Anthropic'}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Interactive REASONING face → a popover of the model's valid effort levels + Auto (`effort.set`). */
function ReasoningChip({
  current,
  options,
  onSelect,
  faceProps,
}: {
  current: string | null
  options: string[]
  onSelect: (effort: string) => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  // 'Auto' clears the explicit tier (sends 'auto' → the engine's provider default).
  const items = [
    { value: 'auto', label: 'Auto' },
    ...options.map(level => ({ value: level, label: formatEffort(level) })),
  ]
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current ? `Reasoning effort: ${current}` : 'Reasoning effort: auto'}
        onClick={() => setOpen(value => !value)}
        className={`${RAIL_FACE} text-tone-warn hover:text-text-primary`}
      >
        {current ? formatEffort(current) : 'Auto'}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Reasoning effort"
          onKeyDown={handleMenuRovingKeyDown}
          className={`${POPOVER_PANEL} w-48`}
        >
          <div className={POPOVER_HEADING}>Reasoning effort</div>
          {items.map(item => {
            const active =
              item.value === 'auto' ? current === null : current === item.value
            return (
              <button
                key={item.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(item.value)
                  close()
                }}
                className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/5 ${
                  active ? 'bg-white/[0.06] text-tone-warn' : 'text-text-primary'
                }`}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Interactive FAST ⚡ toggle (`fast.set`) — gated on the engine's real support +
 * availability. Hidden when off AND the model can't run fast; disabled (with the
 * real unavailable reason) when supported but org/runtime-unavailable. */
function FastChip({
  active,
  supportedByModel,
  available,
  unavailableReason,
  onToggle,
  faceProps,
}: {
  active: boolean
  supportedByModel: boolean
  available: boolean
  unavailableReason: string | null
  onToggle: (active: boolean) => void
  faceProps?: ComposerFaceProps
}) {
  if (!active && !supportedByModel) return null
  const canEnable = supportedByModel && available
  const disabled = !active && !canEnable
  const title = active
    ? 'Fast mode on — click to turn off'
    : canEnable
      ? 'Enable fast mode'
      : (unavailableReason ?? 'Fast mode unavailable')
  return (
    <button
      {...faceProps}
      type="button"
      aria-pressed={active}
      aria-label={title}
      title={title}
      disabled={disabled}
      onClick={() => onToggle(!active)}
      className={`${RAIL_FACE} ${active ? 'text-accent' : 'text-text-subtle'} hover:text-text-primary disabled:opacity-40`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
      </svg>
    </button>
  )
}

/** One account's compact used-percent bar (5h or weekly) — the prototype's
 * `UsedMetric` (Surfaces.jsx:572), token-toned via the SAME `usageTone`/`toneClasses`
 * the Accounts page uses so the composer reads identically. Null usage → 0%. */
function AccountUsageBar({ pct }: { pct: number | null }) {
  const p = pct ?? 0
  const t = toneClasses(usageTone(pct))
  return (
    <span className="flex w-[72px] items-center gap-1.5">
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-shell-hover">
        {/* §0 EXCEPTION: data-driven percent width Tailwind can't express — the
            single allowed inline style (width only), mirroring AccountsPage's
            HeadroomBar (AccountsPage.tsx:213). */}
        <span
          className={`block h-full rounded-full ${t.dot}`}
          style={{ width: `${Math.max(2, Math.min(100, p))}%` }}
        />
      </span>
      <span
        className={`w-7 shrink-0 text-right text-[11px] font-semibold tabular-nums ${t.text}`}
      >
        {p}%
      </span>
    </span>
  )
}

/**
 * The account-switcher popover BODY (the prototype's `AccountChip` panel,
 * Surfaces.jsx:610). Exported + pure (open-state-free) so the row logic — active
 * marker, switchable-vs-capped, usage bars — is unit-testable without jsdom (the
 * open panel never reaches static markup otherwise; same reason
 * `selectShellDescriptors` is extracted). Clicking a switchable non-active row
 * calls `onSwitch(id)`; the
 * renderer only NAMES the id — the sidecar re-resolves it against the live pool (T6).
 */
export function AccountSwitcherPanel({
  active,
  pool,
  onSwitch,
  onManage,
}: {
  active: AccountStatus
  pool: AccountStatus[]
  onSwitch: (accountId: string) => void
  onManage?: () => void
}) {
  // ACCT-4: the authoritative readiness predicate (matches the sidecar's
  // readyCount, `app/sidecar/accountsDomain.ts:179-181`) — a healthy account
  // that has already hit its usage limit is not ready, even though its own
  // status is still 'healthy'.
  const ready = pool.filter(a => a.status === 'healthy' && !a.usageLimitReached).length
  return (
    <div
      role="menu"
      aria-label="Accounts"
      onKeyDown={handleMenuRovingKeyDown}
      className={`${POPOVER_PANEL_RIGHT} w-[336px]`}
    >
      <div className="flex items-center justify-between px-3.5 pb-2 pt-2.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-text-subtle">
          Accounts
        </span>
        <span className="text-[11px] tabular-nums text-text-subtle">
          <span className="text-tone-good">{ready}</span>/{pool.length} healthy
        </span>
      </div>
      <div className="flex items-center gap-3 px-3.5 pb-1.5">
        <span className="flex-1 text-[9px] font-bold uppercase tracking-[0.1em] text-text-subtle">
          Account
        </span>
        <span className="w-[72px] text-[9px] font-bold uppercase tracking-[0.1em] text-text-subtle">
          5h
        </span>
        <span className="w-[72px] text-[9px] font-bold uppercase tracking-[0.1em] text-text-subtle">
          Weekly
        </span>
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        {pool.map(acct => {
          const isActive = acct.id === active.id
          const unavailable = acct.status !== 'healthy'
          const clickable = !isActive && acct.switchable
          const rowAlias = acct.alias ?? '(unnamed)'
          return (
            <button
              key={acct.id}
              type="button"
              role="menuitem"
              // ACCT-6: a visible unavailable/active row stays focusable and
              // announced via aria-disabled — native `disabled` would drop it
              // from the tab order, hiding its state from keyboard users.
              aria-disabled={!clickable}
              onClick={clickable ? () => onSwitch(acct.id) : undefined}
              title={clickable ? `Switch to ${rowAlias}` : undefined}
              className={`flex w-full items-center gap-3 border-l-2 border-t border-t-shell-seam px-3.5 py-2 text-left transition-colors ${
                isActive ? 'border-l-accent bg-accent/[0.06]' : 'border-l-transparent'
              } ${clickable ? 'cursor-pointer hover:bg-white/[0.035]' : 'cursor-default'} ${
                unavailable && !isActive ? 'opacity-60' : ''
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className={`h-[7px] w-[7px] shrink-0 rounded-full ${toneClasses(statusDotTone(acct)).dot}`}
                  aria-hidden
                />
                <span
                  className={`truncate text-[12.5px] ${
                    isActive
                      ? 'font-semibold text-text-primary'
                      : 'font-medium text-text-muted'
                  }`}
                >
                  {rowAlias}
                </span>
              </span>
              {unavailable ? (
                // ACCT-1: the real per-status label (dead/quarantined never
                // read as "Capped") — only a genuinely capped row implies
                // reset timing.
                <span
                  className={`w-[152px] text-[11px] ${toneClasses(statusDotTone(acct)).text}`}
                >
                  {acct.availabilityLabel}
                  {acct.status === 'capped' ? (
                    <span className="text-text-subtle">
                      {' '}
                      · ↺ {formatResetLabel(acct.usageResetAt)}
                    </span>
                  ) : null}
                </span>
              ) : (
                <>
                  <AccountUsageBar pct={acct.usagePrimary} />
                  <AccountUsageBar pct={acct.usageWeekly} />
                </>
              )}
            </button>
          )
        })}
      </div>
      {onManage ? (
        <button
          type="button"
          role="menuitem"
          onClick={onManage}
          className="flex w-full items-center justify-center border-t border-shell-seam px-3.5 py-2.5 text-[11.5px] font-medium text-text-muted transition-colors hover:text-text-primary"
        >
          Manage accounts →
        </button>
      ) : null}
    </div>
  )
}

/** Interactive PROFILE face → the account-switcher popover (the prototype's
 * `AccountChip`, Surfaces.jsx:584). The quiet active-alias face opens
 * {@link AccountSwitcherPanel} over the REAL Codex pool. Falls back to the P4-24
 * read-only face when no switch handler is wired (mirrors the ModelChip
 * interactive-vs-face pattern). */
function AccountChip({
  active,
  accounts,
  onSwitch,
  onManage,
  faceProps,
}: {
  active: AccountStatus
  accounts: AccountStatus[]
  onSwitch: (accountId: string) => void
  onManage?: () => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  const pool = accounts.length > 0 ? accounts : [active]
  const alias = active.alias ?? '(unnamed)'
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Active account: ${alias} · ${active.status}`}
        onClick={() => setOpen(value => !value)}
        className={`${RAIL_FACE} gap-1.5 text-text-muted hover:text-text-primary`}
      >
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${toneClasses(statusDotTone(active)).dot}`}
          aria-hidden
        />
        {alias}
      </button>
      {open ? (
        <AccountSwitcherPanel
          active={active}
          pool={pool}
          onSwitch={accountId => {
            onSwitch(accountId)
            close()
          }}
          onManage={
            onManage
              ? () => {
                  onManage()
                  close()
                }
              : undefined
          }
        />
      ) : null}
    </div>
  )
}

/** Compact token count like the prototype's `fmt` (Surfaces.jsx:475): 42_000 → "42k". */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/** One plan-usage row (the prototype's `PlanUsageRow`, Surfaces.jsx:385): a label, a
 * tone-filled bar, then "{pct}% · resets {reset}". `reset` is the pool's single native
 * reset hint — the app carries ONE `usageResetAt`, not a separate weekly reset, so only
 * the row handed `reset` shows it (the weekly row omits it rather than fake a value). */
function PlanUsageRow({
  label,
  pct,
  reset,
}: {
  label: string
  pct: number | null
  reset: string | null
}) {
  const p = pct ?? 0
  const t = toneClasses(usageTone(pct))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[12px] font-semibold text-text-primary">{label}</div>
      <div className="h-1.5 overflow-hidden rounded-full bg-shell-hover">
        {/* §0 EXCEPTION: data-driven percent width (see AccountUsageBar). */}
        <div
          className={`h-full rounded-full ${t.dot}`}
          style={{ width: `${Math.min(100, p)}%` }}
        />
      </div>
      <div className="text-[11.5px] text-text-subtle">
        <span className={`font-semibold ${t.text}`}>{p}%</span>
        {reset ? ` · resets ${reset}` : ''}
      </div>
    </div>
  )
}

/** The context-donut popover BODY (the prototype's `ContextChip` popover,
 * Surfaces.jsx:497). Exported + pure (open-state-free) for headless coverage, like
 * {@link AccountSwitcherPanel}. Shows the active account's 5h/weekly PLAN USAGE (when a
 * pool snapshot is present) + the real Context total, all from data already on the wire.
 *
 * DEFERRED (agreed 2026-07-14; ledger P4-0): the per-category context BREAKDOWN — the
 * prototype's stacked `contextBreakdown` bar (Surfaces.jsx:517) — needs an
 * `analyzeContextUsage` outbound frame that `contextUsage.ts` does not carry yet. Until
 * then this shows the aggregate Context row only, never a fabricated breakdown. */
export function ContextUsagePanel({
  usage,
  account,
}: {
  usage: ContextUsage
  account: AccountStatus | null
}) {
  const { percentUsed, usedTokens, contextWindow } = usage
  const t = toneClasses(usageTone(percentUsed))
  const showPlan =
    account != null &&
    (account.usagePrimary != null || account.usageWeekly != null)
  return (
    // ACCT-3: informational content only (no menu items) — `role="menu"`
    // asserted an arrow-navigable contract this panel never fulfilled.
    <div role="dialog" aria-label="Usage" className={`${POPOVER_PANEL_RIGHT} w-[268px]`}>
      {showPlan && account ? (
        <>
          <div className="px-3.5 pb-1 pt-3 text-[9.5px] font-bold uppercase tracking-[0.13em] text-text-subtle">
            Plan usage
          </div>
          <div className="flex flex-col gap-3.5 px-3.5 pb-3.5 pt-2">
            <PlanUsageRow
              label="5-hour limit"
              pct={account.usagePrimary}
              reset={formatResetLabel(account.usageResetAt)}
            />
            <PlanUsageRow
              label="Weekly · all models"
              pct={account.usageWeekly}
              reset={null}
            />
          </div>
        </>
      ) : null}
      <div
        className={`px-3.5 pb-3.5 ${showPlan ? 'border-t border-shell-seam pt-3' : 'pt-3'}`}
      >
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] text-text-subtle">Context</span>
          <span className="text-[11.5px] tabular-nums text-text-muted">
            <span className={`font-semibold ${t.text}`}>{percentUsed}%</span> ·{' '}
            {fmtTokens(usedTokens)} / {fmtTokens(contextWindow)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** The context-window donut face → its usage popover (the prototype's `ContextChip`,
 * Surfaces.jsx:467). The donut ({@link ContextGauge}) becomes a menu button opening
 * {@link ContextUsagePanel}. Read-only info → no handler, always interactive when a
 * real ContextUsage is present. (Deferred: `/context` auto-opening it — needs a
 * command→openSignal wire, ledger P4-0.) */
function ContextChip({
  usage,
  account,
  faceProps,
}: {
  usage: ContextUsage
  account: AccountStatus | null
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, ref, triggerRef } = usePopover()
  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context ${usage.percentUsed}% used — open usage`}
        onClick={() => setOpen(value => !value)}
        className="flex shrink-0 items-center rounded-md"
      >
        <ContextGauge usage={usage} />
      </button>
      {open ? <ContextUsagePanel usage={usage} account={account} /> : null}
    </div>
  )
}

export function ComposerActionsBar({
  attachDisabled,
  onAttach,
  model,
  reasoningEffort,
  fastMode,
  runControls,
  onSetModel,
  onSetEffort,
  onSetFast,
  permissionContext,
  onSetMode,
  account,
  accounts,
  onSwitchAccount,
  onManageAccounts,
  contextUsage,
  toolbarRef,
  onFocusComposer,
}: {
  attachDisabled: boolean
  onAttach: () => void
  /** The RESOLVED model this session runs; null before the snapshot → face omitted. */
  model: string | null
  /** The session's reasoning-effort tier; null when running at the provider default → face omitted. */
  reasoningEffort: string | null
  /** Fast-mode toggle — the ⚡ face renders when on OR togglable (P4-24c interactive). */
  fastMode: boolean
  /**
   * P4-24c — the LIVE run-controls snapshot (current + real picker options +
   * availability). When present WITH the matching `onSet*` handler, a face becomes
   * an interactive picker; absent, it falls back to the P4-24 read-only face.
   */
  runControls?: RunControlsSnapshot | null
  onSetModel?: (model: string) => void
  onSetEffort?: (effort: string) => void
  onSetFast?: (active: boolean) => void
  permissionContext: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
  /** The Codex pool's active account (real alias), or null before the snapshot arrives. */
  account: AccountStatus | null
  /** The full Codex pool (`accountsState.selectAccountRows`) for the switcher popover;
   * empty before the snapshot. With `onSwitchAccount` present, the account face becomes
   * the interactive switcher; absent, it falls back to the P4-24 read-only face. */
  accounts?: AccountStatus[]
  /** Switch the active session to `accountId` (the engine's `account.switch` verb). */
  onSwitchAccount?: (accountId: string) => void
  /** Open the full Accounts page (the popover's "Manage accounts →"). */
  onManageAccounts?: () => void
  /** Real context-window fullness, or null before the first result frame. */
  contextUsage: ContextUsage | null
  /** Feature #4 — the toolbar's DOM node, so the composer keydown (App.tsx) can
   * move focus into the first face via {@link focusFirstComposerFace}. */
  toolbarRef?: Ref<HTMLDivElement>
  /** Feature #4 — return focus to the composer textarea (Escape, or Shift+Tab off
   * the first face). Owned by App.tsx, which holds the textarea ref. */
  onFocusComposer?: () => void
}) {
  // Interactive when the live snapshot AND the setter handler are both present;
  // otherwise the P4-24 read-only faces render unchanged.
  const modelInteractive =
    runControls != null && onSetModel != null && runControls.model.options.length > 0
  const effortInteractive =
    runControls != null && onSetEffort != null && runControls.effort.supported
  const fastInteractive = runControls != null && onSetFast != null
  const accountAlias = account?.alias ?? null
  const showAccount = account != null && accountAlias != null
  // Interactive switcher when the active account AND a switch handler are both
  // present; otherwise the P4-24 read-only alias face (mirrors the ModelChip gate).
  const accountInteractive = account != null && onSwitchAccount != null

  // Feature #4 — roving tabindex across the faces (ARIA toolbar). The tab stop
  // follows the last-focused face; when nothing in the bar is focused it rests on
  // the first face ('attach', always rendered), so Tab from the textarea has a
  // deterministic landing spot. Faces read their tabIndex from `faceProps(id)`.
  const [activeFace, setActiveFace] = useState<string | null>(null)
  const faceProps = (id: string): ComposerFaceProps => ({
    'data-composer-face': id,
    tabIndex: id === (activeFace ?? 'attach') ? 0 : -1,
    onFocus: () => setActiveFace(id),
  })
  const exitToComposer = () => onFocusComposer?.()

  // Roving navigation among the faces. Runs at the toolbar level, so it also fires
  // for keydowns bubbling out of an open popover — those are guarded out and left to
  // the popover's own machinery (usePopover: first-item focus + Escape-to-close;
  // handleMenuRovingKeyDown: in-panel ArrowUp/Down/Home/End roving, Feature #13).
  const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('[role="menu"], [role="dialog"]')) return
    const current = target.closest<HTMLElement>('[data-composer-face]')
    if (!current) return
    const faces = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[data-composer-face]'),
    ).filter(
      el =>
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-disabled') !== 'true',
    )
    const index = faces.indexOf(current)
    if (index === -1) return
    const move = (to: number) => {
      const el = faces[to]
      if (!el) return
      el.focus()
      setActiveFace(el.getAttribute('data-composer-face'))
    }
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        move((index + 1) % faces.length)
        return
      case 'ArrowLeft':
        event.preventDefault()
        move((index - 1 + faces.length) % faces.length)
        return
      case 'Home':
        event.preventDefault()
        move(0)
        return
      case 'End':
        event.preventDefault()
        move(faces.length - 1)
        return
      case 'Tab':
        // Tab/Shift+Tab also walk the faces (the operator's request). Shift+Tab off
        // the first face returns to the textarea; Tab off the last face falls
        // through to the browser so focus can leave the bar forward.
        if (event.shiftKey) {
          event.preventDefault()
          if (index === 0) exitToComposer()
          else move(index - 1)
        } else if (index < faces.length - 1) {
          event.preventDefault()
          move(index + 1)
        }
        return
      case 'ArrowDown':
        // Enter/Space already open a popover via the button's native click;
        // ArrowDown matches by activating the trigger, reusing usePopover's open +
        // first-item focus. Faces without a popover (no aria-haspopup) ignore it.
        if (current.getAttribute('aria-haspopup')) {
          event.preventDefault()
          current.click()
        }
        return
      case 'Escape':
        event.preventDefault()
        exitToComposer()
        return
      default:
    }
  }

  // Focus left the whole bar (its popovers live inside, so this excludes those) →
  // drop the tab stop back to the first face for a predictable next Tab entry.
  const onToolbarBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setActiveFace(null)
    }
  }

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Composer actions"
      aria-orientation="horizontal"
      onKeyDown={onToolbarKeyDown}
      onBlur={onToolbarBlur}
      className="mt-3 flex items-center gap-4 px-1"
    >
      {/* Attach (§10 ❓, Chat.jsx:1435): quiet #3f3f46 glyph brightening to
       * #a1a1aa on hover — a real file picker needs an engine attachment
       * capability that is NOT on the wire; the working attach path today is a
       * large paste, which the toast + title spell out. */}
      <button
        {...faceProps('attach')}
        aria-label="Add attachment"
        title="Add attachment — paste a large block to attach it as a collapsed chip"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-[#3f3f46] transition-colors hover:text-text-muted disabled:opacity-50"
        disabled={attachDisabled}
        onClick={onAttach}
        type="button"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {/* The columnar rail (Surfaces.jsx:756): left cluster [model ·] MODE, then
       * an auto margin pushes account · context to the right edge. Faces are
       * borderless quiet text — the composer's minimal grammar, not pills. */}
      <div className="flex min-w-0 flex-1 items-center gap-[7px]">
        {modelInteractive && runControls && onSetModel ? (
          <>
            <ModelChip
              current={runControls.model.current ?? model}
              selected={runControls.model.selected}
              options={runControls.model.options}
              onSelect={onSetModel}
              faceProps={faceProps('model')}
            />
            <RailSep />
          </>
        ) : model ? (
          <>
            <span
              className={`${RAIL_FACE} text-[#22d3ee]`}
              title={`Model: ${model}`}
            >
              {model}
            </span>
            <RailSep />
          </>
        ) : null}
        {effortInteractive && runControls && onSetEffort ? (
          <>
            <ReasoningChip
              current={runControls.effort.current ?? reasoningEffort}
              options={runControls.effort.options}
              onSelect={onSetEffort}
              faceProps={faceProps('effort')}
            />
            <RailSep />
          </>
        ) : reasoningEffort ? (
          <>
            <span
              className={`${RAIL_FACE} text-tone-warn`}
              title={`Reasoning effort: ${reasoningEffort}`}
            >
              {formatEffort(reasoningEffort)}
            </span>
            <RailSep />
          </>
        ) : null}
        <PermissionModeChip
          context={permissionContext}
          onSetMode={onSetMode}
          faceProps={faceProps('mode')}
        />
        {fastInteractive && runControls && onSetFast ? (
          <FastChip
            active={runControls.fast.active}
            supportedByModel={runControls.fast.supportedByModel}
            available={runControls.fast.available}
            unavailableReason={runControls.fast.unavailableReason}
            onToggle={onSetFast}
            faceProps={faceProps('fast')}
          />
        ) : fastMode ? (
          <FastFace />
        ) : null}

        <div className="ml-auto flex min-w-0 items-center gap-[7px]">
          {accountInteractive && account && onSwitchAccount ? (
            <AccountChip
              active={account}
              accounts={accounts ?? []}
              onSwitch={onSwitchAccount}
              onManage={onManageAccounts}
              faceProps={faceProps('account')}
            />
          ) : showAccount ? (
            <span
              className={`${RAIL_FACE} text-text-muted`}
              title={`Active account: ${accountAlias} · ${account.status}`}
            >
              {accountAlias}
            </span>
          ) : null}
          {(accountInteractive || showAccount) && contextUsage ? <RailSep /> : null}
          {contextUsage ? (
            <ContextChip
              usage={contextUsage}
              account={account}
              faceProps={faceProps('context')}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
