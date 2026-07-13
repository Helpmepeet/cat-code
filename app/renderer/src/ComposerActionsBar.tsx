import { useEffect, useRef, useState } from 'react'
import { ContextGauge } from './ContextGauge.js'
import type { ContextUsage } from './contextUsage.js'
import { PermissionModeChip } from './PermissionModeChip.js'
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
 * popover pattern (open state + outside-click/Escape dismiss, upward panel) mirrors
 * `PermissionModeChip`. Tailwind v4: only STATIC arbitrary classes.
 * --------------------------------------------------------------------------- */

/** Shared upward-popover state: open flag + a ref that dismisses on outside-click/Escape. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref }
}

const POPOVER_PANEL =
  'absolute bottom-full left-0 z-40 mb-2 rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-lg'
const POPOVER_HEADING =
  'px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle'

/** Interactive MODEL face → a popover of the REAL selectable models (`model.set`). */
function ModelChip({
  current,
  selected,
  options,
  onSelect,
}: {
  current: string | null
  selected: string | null
  options: RunControlModelOption[]
  onSelect: (value: string) => void
}) {
  const { open, setOpen, ref } = usePopover()
  return (
    <div ref={ref} className="relative shrink-0">
      <button
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
                  setOpen(false)
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
}: {
  current: string | null
  options: string[]
  onSelect: (effort: string) => void
}) {
  const { open, setOpen, ref } = usePopover()
  // 'Auto' clears the explicit tier (sends 'auto' → the engine's provider default).
  const items = [
    { value: 'auto', label: 'Auto' },
    ...options.map(level => ({ value: level, label: formatEffort(level) })),
  ]
  return (
    <div ref={ref} className="relative shrink-0">
      <button
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
        <div role="menu" aria-label="Reasoning effort" className={`${POPOVER_PANEL} w-48`}>
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
                  setOpen(false)
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
}: {
  active: boolean
  supportedByModel: boolean
  available: boolean
  unavailableReason: string | null
  onToggle: (active: boolean) => void
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
  contextUsage,
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
  /** Real context-window fullness, or null before the first result frame. */
  contextUsage: ContextUsage | null
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
  return (
    <div className="mt-3 flex items-center gap-4 px-1">
      {/* Attach (§10 ❓, Chat.jsx:1435): quiet #3f3f46 glyph brightening to
       * #a1a1aa on hover — a real file picker needs an engine attachment
       * capability that is NOT on the wire; the working attach path today is a
       * large paste, which the toast + title spell out. */}
      <button
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
        <PermissionModeChip context={permissionContext} onSetMode={onSetMode} />
        {fastInteractive && runControls && onSetFast ? (
          <FastChip
            active={runControls.fast.active}
            supportedByModel={runControls.fast.supportedByModel}
            available={runControls.fast.available}
            unavailableReason={runControls.fast.unavailableReason}
            onToggle={onSetFast}
          />
        ) : fastMode ? (
          <FastFace />
        ) : null}

        <div className="ml-auto flex min-w-0 items-center gap-[7px]">
          {showAccount ? (
            <span
              className={`${RAIL_FACE} text-text-muted`}
              title={`Active account: ${accountAlias} · ${account.status}`}
            >
              {accountAlias}
            </span>
          ) : null}
          {showAccount && contextUsage ? <RailSep /> : null}
          {contextUsage ? <ContextGauge usage={contextUsage} /> : null}
        </div>
      </div>
    </div>
  )
}
