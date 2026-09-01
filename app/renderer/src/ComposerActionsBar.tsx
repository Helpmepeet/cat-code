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
import { toggleAccountChip } from './composerAccountChip.js'
import { handleMenuRovingKeyDown, usePopover } from './composerPopover.js'
import { ContextGauge } from './ContextGauge.js'
import {
  pressureTone,
  selectContextPercent,
  type ContextUsage,
} from './contextUsage.js'
import {
  selectBreakdownRows,
  selectDonutView,
  selectFreeTokens,
  selectPanelUsage,
  type DonutView,
} from './contextBreakdownState.js'
import { PermissionModeChip } from './PermissionModeChip.js'
import { toneClasses } from './tone.js'
import { selectTokenWarning, type TokenWarning } from './tokenWarning.js'
import type {
  AccountStatus,
  AnthropicAccountStatus,
  PermissionContextSnapshot,
  PermissionSetModeMode,
  RunControlModelOption,
  RunControlProvider,
  RunControlsSnapshot,
  ContextBreakdownSnapshot,
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
 *  - MODEL renders the RESOLVED session model (`RunControlsSnapshot.model.current`,
 *    the sidecar's `getMainLoopModel()` — the same resolver the QueryEngine uses
 *    at request time), under the engine's own display name for it
 *    (`.currentLabel`, from `getMarketingNameForModel`) so the face reads as the
 *    picker row does. It comes off the LIVE run-controls seam, re-broadcast on
 *    every model change, not the spawn-frozen `DiagnosticsSnapshot`. Absent only
 *    before the snapshot arrives; never a fabricated label.
 *  - REASONING renders the session's real effort tier (`reasoningEffort` ←
 *    `AppState.effortValue`, seeded from `getInitialEffortSetting()` in the
 *    sidecar). Absent when no explicit effort is set (running at the provider
 *    default) — not fabricated into a "High".
 *  - FAST ⚡ renders whenever the state is KNOWN and the model supports it, on
 *    or off (`fastMode` ← `AppState.fastMode`), matching the interactive chip.
 *    Absent means only that nothing has reported it.
 *  - ACCOUNT renders the real active alias (`selectActiveAccount`,
 *    `accountsState.ts:88`) as the prototype's quiet grey face — the TEXT is
 *    ALWAYS `text-text-muted`, never health-tinted (the prototype's `AccountChip`
 *    face is unconditionally `#a1a1aa`). Health rides the status dot beside it
 *    and the title; both read-only and interactive faces carry the dot, so a
 *    pane with no engine does not silently lose the signal.
 *  - CONTEXT donut is ALWAYS shown (the prototype's `ContextChip` never hides,
 *    `Surfaces.jsx:471-473`): `selectContextUsage` returns real result-frame usage
 *    once a turn provides it. Before a window is known the ring still draws, at
 *    rest and without a percentage, rather than dividing by the default constant.
 *
 * The prototype's RECAP icon (Chat.jsx:1438) is intentionally omitted (user
 * decision, 2026-07-13) — only the attach glyph remains in the icon slot.
 *
 * Tailwind discipline: the account tone rides a STATIC class map (no interpolated
 * `text-[…]` — the v4 dynamic-class trap); the model's cyan echo is a STATIC
 * arbitrary class (`text-[light-dark(#0e7490,#22d3ee)]`, allowed — only interpolation no-ops).
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
 * `toolbarRef` node). This is the keyboard ENTRY POINT from the composer field:
 * `App.tsx`'s composer keydown calls it for Tab and for ArrowDown-when-empty to
 * move focus into the chip row. Skips disabled / `aria-disabled` faces (a disabled
 * attach or fast toggle is not a landing spot); returns whether a face actually
 * took focus so the caller only swallows the key when the move happened.
 */
// The prototype's `ColumnChipFace` face (Surfaces.jsx:228-244): quiet inline
// text, no border/background, 12.5px medium, ellipsised, brightening on hover.
const RAIL_FACE =
  'inline-flex max-w-[170px] shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-[5px] py-[3px] text-[12.5px] font-medium transition-colors'
const FAST_FACE =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] p-0 transition-colors'

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

/**
 * The prototype's fast-mode ⚡ (Surfaces.jsx:694 `FastChip`) — the READ-ONLY face,
 * for a pane with no engine to toggle it.
 *
 * Renders for a KNOWN state, on or off, matching the live chip's two looks. It
 * used to render only when fast was ON, which was right while the only caller
 * was a preview (a cache says nothing about fast, so "not on" and "unknown" were
 * the same thing) and wrong the moment a detached live session could answer:
 * parking a session with fast off made the face vanish, while every other face
 * stayed. Absent now means only that nothing knows.
 */
function FastFace({ active }: { active: boolean }) {
  const label = active ? 'Fast mode on' : 'Fast mode off'
  return (
    <span
      className={`${FAST_FACE} border ${active ? 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn' : 'border-transparent text-text-ghost'}`}
      title={label}
      aria-label={label}
    >
      <FastGlyph active={active} />
    </span>
  )
}

function FastGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={active ? 'currentColor' : 'none'}
      stroke={active ? 'none' : 'currentColor'}
      strokeWidth={active ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
    </svg>
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

/**
 * The escalated usage footer's tint, at rest and on hover. `ToneClasses.hoverTint`
 * is the hover form of `softBg` at the SAME strength, which would leave this strip
 * with no visible hover step at all, so both strengths are written out here —
 * literal, per the tone kit's own Tailwind-JIT rule. Only the two tones above
 * `accent` on the pressure ladder can reach it.
 */
const ESCALATED_ACTION_TINT: Record<'warn' | 'danger', string> = {
  warn: 'bg-tone-warn/10 hover:bg-tone-warn/[0.18]',
  danger: 'bg-tone-danger/10 hover:bg-tone-danger/[0.18]',
}

/**
 * A Claude account reports only healthy/dead, with no `availabilityLabel` of its
 * own; these are the same words the Codex pool's label uses for the same two
 * states (`describeCodexAccountAvailability`, `codexAccountPool.ts:1526-1531`),
 * so the two account faces read alike.
 */
const ANTHROPIC_STATUS_LABEL: Record<AnthropicAccountStatus['status'], string> = {
  healthy: 'Ready',
  dead: 'Needs re-login',
}

/**
 * Interactive MODEL face → a popover of the REAL selectable models (`model.set`).
 *
 * The face reads the engine's display NAME for the resolved model (`label`), not
 * the model id (`current`): picking "Haiku 4.5" used to leave the face reading
 * `claude-haiku-4-5-20251001`, because `current` is what the engine resolves the
 * selection to. `current` is still the fallback, so a model the engine has no
 * name for shows its id rather than nothing.
 */
function ModelChip({
  current,
  label,
  selected,
  provider,
  providerSwitchLocked,
  options,
  onSelect,
  faceProps,
}: {
  current: string | null
  label: string | null
  selected: string | null
  provider: RunControlProvider
  providerSwitchLocked: boolean
  options: RunControlModelOption[]
  onSelect: (value: string | null) => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  const face = label ?? current
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={face ? `Model: ${face}` : 'Select model'}
        onClick={() => setOpen(value => !value)}
        className={`${RAIL_FACE} text-[light-dark(#0e7490,#22d3ee)] hover:text-text-primary`}
      >
        {face ?? 'Model'}
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
            const crossProvider =
              (provider === 'openai') !== (option.provider === 'openai')
            const disabled = providerSwitchLocked && crossProvider
            return (
              <button
                key={option.value ?? '__provider_default__'}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                aria-disabled={disabled}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return
                  onSelect(option.value)
                  close()
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 ${
                  active ? 'bg-white/[0.06]' : ''
                }`}
              >
                <span
                  className={`min-w-0 truncate text-xs ${active ? 'text-[light-dark(#0e7490,#22d3ee)]' : 'text-text-primary'}`}
                >
                  {option.label}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-text-subtle">
                  {formatProvider(option.provider)}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function formatProvider(provider: RunControlProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    case 'bedrock':
      return 'AWS'
    case 'vertex':
      return 'Vertex'
    case 'foundry':
      return 'Foundry'
  }
}

/** Interactive REASONING face → a popover of the model's valid effort levels + Auto (`effort.set`). */
function ReasoningChip({
  current,
  selected,
  options,
  onSelect,
  faceProps,
}: {
  current: string | null
  selected: string | null
  options: string[]
  onSelect: (effort: string) => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  // 'Auto' clears the explicit tier (sends 'auto' → the engine's provider default).
  // The face shows the effective tier, while the checkmark reflects the raw
  // selection so an env/default override never lies about what the API receives.
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
        title={
          current
            ? `Reasoning effort: ${current}${selected === null ? ' (auto)' : ''}`
            : 'Reasoning effort: auto'
        }
        onClick={() => setOpen(value => !value)}
        className={`${RAIL_FACE} text-tone-warn hover:text-text-primary`}
      >
        {current
          ? `${formatEffort(current)}${selected === null ? ' (Auto)' : ''}`
          : 'Auto'}
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
              item.value === 'auto'
                ? selected === null
                : selected === item.value
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
 * availability. Hidden whenever the model can't run fast; disabled (with the
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
  if (!supportedByModel) return null
  const canEnable = available
  const disabled = !active && !canEnable
  const title = active
    ? 'Fast mode on, click to turn off'
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
      className={`${FAST_FACE} border ${active ? 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn hover:bg-tone-warn/15 hover:text-[light-dark(#834a00,#fde68a)]' : 'border-transparent text-text-ghost hover:text-text-subtle'} disabled:opacity-40`}
    >
      <FastGlyph active={active} />
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
  onOpen,
  faceProps,
}: {
  active: AccountStatus
  accounts: AccountStatus[]
  onSwitch: (accountId: string) => void
  onManage?: () => void
  onOpen?: () => void
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
        title={`Active account: ${alias} · ${active.availabilityLabel}`}
        onClick={() => setOpen(toggleAccountChip(open, onOpen))}
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

/** Compact token count: 42_000 → "42k", 1_000_000 → "1M".
 *
 * The millions tier DEVIATES from the prototype's `fmt` (Surfaces.jsx:475), which has a
 * `k` tier only and so renders a 1M window as "1000k". The prototype predates
 * million-token context windows; a Claude 5 session opens on one. Do not "restore
 * parity" by deleting the `M` branch. Below 1_000_000 this is byte-for-byte the
 * prototype's behavior, which is why the k branch is untouched. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/**
 * The context-breakdown donut (replaces the old stacked bar, operator call
 * 2026-08-05): one ring segment per category, sized by its share of the
 * window, over a faint full-circle track for the unused remainder — the same
 * data {@link selectBreakdownRows} already computed for the bar/legend, drawn
 * as arcs instead of stacked rectangles. Geometry mirrors {@link ContextGauge}
 * (12 o'clock start via `-rotate-90`, `arcLength CIRCUMFERENCE` dash form).
 *
 * `colorHex` rides a plain SVG `stroke` attribute, not a class, so it is
 * exempt from the Tailwind v4 dynamic-class trap the `swatch` classes must
 * dodge (`contextBreakdownState.ts`).
 *
 * Every number this paints — dash, offset, stroke width, opacity, the center
 * readout — comes from `selectDonutView`, so the hover behaviour is testable in
 * a suite with no DOM. All this component owns is the two pointer wires.
 *
 * The center reads two different questions depending on hover state: at rest
 * it is `percentUsed`, the panel's own overall figure (share of the full
 * window); hovering a category swaps it to that category's share of the
 * ACCOUNTED total (`view.centerPercent`, share of what is actually used, not
 * of window capacity) — the arcs underneath never change basis, only the
 * number printed in the middle does.
 */
function ContextBreakdownDonut({
  view,
  percentUsed,
  tone,
  onHover,
}: {
  view: DonutView
  percentUsed: number
  tone: string
  onHover: (index: number | null) => void
}) {
  const radius = 30
  return (
    <div className="relative mx-auto my-1 h-[76px] w-[76px] shrink-0">
      <svg width="76" height="76" viewBox="0 0 76 76" className="-rotate-90" aria-hidden>
        <circle
          cx="38"
          cy="38"
          r={radius}
          fill="none"
          stroke="light-dark(rgba(9,9,11,0.1), rgba(255,255,255,0.06))"
          strokeWidth="6"
        />
        {view.segments.map((segment, index) => (
          // §0 EXCEPTION: data-driven arc geometry and emphasis, the same class
          // of computed SVG presentation attribute `ContextGauge`'s own arc
          // already uses. The values come from `selectDonutView`, not from here.
          <circle
            key={segment.label}
            cx="38"
            cy="38"
            r={radius}
            fill="none"
            stroke={segment.colorHex}
            strokeWidth={segment.strokeWidth}
            strokeLinecap="butt"
            strokeDasharray={`${segment.dash} ${view.circumference}`}
            strokeDashoffset={segment.offset}
            opacity={segment.opacity}
            // The arc is a stroked circle with no fill, so the default hit area
            // is the whole 76px disc and every segment would answer for the
            // pointer. `stroke` narrows the target to the drawn band itself.
            className="[pointer-events:stroke] transition-[opacity,stroke-width] duration-100"
            onMouseEnter={() => onHover(index)}
            onMouseLeave={() => onHover(null)}
          >
            <title>{`${segment.label}, ${segment.tokens.toLocaleString()} tokens`}</title>
          </circle>
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className={`text-[16px] font-semibold tabular-nums ${view.centerClass ?? tone}`}
        >
          {view.centerPercent == null
            ? `${percentUsed}%`
            : `${Math.round(view.centerPercent)}%`}
        </span>
      </div>
    </div>
  )
}

/** The context-donut popover BODY (the prototype's `ContextChip` popover,
 * Surfaces.jsx:497). Exported + pure (open-state-free) for headless coverage, like
 * {@link AccountSwitcherPanel}. Shows the real Context total, from data already on
 * the wire — plan/quota usage is deliberately NOT here (operator call, 2026-08-05:
 * it is visible elsewhere and this popover is about the context WINDOW, not the
 * account's rate limits).
 *
 * The per-category BREAKDOWN below the aggregate row (the prototype's stacked bar +
 * legend + Free, Surfaces.jsx:517-537, now drawn as {@link ContextBreakdownDonut}) is
 * the `context-breakdown.snapshot` seam, carrying the engine's OWN
 * `analyzeContextUsage` output. It arrives only after this popover is opened, so a
 * session with nothing to analyse yet renders the aggregate row alone — absent,
 * never fabricated.
 *
 * The header row reads {@link selectPanelUsage}, NOT `usage` directly, once a
 * breakdown is present: `usage` is the composer's own live, per-message number,
 * while the rows below are a coarse snapshot recomputed only on open. The
 * two are different pipelines on different cadences, so printing them together
 * could show a header total the rows didn't sum to. `selectPanelUsage` sums the
 * SAME rows the legend prints instead, so the header always reconciles with what
 * is on screen below it. */
export function ContextUsagePanel({
  usage,
  breakdown = null,
  onCompact,
}: {
  usage: ContextUsage
  /** Per-category occupancy, absent until the sidecar has produced one. */
  breakdown?: ContextBreakdownSnapshot | null
  /**
   * Submits `/compact` for this session. Absent (and the row unrendered) when no
   * engine can take it: a preview pane, or a spawning, parked, or terminal
   * session (`canSendUntypedSubmit`; `parked` is deliberately non-terminal yet
   * has no process, so it is excluded too). It does NOT route through the
   * composer draft — see the handler in `App.tsx` for why.
   */
  onCompact?: () => void
}) {
  const panelUsage = selectPanelUsage(usage, breakdown)
  const { percentUsed, usedTokens, contextWindow } = panelUsage
  // Null while nothing has reported the window, exactly as on the donut face.
  // A breakdown carries its own real window, so this is only ever null in the
  // aggregate-row-only state, where the row prints the token total alone.
  const percent = selectContextPercent(panelUsage)
  // Context fullness, NOT account quota — the same ladder the donut face reads.
  const tone = pressureTone(percent ?? 0)
  const t = toneClasses(tone)
  // Past the pressure threshold the panel's action escalates. The threshold is
  // `pressureTone`'s OWN ladder (warn at 70, danger at 90), deliberately not a
  // new number of this footer's own: the popover paints every percentage on that
  // one ladder, so a footer escalating on a separate threshold could shout under
  // a percent still coloured calm.
  const escalated = tone === 'warn' || tone === 'danger' ? tone : null
  const rows = selectBreakdownRows(breakdown)
  const freeTokens = selectFreeTokens(breakdown)
  // ONE hover target for the ring and the legend together, which is why it is
  // held here rather than inside the donut: a legend row and its arc are the
  // same category, so they must emphasise as one.
  const [hovered, setHovered] = useState<number | null>(null)
  const view = selectDonutView(rows, hovered)
  return (
    // ACCT-3: informational content only (no menu items) — `role="menu"`
    // asserted an arrow-navigable contract this panel never fulfilled.
    <div role="dialog" aria-label="Usage" className={`${POPOVER_PANEL_RIGHT} w-[268px]`}>
      {/* No bottom padding when the footer follows: the footer well brings its
        * own, and doubling them left the Free row floating well clear of the
        * seam. Without a footer the body owns the panel's bottom edge again. */}
      <div className={`px-3.5 pt-3 ${onCompact ? '' : 'pb-3.5'}`}>
        <div
          className={`flex items-center justify-between ${rows.length > 0 ? 'mb-1' : ''}`}
        >
          <span className="text-[11.5px] text-text-subtle">Context</span>
          <span className="text-[11.5px] tabular-nums text-text-muted">
            {percent == null ? (
              `${fmtTokens(usedTokens)} used`
            ) : (
              <>
                <span className={`font-semibold ${t.text}`}>{percent}%</span> ·{' '}
                {fmtTokens(usedTokens)} / {fmtTokens(contextWindow)}
              </>
            )}
          </span>
        </div>
        {rows.length > 0 ? (
          <>
            <ContextBreakdownDonut
              view={view}
              percentUsed={percentUsed}
              tone={t.text}
              onHover={setHovered}
            />
            {/* Hovering a legend row drives the ring, and vice versa: both ends
             * write the same index. Pointer-only by design — every label and
             * value here is already on screen at rest, so the emphasis reveals
             * nothing a keyboard or touch user would otherwise miss, and making
             * seven readout rows focusable would bury the Compact button behind
             * them in the tab order. */}
            {view.legend.map((row, index) => (
              <div
                key={row.label}
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(null)}
                className={`-mx-1 flex items-center justify-between rounded px-1 py-[2.5px] transition-colors duration-100 ${row.rowClass}`}
              >
                <span
                  className={`flex items-center gap-1.5 text-[11px] transition-colors duration-100 ${row.labelClass}`}
                >
                  <span
                    aria-hidden
                    className={`size-[7px] shrink-0 rounded-[2px] ${row.swatch}`}
                  />
                  {row.label}
                </span>
                <span
                  className={`text-[11px] tabular-nums transition-colors duration-100 ${row.valueClass}`}
                >
                  {fmtTokens(row.tokens)}
                </span>
              </div>
            ))}
            {freeTokens != null ? (
              <div className="mt-0.5 flex items-center justify-between border-t border-shell-seam py-[2.5px]">
                <span className="text-[11px] text-text-subtle">Free</span>
                <span className="text-[11px] tabular-nums text-text-subtle">
                  {fmtTokens(freeTokens)}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {/* The panel's ONE action, in one of two forms and never both. Outside the
       * padded body, and outside the `rows.length` gate: the aggregate row alone
       * is already reason enough to compact, and the breakdown may never arrive.
       *
       * Resting form — an inset button in a separated well, accent-tinted to mark
       * it as the action while the well's own seam keeps that tint off the panel
       * edge. Escalated form — a full-bleed strip in the pressure tone, which is
       * a different sentence, not a recoloured button: past the threshold the
       * panel is telling the operator something rather than offering it. */}
      {onCompact ? (
        escalated == null ? (
          <div className="border-t border-shell-seam px-3.5 py-2">
            <button
              type="button"
              onClick={onCompact}
              // The engine's own words for what the command does (commands/compact/index.ts:8).
              title="Clear conversation history but keep a summary in context"
              className="inline-flex w-full items-center justify-center gap-[5px] rounded-md border border-accent/[0.28] bg-accent/[0.12] px-2.5 py-[5px] text-[11px] font-medium text-accent transition-colors hover:border-accent/[0.42] hover:bg-accent/20"
            >
              <CompactIcon />
              Compact
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onCompact}
            title="Clear conversation history but keep a summary in context"
            className={`flex w-full items-center gap-2 border-t px-3.5 py-[9px] text-left text-[11.5px] font-medium transition-colors ${t.text} ${t.softBorder} ${ESCALATED_ACTION_TINT[escalated]}`}
          >
            <WarningTriangle size={12} />
            <span className="flex-1">Running low, compact now</span>
          </button>
        )
      ) : null}
    </div>
  )
}

/** The compact action's glyph: four arrows pulling inward, at the 11px the usage
 * panel's footer button asks for. Inherits the button's accent via
 * `stroke="currentColor"`, so it tracks the accent theme with the label. */
function CompactIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

/** The warning triangle, at the two sizes the prototype draws it (Surfaces.jsx:436
 * face 14px, `:452` popover header 13px). */
function WarningTriangle({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/**
 * The amber "approaching auto-compact" glyph + popover (the prototype's
 * `TokenWarning`, Surfaces.jsx:415, rendered in the rail at `:779` between the
 * separator and the context donut).
 *
 * Renders NOTHING below the warning threshold — {@link selectTokenWarning}
 * returns null and this never mounts, matching the engine's own
 * `isAboveWarningThreshold` gate rather than a number we chose. The amber is the
 * shared `--tone-warn` token, which is already exactly the prototype's `#fbbf24`
 * (theme.css:62), so no hex is inlined and no dynamic class is interpolated.
 *
 * The two sentences are the engine's two cases (`TokenWarning.tsx:166` / `:169`):
 * with auto-compact ON the session recovers by itself, with it OFF the user has
 * to run `/compact`, so the copy tells them to do that rather than explaining
 * why it stopped.
 */
function TokenWarningChip({
  warning,
  faceProps,
}: {
  warning: TokenWarning
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, ref, triggerRef } = usePopover()
  const { percentLeft, autoCompactEnabled } = warning
  const summary = autoCompactEnabled
    ? `${percentLeft}% until auto-compact`
    : 'Context low'
  const title = autoCompactEnabled
    ? `${percentLeft}% until auto-compact`
    : `Context low · ${percentLeft}% remaining`
  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        title={title}
        onClick={() => setOpen(value => !value)}
        className="animate-token-warn-in flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-tone-warn"
      >
        <WarningTriangle size={14} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Context"
          className="absolute bottom-full right-0 z-40 mb-2.5 w-[252px] rounded-xl border border-tone-warn/25 bg-surface-raised px-3.5 py-3 shadow-lg"
        >
          <div className="mb-1.5 flex items-center gap-[7px]">
            <span className="inline-flex text-tone-warn">
              <WarningTriangle size={13} />
            </span>
            <span className="text-[12.5px] font-semibold text-text-primary">
              {summary}
            </span>
          </div>
          <div className="text-[11.5px] leading-relaxed text-text-muted">
            {autoCompactEnabled ? (
              'This conversation is getting long. Soon it auto-compacts into a summary so it can continue without resending everything.'
            ) : (
              <>
                This conversation is nearly full. Run{' '}
                <span className="font-mono text-tone-warn">/compact</span> to
                summarize it and keep going.
              </>
            )}
          </div>
        </div>
      ) : null}
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
  breakdown,
  onRequestBreakdown,
  onCompact,
  faceProps,
}: {
  usage: ContextUsage
  breakdown: ContextBreakdownSnapshot | null
  onRequestBreakdown?: () => void
  onCompact?: () => void
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, close, ref, triggerRef } = usePopover()
  // Null on a fallback window, where the face itself shows no percentage: the
  // label must not announce one the donut is deliberately withholding.
  const percent = selectContextPercent(usage)
  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          percent == null
            ? 'Open context usage'
            : `Context ${percent}% used, open usage`
        }
        onClick={() => {
          // Recompute on the OPENING edge only: the analysis costs ~10 token
          // counts, so it is paid when the panel is actually being read, never on
          // a close. Deliberately OUTSIDE the `setOpen` updater — React 19
          // StrictMode double-invokes updaters in dev (`main.tsx:24`), which fired
          // two requests per open, and the second landed mid-analysis and queued a
          // full rerun.
          if (!open) onRequestBreakdown?.()
          setOpen(value => !value)
        }}
        className="flex shrink-0 items-center rounded-md"
      >
        <ContextGauge usage={usage} />
      </button>
      {open ? (
        <ContextUsagePanel
          usage={usage}
          breakdown={breakdown}
          // Dismiss on submit: the panel is a readout of a number the compaction
          // is about to change, so leaving it open would show a stale one.
          // `close`, not `setOpen(false)` — a selection owes the trigger its
          // focus back BEFORE the panel unmounts, or a keyboard user who
          // activated this row lands on `<body>` (ACCT-2, `composerPopover.ts`).
          onCompact={
            onCompact
              ? () => {
                  close()
                  onCompact()
                }
              : undefined
          }
        />
      ) : null}
    </div>
  )
}

export function ComposerActionsBar({
  attachDisabled,
  onAttach,
  model,
  modelLabel = null,
  reasoningEffort,
  fastMode,
  runControls,
  onSetModel,
  onSetEffort,
  onSetFast,
  permissionContext,
  permissionModeReadOnly = null,
  onSetMode,
  account,
  anthropicAccount,
  accounts,
  onSwitchAccount,
  onManageAccounts,
  onOpenAccountSwitcher,
  contextUsage,
  contextBreakdown = null,
  onRequestContextBreakdown,
  onCompact,
  toolbarRef,
  onFocusComposer,
}: {
  attachDisabled: boolean
  onAttach: () => void
  /** The RESOLVED model this session runs; null before the snapshot → face omitted. */
  model: string | null
  /** Its product name, when one was reported. The read-only face shows this and
   * falls back to the id; the interactive `ModelChip` already had its own. */
  modelLabel?: string | null
  /** The session's reasoning-effort tier; null when running at the provider default → face omitted. */
  reasoningEffort: string | null
  /**
   * Fast-mode state for the READ-ONLY face: true/false when it is known, null
   * when nothing has reported it (a preview) or the model cannot do fast at all,
   * in which case no face renders — the live chip's own `supportedByModel`
   * behaviour.
   */
  fastMode: boolean | null
  /**
   * P4-24c — the LIVE run-controls snapshot (current + real picker options +
   * availability). When present WITH the matching `onSet*` handler, a face becomes
   * an interactive picker; absent, it falls back to the P4-24 read-only face.
   */
  runControls?: RunControlsSnapshot | null
  onSetModel?: (model: string | null) => void
  onSetEffort?: (effort: string) => void
  onSetFast?: (active: boolean) => void
  permissionContext: PermissionContextSnapshot | null
  /** The mode a session with no live context ran under, from its cached
   * transcript (preview panes). Display-only. */
  permissionModeReadOnly?: string | null
  onSetMode: (mode: PermissionSetModeMode) => void
  /** The Codex pool's active account (real alias), or null before the snapshot arrives. */
  account: AccountStatus | null
  /** Active Anthropic subscription account for an Anthropic-routed session. */
  anthropicAccount?: AnthropicAccountStatus | null
  /** The full Codex pool (`accountsState.selectAccountRows`) for the switcher popover;
   * empty before the snapshot. With `onSwitchAccount` present, the account face becomes
   * the interactive switcher; absent, it falls back to the P4-24 read-only face. */
  accounts?: AccountStatus[]
  /** Switch the active session to `accountId` (the engine's `account.switch` verb). */
  onSwitchAccount?: (accountId: string) => void
  /** Open the full Accounts page (the popover's "Manage accounts →"). */
  onManageAccounts?: () => void
  /** Re-read the global account pool when the switcher opens. */
  onOpenAccountSwitcher?: () => void
  /** Real context-window fullness, or null before the first result frame. */
  contextUsage: ContextUsage | null
  /**
   * Per-category context occupancy for the donut popover. Null until the
   * sidecar's first `context-breakdown.snapshot`.
   */
  contextBreakdown?: ContextBreakdownSnapshot | null
  /** Opening the usage popover asks the sidecar to recompute the breakdown. */
  onRequestContextBreakdown?: () => void
  /** Submits `/compact`. Absent when no engine can take it, which hides the row. */
  onCompact?: () => void
  /** Feature #4 — the toolbar's DOM node, so the composer keydown (App.tsx) can
   * move focus into the first face via {@link focusFirstComposerFace}. */
  toolbarRef?: Ref<HTMLDivElement>
  /** Feature #4 — return focus to the composer field (Escape, or Shift+Tab off
   * the first face). Owned by App.tsx, which holds the field ref. */
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
  const anthropicAccountLabel =
    anthropicAccount?.alias ?? anthropicAccount?.email ?? null
  // Interactive switcher when the active account AND a switch handler are both
  // present; otherwise the P4-24 read-only alias face (mirrors the ModelChip gate).
  const accountInteractive = account != null && onSwitchAccount != null

  // Derived at read time, never stored: the glyph appears when the live context
  // crosses the engine's warning threshold and clears itself once a turn compacts.
  const tokenWarning = selectTokenWarning(
    contextUsage ?? null,
    runControls?.autoCompact,
  )

  // Feature #4 — roving tabindex across the faces (ARIA toolbar). The tab stop
  // follows the last-focused face; when nothing in the bar is focused it rests on
  // the first face ('attach', always rendered), so Tab from the field has a
  // deterministic landing spot. Faces read their tabIndex from `faceProps(id)`.
  const [activeFace, setActiveFace] = useState<string | null>(null)
  // The warning glyph is the one face that can vanish mid-session (it unmounts
  // the moment a turn compacts). If it held the tab stop when it went, no face
  // would match and the whole toolbar would have NO tabIndex=0 until a blur
  // happened to reset it. Resolve the stop at read time instead of storing it.
  const resolvedActiveFace =
    activeFace === 'token-warning' && !tokenWarning ? null : activeFace
  const faceProps = (id: string): ComposerFaceProps => ({
    'data-composer-face': id,
    tabIndex: id === (resolvedActiveFace ?? 'attach') ? 0 : -1,
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
        // the first face returns to the composer; Tab off the last face falls
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
      {/* Attach (§10, Chat.jsx:1435): quiet #3f3f46 glyph brightening to
       * #a1a1aa on hover. The owner opens main's native file picker. */}
      <button
        {...faceProps('attach')}
        aria-label="Add attachment"
        title="Add file or photo"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-text-ghost transition-colors hover:text-text-muted disabled:opacity-50"
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
              label={runControls.model.currentLabel}
              selected={runControls.model.selected}
              provider={runControls.model.provider}
              providerSwitchLocked={runControls.model.providerSwitchLocked}
              options={runControls.model.options}
              onSelect={onSetModel}
              faceProps={faceProps('model')}
            />
            <RailSep />
          </>
        ) : model ? (
          <>
            {/* The LABEL, falling back to the id only when no name was reported
              * (a preview reads a cache, which stores the id alone). Rendering
              * the id here turned `Sonnet 4.5` into
              * `claude-sonnet-4-5-20250929` the moment a session parked — the
              * same defect `ModelChip` fixed for the live face above. */}
            <span
              className={`${RAIL_FACE} text-[light-dark(#0e7490,#22d3ee)]`}
              title={`Model: ${modelLabel ?? model}`}
            >
              {modelLabel ?? model}
            </span>
            <RailSep />
          </>
        ) : null}
        {effortInteractive && runControls && onSetEffort ? (
          <>
            <ReasoningChip
              current={runControls.effort.current ?? reasoningEffort}
              selected={runControls.effort.selected}
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
          readOnlyMode={permissionModeReadOnly}
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
        ) : fastMode !== null ? (
          <FastFace active={fastMode} />
        ) : null}

        <div className="ml-auto flex min-w-0 items-center gap-[7px]">
          {accountInteractive && account && onSwitchAccount ? (
            <AccountChip
              active={account}
              accounts={accounts ?? []}
              onSwitch={onSwitchAccount}
              onManage={onManageAccounts}
              onOpen={onOpenAccountSwitcher}
              faceProps={faceProps('account')}
            />
          ) : showAccount ? (
            /* The same status dot the interactive chip shows, for the same
             * reason: the alias text is deliberately never health-tinted, so the
             * dot is the ONLY thing carrying which account this is and how it is
             * doing. Dropping it on a detached pane silently removed the health
             * signal from the one state where the user cannot open the switcher
             * to go looking for it. */
            <span
              className={`${RAIL_FACE} gap-1.5 text-text-muted`}
              title={`Active account: ${accountAlias} · ${account.availabilityLabel}`}
            >
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${toneClasses(statusDotTone(account)).dot}`}
                aria-hidden
              />
              {accountAlias}
            </span>
          ) : anthropicAccount && anthropicAccountLabel ? (
            <span
              className={`${RAIL_FACE} text-text-muted`}
              title={`Active Anthropic account: ${anthropicAccountLabel} · ${ANTHROPIC_STATUS_LABEL[anthropicAccount.status]}`}
            >
              {anthropicAccountLabel}
            </span>
          ) : null}
          {(accountInteractive || showAccount || anthropicAccountLabel) && contextUsage ? (
            <RailSep />
          ) : null}
          {/* The prototype orders the right cluster account · Sep · TokenWarning ·
            * ContextChip (Surfaces.jsx:771-780): the glyph sits INSIDE the separator,
            * next to the donut it is about, and is absent entirely below the
            * threshold. */}
          {tokenWarning ? (
            <TokenWarningChip
              warning={tokenWarning}
              faceProps={faceProps('token-warning')}
            />
          ) : null}
          {contextUsage ? (
            <ContextChip
              usage={contextUsage}
              breakdown={contextBreakdown}
              onRequestBreakdown={onRequestContextBreakdown}
              onCompact={onCompact}
              faceProps={faceProps('context')}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
