import { LidClosedCup } from './LidClosedCup.js'
import type { WorkspaceBranchReadout } from './useWorkspaceBranch.js'
import './workspaceBranch.css'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react'
import {
  formatResetLabel,
  statusDotTone,
  usageTone,
} from './accountsPageModel.js'
import { selectWelcomeUsageWindows } from './welcomeUsage.js'
import { toggleAccountChip } from './composerAccountChip.js'
import { handleMenuRovingKeyDown, usePopover } from './composerPopover.js'
import { ComposerPopoverPanel } from './ComposerPopoverPanel.js'
import { ContextGauge } from './ContextGauge.js'
import {
  pressureTone,
  selectContextCapacity,
  selectContextPercent,
  type ContextCapacity,
  type ContextUsage,
} from './contextUsage.js'
import { selectTokenWarning, type TokenWarning } from './tokenWarning.js'
import {
  selectBreakdownRows,
  type ContextBreakdownRow,
} from './contextBreakdownState.js'
import { PermissionModeOptions } from './PermissionModeChip.js'
import { ProviderLogo } from './ProviderLogo.js'
import { permissionModeMeta, permissionModeShortLabel } from './permissionLabels.js'
import { ToggleSwitch } from './SettingsEditors.js'
import { ActionWarningIcon, Glyph } from './SessionActionIcons.js'
import { toneClasses } from './tone.js'
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

/** The run face reads live or retained engine values, never mock model names.
 * Retaining display data must not retain the ability to send a setter. */

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

/** The prototype's faint `·` divider (Surfaces.jsx:751 `Sep`, colour #3f3f46). */
function RailSep() {
  return (
    <span aria-hidden className="composer-separator shrink-0 select-none text-[12px] text-white/20">
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

function FastGlyph({ active }: { active: boolean }) {
  return (
    <svg
      width="11"
      height="11"
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

const POPOVER_PANEL =
  'animate-pop-up absolute bottom-full left-0 z-40 mb-2 rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-lg'
const POPOVER_HEADING =
  'px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle'
/**
 * The keyboard's own feedback. Arrow-key roving moves focus and nothing else —
 * activation stays on Enter/Space — so without a ring the keys appear to do
 * nothing at all, which on a 6px-tall effort rung is the difference between a
 * usable control and a dead one. Inset, because the panel scrolls and an
 * outward ring on the first or last row would be clipped by it.
 */
const MENU_FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2'
// The account/context cluster rides `ml-auto` at the rail's right edge, so its
// popovers anchor right (a `left-0` panel would overflow off-screen). Own padding
// per section (no panel-wide `p-1.5`), matching the prototype's sectioned popovers.
const POPOVER_PANEL_RIGHT =
  'animate-pop-up absolute bottom-full right-0 z-40 mb-2 overflow-hidden rounded-lg border border-shell-seam bg-surface-raised shadow-lg'

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

/** One face for the session's run settings. The engine snapshot remains the
 * authority after a model pick, including any reconciled effort selection. */
function RunControl({
  model,
  modelLabel,
  reasoningEffort,
  fastMode,
  snapshot,
  readOnlySnapshot,
  permissionContext,
  readOnlyMode,
  onSetModel,
  onSetEffort,
  onSetFast,
  onSetMode,
  faceProps,
  onFocusComposer,
}: {
  model: string | null
  modelLabel: string | null
  reasoningEffort: string | null
  fastMode: boolean | null
  snapshot?: RunControlsSnapshot | null
  readOnlySnapshot?: RunControlsSnapshot | null
  permissionContext: PermissionContextSnapshot | null
  readOnlyMode: string | null
  onSetModel?: (model: string | null) => void
  onSetEffort?: (effort: string) => void
  onSetFast?: (active: boolean) => void
  onSetMode: (mode: PermissionSetModeMode) => void
  faceProps?: ComposerFaceProps
  onFocusComposer?: () => void
}) {
  const { open, setOpen, close, ref, triggerRef, panelRef } = usePopover(
    onFocusComposer,
    {
      selector: 'button:not([disabled])',
      prioritySelector: '[data-run-model], [aria-checked="true"]',
    },
  )
  const [step, setStep] = useState<'main' | 'model' | 'mode'>('main')
  const focusAfterStep = useRef<'model' | 'mode' | 'list' | null>(null)
  useEffect(() => {
    const destination = focusAfterStep.current
    if (!destination) return
    focusAfterStep.current = null
    const panel = panelRef.current
    const target = destination === 'list'
      ? panel?.querySelector<HTMLElement>('button[aria-checked="true"]:not([disabled])')
      : panel?.querySelector<HTMLElement>(`[data-run-${destination}]`)
    const landing = target ?? panel?.querySelector<HTMLElement>('button:not([disabled])')
    landing?.focus()
  }, [panelRef, step])

  const display = snapshot ?? readOnlySnapshot
  const currentModel = display?.model.current ?? model
  const label = display?.model.currentLabel ?? modelLabel ?? currentModel
  // Preview caches carry model ids but no provider snapshot. Only recognized
  // model families can supply a mark in that fallback path.
  const provider = display?.model.provider ?? (
    currentModel?.startsWith('gpt-') ? 'openai' :
    currentModel?.startsWith('claude-') ? 'anthropic' : null
  )
  const hasEffort = display
    ? display.effort.supported && display.effort.options.length > 0
    : reasoningEffort !== null
  const effort = display?.effort.current ?? reasoningEffort
  const effortLabel = hasEffort
    ? effort
      ? `${formatEffort(effort)}${display?.effort.selected === null ? ' (Auto)' : ''}`
      : 'Auto'
    : null
  const fast = display
    ? display.fast.supportedByModel ? display.fast.active : null
    : fastMode
  const mode = permissionContext?.mode ?? readOnlyMode
  const modeLabel = mode ? permissionModeShortLabel(mode) : null
  const modeTone = mode ? permissionModeMeta(mode)?.toneText ?? 'text-text-muted' : ''
  const accessibleLabel = [
    label ? `Model: ${label}` : null,
    effortLabel ? `Reasoning effort: ${effortLabel}` : null,
    fast !== null ? `Fast mode ${fast ? 'on' : 'off'}` : null,
    modeLabel ? `Permission mode: ${modeLabel}` : null,
  ].filter(Boolean).join(', ')
  const interactive = snapshot != null && (
    permissionContext !== null ||
    onSetModel != null || onSetEffort != null || onSetFast != null
  )
  const modelEnabled = snapshot != null && onSetModel != null && snapshot.model.options.some(option => option.value !== null)
  // The provider-default row is not offered: it names no model, so picking it
  // hands the choice back to the engine. A session already on it still reads
  // its resolved model on the face.
  const groups = groupOptionsByProvider(
    (snapshot?.model.options ?? []).filter(option => option.value !== null),
  )
  const contents = (
    <>
      {provider && label ? <ProviderLogo provider={provider} size={12} className={`composer-provider-logo composer-provider-${provider}`} /> : null}
      {label ? <span className="truncate text-[light-dark(#0e7490,#22d3ee)]">{label}</span> : null}
      {effortLabel ? <span className="shrink-0 text-accent">{effortLabel}</span> : null}
      {fast === true ? <span className="flex shrink-0 text-tone-warn"><FastGlyph active /></span> : null}
      {modeLabel && mode !== 'auto' ? <span className={`shrink-0 ${modeTone}`}>{modeLabel}</span> : null}
    </>
  )
  const returnToMain = () => {
    focusAfterStep.current = step === 'mode' ? 'mode' : 'model'
    setStep('main')
  }
  const openStep = (next: 'model' | 'mode') => {
    focusAfterStep.current = 'list'
    setStep(next)
  }
  useEffect(() => {
    if (!interactive) {
      setOpen(false)
    } else if (
      (step === 'mode' && !permissionContext) ||
      (step === 'model' && !modelEnabled)
    ) {
      focusAfterStep.current = step === 'mode' ? 'mode' : 'model'
      setStep('main')
    }
  }, [interactive, modelEnabled, permissionContext, setOpen, step])

  if (!interactive) {
    if (!accessibleLabel) return null
    return (
      <span className={`${RAIL_FACE} composer-run-face`} aria-label={accessibleLabel} title={accessibleLabel}>
        {contents}
      </span>
    )
  }
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={accessibleLabel || 'Run controls'}
        title={accessibleLabel || 'Run controls'}
        onClick={() => {
          triggerRef.current?.focus()
          focusAfterStep.current = null
          setStep('main')
          setOpen(value => !value)
        }}
        className={`${RAIL_FACE} composer-run-face`}
      >
        {contents}
      </button>
      {open ? (
        <ComposerPopoverPanel panelRef={panelRef} triggerRef={triggerRef}>
        <div
          role="menu"
          aria-label={step === 'main' ? 'Run controls' : step === 'model' ? 'Model' : 'Permission mode'}
          onKeyDown={event => {
            if (event.key === 'Escape' && step !== 'main' && !event.defaultPrevented) {
              event.preventDefault()
              event.stopPropagation()
              returnToMain()
              return
            }
            handleMenuRovingKeyDown(event)
          }}
          className={`${POPOVER_PANEL} max-h-[320px] w-64 overflow-auto`}
        >
          {step !== 'main' ? (
            <button
              type="button"
              role="menuitem"
              aria-label="Back to run controls"
              onClick={returnToMain}
              className={`${MENU_FOCUS_RING} composer-run-back flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-shell-hover ${step === 'model' ? 'text-[light-dark(#0e7490,#22d3ee)]' : 'text-text-subtle'}`}
            >
              <StepChevron />
              {step === 'model' ? label ?? 'Model' : 'Mode'}
            </button>
          ) : null}
          {step === 'main' ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-run-model
                aria-label={label ? `Model: ${label}` : 'Select model'}
                disabled={!modelEnabled}
                onClick={() => openStep('model')}
                className={`${MENU_FOCUS_RING} composer-run-row text-[light-dark(#0e7490,#22d3ee)] disabled:opacity-50`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {provider ? <ProviderLogo provider={provider} size={12} className={`composer-provider-logo composer-provider-${provider}`} /> : null}
                  <span className="truncate">{label ?? 'Model'}</span>
                </span>
                {modelEnabled ? <StepChevron /> : null}
              </button>
              {hasEffort && snapshot && onSetEffort ? (
                <div className="pt-1">
                  <EffortSlider
                    key={JSON.stringify([snapshot.model.provider, snapshot.model.current, snapshot.effort.options])}
                    levels={snapshot.effort.options}
                    selected={snapshot.effort.selected}
                    applied={snapshot.effort.current}
                    onSelect={onSetEffort}
                  />
                </div>
              ) : null}
              <div className="composer-run-seam" />
              {snapshot?.fast.supportedByModel ? (
                <div
                  className="composer-run-row"
                  title={!snapshot.fast.available ? snapshot.fast.unavailableReason ?? 'Fast mode unavailable' : undefined}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={snapshot.fast.active ? 'text-tone-warn' : 'text-text-ghost'}><FastGlyph active /></span>
                    Fast
                  </span>
                  <ToggleSwitch
                    label="Fast mode"
                    value={snapshot.fast.active}
                    disabled={!onSetFast || (!snapshot.fast.active && !snapshot.fast.available)}
                    onChange={onSetFast ?? (() => {})}
                    showValue={false}
                  />
                </div>
              ) : null}
              {modeLabel ? (
                <button
                  type="button"
                  role="menuitem"
                  data-run-mode
                  aria-label={`Permission mode: ${modeLabel}`}
                  disabled={!permissionContext}
                  onClick={() => openStep('mode')}
                  className={`${MENU_FOCUS_RING} composer-run-row disabled:opacity-50`}
                >
                  <span>Mode</span>
                  <span className={`flex items-center gap-1.5 ${modeTone}`}>{modeLabel}<StepChevron /></span>
                </button>
              ) : null}
            </>
          ) : step === 'mode' && permissionContext ? (
            <PermissionModeOptions context={permissionContext} onSelect={mode => { onSetMode(mode); close() }} />
          ) : step === 'model' && snapshot ? (
            groups.map(group => {
              // The lock is a PROVIDER fact, so it reads at the group: four
              // identically dimmed rows say the same thing four times, and the
              // rows carried no visual state at all before (native `disabled`
              // alone paints nothing).
              const groupLocked =
                snapshot.model.providerSwitchLocked &&
                (snapshot.model.provider === 'openai') !== (group.provider === 'openai')
              return (
                <div
                  key={group.provider}
                  className={groupLocked ? 'opacity-40' : undefined}
                >
                  {groups.length > 1 ? (
                    <div className={`${POPOVER_HEADING} flex items-center gap-1.5`}>
                      <ProviderLogo provider={group.provider} size={11} className={`composer-provider-logo composer-provider-${group.provider}`} />
                      {formatProvider(group.provider)}
                    </div>
                  ) : null}
                  {group.options.map(option => {
                    const active = snapshot.model.selected === option.value
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        aria-disabled={groupLocked}
                        disabled={groupLocked}
                        onClick={() => {
                          if (groupLocked) return
                          onSetModel?.(option.value)
                          returnToMain()
                        }}
                        className={`${MENU_FOCUS_RING} flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 ${
                          active ? 'bg-white/[0.06]' : ''
                        }`}
                      >
                        <span
                          className={`min-w-0 truncate text-xs ${active ? 'text-[light-dark(#0e7490,#22d3ee)]' : 'text-text-primary'}`}
                        >
                          {option.label}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })
          ) : null}
        </div>
        </ComposerPopoverPanel>
      ) : null}
    </div>
  )
}

/** Provider groups in first-appearance order, so the engine's own option order
 * (`getModelOptions()`) survives the grouping. */
function groupOptionsByProvider(
  options: RunControlModelOption[],
): { provider: RunControlProvider; options: RunControlModelOption[] }[] {
  const groups: { provider: RunControlProvider; options: RunControlModelOption[] }[] = []
  for (const option of options) {
    const group = groups.find(entry => entry.provider === option.provider)
    if (group) group.options.push(option)
    else groups.push({ provider: option.provider, options: [option] })
  }
  return groups
}

/** The chevron marking a row that opens another face. */
function StepChevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-ghost"
      aria-hidden
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

/**
 * Where a key lands inside the rail, as an index into the rungs. The rail is a
 * horizontal control living inside a vertical menu, so it answers Left/Right
 * itself and leaves Up/Down to the menu's own roving, which walks the face's
 * items in order (back, then the rungs).
 *
 * Home/End are answered here too, for the same reason: inside the rail they
 * mean the ends of the SCALE, which is not what they mean in the menu around
 * it. Handling them first is what makes that true — `handleMenuRovingKeyDown`
 * returns early on an already-defaulted event.
 *
 * Movement CLAMPS rather than wrapping, unlike the menu: a scale has ends, and
 * arrowing off `Ultra` back round to `Low` would be a long way from what the
 * key was asking for.
 */
function nextRungIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, (currentIndex < 0 ? 0 : currentIndex) - 1)
    case 'ArrowRight':
      return Math.min(count - 1, currentIndex + 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * Where the first and last tick sit, in pixels from the track's ends: half the
 * thumb's width, so a thumb at either end sits flush inside the pill. Shared by
 * the `w-7` tick buttons, the `w-3.5` fill caps, and `rungIndexAt`.
 */
const RAIL_EDGE_PX = 14

/** The rung nearest a pointer's x position on the rail, clamped to its ends. */
function rungIndexAt(rail: HTMLElement, clientX: number, count: number): number {
  if (count <= 1) return 0
  const rect = rail.getBoundingClientRect()
  const span = rect.width - RAIL_EDGE_PX * 2
  if (span <= 0) return 0
  const ratio = (clientX - rect.left - RAIL_EDGE_PX) / span
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))))
}

/**
 * The effort slider for the model currently reported by the engine.
 *
 * The levels are ordinal, so they are drawn as one track filled up to the chosen
 * level rather than as a list of equal rows: the fill says how far up you are,
 * and a track that runs out sooner says the model tops out sooner.
 *
 * `selected` is the RAW session selection, not the applied tier: an env or
 * provider default must not read back as a level the user chose.
 * A session with no selection is therefore an empty track, with the level it
 * actually runs at named in muted text. Auto is not offered as a choice.
 *
 * Each rung stays a real `menuitemradio` button so the menu's Up/Down roving and
 * Enter/Space activation reach it; the track around the buttons adds pointer
 * dragging and click-anywhere snapping. A drag commits once, on release, so
 * crossing four rungs does not fire four effort writes.
 */
function EffortSlider({
  levels,
  selected,
  applied,
  onSelect,
}: {
  levels: string[]
  selected: string | null
  applied: string | null
  onSelect: (effort: string) => void
}) {
  const currentIndex = selected === null ? -1 : levels.indexOf(selected)
  const railRef = useRef<HTMLDivElement>(null)
  // The rung under the pointer while a press is held; it drives the fill and
  // thumb so a drag shows where it will land before it commits.
  const [drag, setDrag] = useState<{ index: number; moved: boolean } | null>(null)
  // The rung being looked at (hovered or keyboard-focused), named in the header
  // because the ticks themselves carry no text.
  const [peekIndex, setPeekIndex] = useState<number | null>(null)
  const shownIndex = drag ? drag.index : currentIndex
  const labelIndex = drag?.index ?? peekIndex ?? currentIndex

  useLayoutEffect(() => () => {
    const rail = railRef.current
    if (!rail?.contains(document.activeElement)) return
    const modelRow = rail.closest('[role="menu"]')
      ?.querySelector<HTMLButtonElement>('[data-run-model]')
    // Restore only when the panel survives a model change, not when it closes
    // or another focus owner has already taken over.
    queueMicrotask(() => {
      if (modelRow?.isConnected && document.activeElement === document.body) modelRow.focus()
    })
  }, [])

  useEffect(() => {
    const rail = railRef.current
    if (!rail || levels.length < 2) return

    const updateFlowGeometry = () => {
      const gapWidth = Math.max(0, rail.clientWidth - 28) / (levels.length - 1)
      rail.style.setProperty(
        '--effort-flow-width',
        `${14 + Math.max(0, shownIndex) * gapWidth}px`,
      )
      const progress = Math.max(0, shownIndex) / (levels.length - 1)
      rail.style.setProperty(
        '--effort-flow-duration',
        `${2.4 - 1.6 * progress}s`,
      )
    }

    updateFlowGeometry()
    const observer = new ResizeObserver(updateFlowGeometry)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [levels.length, shownIndex])

  function rungButtons(): HTMLButtonElement[] {
    return Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    )
  }

  function onRailKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented) return
    const rungs = rungButtons()
    const active = rungs.indexOf(document.activeElement as HTMLButtonElement)
    const target = nextRungIndex(event.key, active, rungs.length)
    if (target === null) return
    event.preventDefault()
    rungs[target]?.focus()
  }

  function onRailPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || levels.length === 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDrag({
      index: rungIndexAt(event.currentTarget, event.clientX, levels.length),
      moved: false,
    })
  }

  function onRailPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!drag) return
    const index = rungIndexAt(event.currentTarget, event.clientX, levels.length)
    if (index !== drag.index) setDrag({ index, moved: true })
  }

  function onRailPointerUp(): void {
    if (!drag) return
    setDrag(null)
    rungButtons()[drag.index]?.focus()
    // A drag that wandered and came back to where it started changed nothing.
    if (drag.moved && drag.index === currentIndex) return
    onSelect(levels[drag.index]!)
  }

  return (
    <div className="px-2 pb-2">
      <div className="flex items-center justify-between pb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
          Effort
        </span>
        <span
          className={`min-h-5 text-[15px] font-semibold leading-5 transition-colors ${
            labelIndex >= 0 && labelIndex === currentIndex ? 'text-accent' : 'text-text-muted'
          }`}
        >
          {labelIndex >= 0
            ? formatEffort(levels[labelIndex]!)
            : applied
              ? formatEffort(applied)
              : null}
        </span>
      </div>
      <div
        ref={railRef}
        onKeyDown={onRailKeyDown}
        onPointerDown={onRailPointerDown}
        onPointerMove={onRailPointerMove}
        onPointerUp={onRailPointerUp}
        onPointerCancel={() => setDrag(null)}
        className="relative h-7 cursor-pointer touch-none select-none"
      >
        {/* The track and its fill share one clipped pill. The fill is a cap under
          * the first tick plus one piece per gap, each scaling out from its left
          * edge, so raising the level sweeps the fill along the track; its flat
          * leading edge always ends under the thumb. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 flex h-6 -translate-y-1/2 overflow-hidden rounded-full bg-text-primary/[0.1]"
        >
          <span
            className={`h-full w-3.5 shrink-0 bg-accent ${shownIndex >= 0 ? '' : 'opacity-0'}`}
          />
          {levels.slice(1).map((level, index) => (
            <span
              key={level}
              className={`h-full flex-1 origin-left bg-accent transition-transform duration-[var(--motion-fast)] ease-[var(--ease-standard)] ${
                index < shownIndex ? 'scale-x-100' : 'scale-x-0'
              }`}
            />
          ))}
          <span className="w-3.5 shrink-0" />
        </span>
        {shownIndex > 0 && levels.length > 1 ? (
          <span
            aria-hidden
            className="effort-flow-clip animate-effort-flow pointer-events-none absolute left-0 top-1/2 h-6 -translate-y-1/2 overflow-hidden rounded-l-full"
          >
            <span className="effort-flow-light-band" />
          </span>
        ) : null}
        <div className="absolute inset-0 flex items-center justify-between">
          {levels.map((level, index) => {
            const isThumb = index === shownIndex
            const filled = shownIndex >= 0 && index <= shownIndex
            return (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={index === currentIndex}
                aria-label={formatEffort(level)}
                title={formatEffort(level)}
                data-filled={filled}
                // A pointer press already committed on release; this path is
                // the keyboard's (Enter/Space) and a synthetic click's.
                onClick={event => {
                  if (event.detail === 0) onSelect(level)
                }}
                onPointerEnter={() => setPeekIndex(index)}
                onPointerLeave={() => setPeekIndex(null)}
                onFocus={() => setPeekIndex(index)}
                onBlur={() => setPeekIndex(null)}
                className={`${MENU_FOCUS_RING} group relative grid h-7 w-7 place-items-center rounded-full`}
              >
                <span
                  aria-hidden
                  className={`block rounded-full transition-all duration-[var(--motion-fast)] ease-[var(--ease-standard)] ${
                    isThumb
                      ? 'h-7 w-7 bg-[#ffffff] shadow-[0_1px_4px_rgb(0_0_0/0.3)] group-hover:scale-105'
                      : filled
                        ? 'h-1 w-1 bg-[rgb(255_255_255/0.55)]'
                        : 'h-1 w-1 bg-text-primary/30 group-hover:h-1.5 group-hover:w-1.5 group-hover:bg-text-primary/60'
                  }`}
                />
              </button>
            )
          })}
        </div>
      </div>
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

/** One account's compact used-percent bar (5h or weekly) — the prototype's
 * `UsedMetric` (Surfaces.jsx:572), token-toned via the SAME `usageTone`/`toneClasses`
 * the Accounts page uses so the composer reads identically. Null usage → empty slot. */
function AccountUsageBar({
  pct,
  className = 'w-[72px]',
}: {
  pct: number | null
  className?: string
}) {
  if (pct == null) {
    return <span className={className} aria-hidden="true" />
  }
  const t = toneClasses(usageTone(pct))
  return (
    <span className={`flex items-center gap-1.5 ${className}`}>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-shell-hover">
        {/* §0 EXCEPTION: data-driven percent width Tailwind can't express — the
            single allowed inline style (width only), mirroring AccountsPage's
            HeadroomBar (AccountsPage.tsx:213). */}
        <span
          className={`block h-full rounded-full ${t.dot}`}
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </span>
      <span
        className={`w-7 shrink-0 text-right text-[11px] font-semibold tabular-nums ${t.text}`}
      >
        {pct}%
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
  return (
    <div
      role="menu"
      aria-label="Accounts"
      onKeyDown={handleMenuRovingKeyDown}
      className={`${POPOVER_PANEL_RIGHT} w-[336px]`}
    >
      <div className="flex items-center gap-3 px-3.5 pb-1.5 pt-2.5">
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
          const { fiveHour, weekly } = selectWelcomeUsageWindows(acct)
          const hasBoth = fiveHour !== null && weekly !== null
          const singleWindow = hasBoth ? null : (weekly ?? fiveHour)
          return (
            <button
              key={acct.id}
              type="button"
              role="menuitem"
              aria-current={isActive ? 'true' : undefined}
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
                  className={`w-[156px] text-[11px] ${toneClasses(statusDotTone(acct)).text}`}
                >
                  {acct.availabilityLabel}
                  {acct.status === 'capped' ? (
                    <span className="text-text-subtle">
                      {' '}
                      · ↺ {formatResetLabel(acct.usageResetAt)}
                    </span>
                  ) : null}
                </span>
              ) : hasBoth ? (
                <>
                  <AccountUsageBar pct={fiveHour.percent} />
                  <AccountUsageBar pct={weekly.percent} />
                </>
              ) : singleWindow ? (
                <AccountUsageBar
                  pct={singleWindow.percent}
                  className="w-[156px]"
                />
              ) : (
                <span className="w-[156px]" aria-hidden="true" />
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
 * read-only face when no switch handler is wired (mirrors the run control's
 * interactive-vs-face pattern). */
function AccountChip({
  active,
  accounts,
  onSwitch,
  onManage,
  onOpen,
  faceProps,
  onFocusComposer,
}: {
  active: AccountStatus
  accounts: AccountStatus[]
  onSwitch: (accountId: string) => void
  onManage?: () => void
  onOpen?: () => void
  faceProps?: ComposerFaceProps
  onFocusComposer?: () => void
}) {
  const { open, setOpen, close, ref, triggerRef, panelRef: popoverRef } = usePopover(onFocusComposer)
  const pool = accounts.length > 0 ? accounts : [active]
  const alias = active.alias ?? '(unnamed)'
  return (
    <div ref={ref} className="composer-account-face relative shrink-0">
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
        <ComposerPopoverPanel panelRef={popoverRef} triggerRef={triggerRef} align="end">
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
        </ComposerPopoverPanel>
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
 * The context-donut popover BODY (the prototype's `ContextChip` popover,
 * Surfaces.jsx:497). Exported + pure (open-state-free) for headless coverage, like
 * {@link AccountSwitcherPanel}. Shows the real Context total from data already on
 * the wire.
 *
 * Uses the supplied `usage` directly for the headline, 76px aggregate ring,
 * pressure tone, and Compact-action escalation. Categories provide an estimated
 * breakdown underneath but do not override the headline or aggregate ring.
 */
export function ContextUsagePanel({
  usage,
  breakdown = null,
  autoCompact = null,
  liveContextWindow = null,
  runControls = null,
  onCompact,
}: {
  usage: ContextUsage
  /** Per-category occupancy, absent until the sidecar has produced one. */
  breakdown?: ContextBreakdownSnapshot | null
  autoCompact?: {
    enabled: boolean
    threshold: number | null
    warningThreshold?: number | null
  } | null
  liveContextWindow?: number | null
  runControls?: RunControlsSnapshot | null
  /**
   * Submits `/compact` for this session. Absent (and the row unrendered) when no
   * engine can take it: a preview pane, or a spawning, parked, or terminal
   * session (`canSendUntypedSubmit`; `parked` is deliberately non-terminal yet
   * has no process, so it is excluded too). It does NOT route through the
   * composer draft — see the handler in `App.tsx` for why.
   */
  onCompact?: () => void
}) {
  const { usedTokens, contextWindow } = usage
  // Null while nothing has reported the window, exactly as on the donut face.
  const percent = selectContextPercent(usage)
  // Context fullness, NOT account quota — the same ladder the donut face reads.
  const tone = pressureTone(percent ?? 0)
  const t = toneClasses(tone)
  const escalated = tone === 'warn' || tone === 'danger' ? tone : null
  const rows = selectBreakdownRows(breakdown)
  const resolvedAutoCompact = autoCompact ?? runControls?.autoCompact
  const resolvedLiveWindow = liveContextWindow ?? runControls?.model.contextWindow
  const capacity = selectContextCapacity(usage, resolvedAutoCompact, resolvedLiveWindow)

  const radius = 30
  const circumference = 2 * Math.PI * radius
  const clampedPercent = percent == null ? 0 : Math.min(100, Math.max(0, percent))
  const arcLength = (clampedPercent / 100) * circumference

  return (
    // ACCT-3: informational content only (no menu items) — `role="menu"`
    // asserted an arrow-navigable contract this panel never fulfilled.
    <div role="dialog" aria-label="Usage" className={`${POPOVER_PANEL_RIGHT} w-[268px]`}>
      {/* No bottom padding when the footer follows: the footer well brings its
        * own, and doubling them left the Free row floating well clear of the
        * seam. Without a footer the body owns the panel's bottom edge again. */}
      <div className={`px-3.5 pt-3 ${onCompact ? '' : 'pb-3.5'}`}>
        <div className="flex items-center justify-between">
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

        {/* 76px aggregate ring: neutral full-circle track, used arc, center percentage */}
        <div className="relative mx-auto my-1 h-[76px] w-[76px] shrink-0">
          <svg
            width="76"
            height="76"
            viewBox="0 0 76 76"
            className={`-rotate-90 ${t.text}`}
            aria-hidden
          >
            <circle
              cx="38"
              cy="38"
              r={radius}
              fill="none"
              stroke="light-dark(rgba(9,9,11,0.1), rgba(255,255,255,0.06))"
              strokeWidth="6"
            />
            {percent != null ? (
              <circle
                cx="38"
                cy="38"
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${arcLength} ${circumference}`}
              />
            ) : null}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {percent != null ? (
              <span className={`text-[16px] font-semibold tabular-nums ${t.text}`}>
                {percent}%
              </span>
            ) : null}
          </div>
        </div>

        {/* Estimated breakdown */}
        {rows.length > 0 ? (
          <div className="mt-2">
            <div className="mb-1 text-[11px] font-medium text-text-subtle">
              Estimated breakdown
            </div>
            <div className="flex flex-col gap-0.5">
              {rows.map(row => (
                <div
                  key={row.label}
                  className="-mx-1 flex items-center justify-between rounded px-1 py-[2.5px] transition-colors duration-100 hover:bg-white/5"
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <span
                      aria-hidden
                      className={`size-[7px] shrink-0 rounded-[2px] ${row.swatch}`}
                    />
                    {row.label}
                  </span>
                  <span className="text-[11px] tabular-nums text-text-subtle">
                    {fmtTokens(row.tokens)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Capacity rows */}
        {capacity ? (
          <div className="mt-1.5 border-t border-shell-seam pt-1">
            {capacity.kind === 'compact' ? (
              <>
                <div className="flex items-center justify-between py-[2px]">
                  <span className="text-[11px] text-text-subtle">Free before auto-compact</span>
                  <span className="text-[11px] tabular-nums text-text-subtle">
                    {fmtTokens(capacity.freeBeforeAutoCompact)}
                  </span>
                </div>
                <div className="flex items-center justify-between py-[2px]">
                  <span className="text-[11px] text-text-subtle">Reserved remaining</span>
                  <span className="text-[11px] tabular-nums text-text-subtle">
                    {fmtTokens(capacity.reservedRemaining)}
                  </span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between py-[2px]">
                <span className="text-[11px] text-text-subtle">Remaining capacity</span>
                <span className="text-[11px] tabular-nums text-text-subtle">
                  {fmtTokens(capacity.remaining)}
                </span>
              </div>
            )}
          </div>
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
            <ActionWarningIcon size={12} />
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

function TokenWarningChip({
  warning,
  faceProps,
}: {
  warning: TokenWarning
  faceProps?: ComposerFaceProps
}) {
  const { open, setOpen, ref, triggerRef, panelRef: popoverRef } = usePopover()
  const summary = warning.autoCompactEnabled
    ? `${warning.percentLeft}% until auto-compact`
    : 'Context low'
  const title = warning.autoCompactEnabled
    ? summary
    : `Context low, ${warning.percentLeft}% remaining`
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
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-tone-warn"
      >
        <ActionWarningIcon size={14} />
      </button>
      {open ? (
        <ComposerPopoverPanel panelRef={popoverRef} triggerRef={triggerRef} align="end" gap={10}>
        <div
          role="dialog"
          aria-label="Context"
          className="absolute bottom-full right-0 z-40 mb-2.5 w-[252px] rounded-xl border border-tone-warn/25 bg-surface-raised px-3.5 py-3 shadow-lg"
        >
          <div className="mb-1.5 flex items-center gap-[7px]">
            <span className="inline-flex text-tone-warn">
              <ActionWarningIcon size={13} />
            </span>
            <span className="text-[12.5px] font-semibold text-text-primary">
              {summary}
            </span>
          </div>
          <div className="text-[11.5px] leading-relaxed text-text-muted">
            {warning.autoCompactEnabled ? (
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
        </ComposerPopoverPanel>
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
  runControls,
}: {
  usage: ContextUsage
  breakdown: ContextBreakdownSnapshot | null
  onRequestBreakdown?: () => void
  onCompact?: () => void
  faceProps?: ComposerFaceProps
  runControls?: RunControlsSnapshot | null
}) {
  const { open, setOpen, close, ref, triggerRef, panelRef: popoverRef } = usePopover()
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
        <ComposerPopoverPanel panelRef={popoverRef} triggerRef={triggerRef} align="end">
        <ContextUsagePanel
          usage={usage}
          breakdown={breakdown}
          runControls={runControls}
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
        </ComposerPopoverPanel>
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
  readOnlyRunControls,
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
  workspaceBranch = null,
}: {
  attachDisabled: boolean
  onAttach: () => void
  /** The RESOLVED model this session runs; null before the snapshot → face omitted. */
  model: string | null
  /** Its product name, when one was reported. The read-only face shows this and
   * falls back to the id when the engine has no display name. */
  modelLabel?: string | null
  /** Effective effort for a read-only pane; null when no tier was reported. */
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
  /** Retained display data only. Unlike runControls, this never arms a setter. */
  readOnlyRunControls?: RunControlsSnapshot | null
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
  workspaceBranch?: WorkspaceBranchReadout | null
}) {
  const accountAlias = account?.alias ?? null
  const showAccount = account != null && accountAlias != null
  const anthropicAccountLabel =
    anthropicAccount?.alias ?? anthropicAccount?.email ?? null
  // Interactive switcher when the active account AND a switch handler are both
  // present; otherwise the read-only alias face.
  const accountInteractive = account != null && onSwitchAccount != null
  const tokenWarning = selectTokenWarning(
    contextUsage ?? null,
    runControls?.autoCompact,
  )

  // Feature #4 — roving tabindex across the faces (ARIA toolbar). The tab stop
  // follows the last-focused face; when nothing in the bar is focused it rests on
  // the first face ('attach', always rendered), so Tab from the field has a
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
  // the popover's own machinery (usePopover: selected-item focus + Escape-to-close;
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
        // selected-item focus. Faces without a popover (no aria-haspopup) ignore it.
        if (current.getAttribute('aria-haspopup')) {
          event.preventDefault()
          current.click()
        }
        return
      case 'Escape':
        // Informational dialogs keep focus on their trigger. Their open
        // popover owns dismissal before Escape can leave the toolbar.
        if (current.getAttribute('aria-expanded') === 'true') return
        event.preventDefault()
        exitToComposer()
        return
      default:
    }
  }

  // Leaving the trigger row resets the next Tab entry. A menu selection returns
  // to its trigger, whose onFocus restores that face as the active tab stop.
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
      className="composer-actions mt-3 flex items-center gap-[7px] px-1"
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
          className="-translate-y-px"
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

      {/* Run settings share one face; the account cluster stays at the right edge. */}
      <div className="composer-controls flex min-w-0 flex-1 items-center gap-[7px]">
        <RunControl
          model={model}
          modelLabel={modelLabel}
          reasoningEffort={reasoningEffort}
          fastMode={fastMode}
          snapshot={runControls}
          readOnlySnapshot={readOnlyRunControls}
          permissionContext={permissionContext}
          readOnlyMode={permissionModeReadOnly}
          onSetModel={onSetModel}
          onSetEffort={onSetEffort}
          onSetFast={onSetFast}
          onSetMode={onSetMode}
          faceProps={faceProps('run-controls')}
          onFocusComposer={onFocusComposer}
        />

        <div className="composer-account-controls ml-auto flex min-w-0 items-center gap-[7px]">
          <div className="composer-account-identity flex min-w-0 items-center gap-[7px]">
          {workspaceBranch ? (
            <span
              {...faceProps('git-branch')}
              className={`workspace-branch${workspaceBranch.previous ? ' workspace-branch-changed' : ''}`}
              aria-label={workspaceBranch.previous
                ? `Checkout is on ${workspaceBranch.name}. This chat was on ${workspaceBranch.previous}.`
                : `Git branch: ${workspaceBranch.name}`}
              title={workspaceBranch.previous ? undefined : workspaceBranch.name}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="18" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.7" />
                <path d="M6 8.4v7.2M18 9.4c0 4-3 4.6-6 5.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="workspace-branch-name">{workspaceBranch.name}</span>
              {workspaceBranch.previous ? <span className="workspace-branch-label shadow-lg" aria-hidden="true">Checkout is on {workspaceBranch.name}. This chat was on {workspaceBranch.previous}.</span> : null}
            </span>
          ) : null}
          <LidClosedCup faceProps={faceProps('lid-closed')} />
          {accountInteractive && account && onSwitchAccount ? (
            <AccountChip
              active={account}
              accounts={accounts ?? []}
              onSwitch={onSwitchAccount}
              onManage={onManageAccounts}
              onOpen={onOpenAccountSwitcher}
              faceProps={faceProps('account')}
              onFocusComposer={onFocusComposer}
            />
          ) : showAccount ? (
            /* The same status dot the interactive chip shows, for the same
             * reason: the alias text is deliberately never health-tinted, so the
             * dot is the ONLY thing carrying which account this is and how it is
             * doing. Dropping it on a detached pane silently removed the health
             * signal from the one state where the user cannot open the switcher
             * to go looking for it. */
            <span
              className={`composer-account-face ${RAIL_FACE} gap-1.5 text-text-muted`}
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
              className={`composer-account-face ${RAIL_FACE} text-text-muted`}
              title={`Active Anthropic account: ${anthropicAccountLabel} · ${ANTHROPIC_STATUS_LABEL[anthropicAccount.status]}`}
            >
              {anthropicAccountLabel}
            </span>
          ) : null}
          </div>
          {(accountInteractive || showAccount || anthropicAccountLabel) && contextUsage ? (
            <RailSep />
          ) : null}
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
              runControls={runControls}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
