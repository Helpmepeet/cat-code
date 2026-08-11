import type { ComposerFaceProps } from './ComposerActionsBar.js'
import { handleMenuRovingKeyDown, usePopover } from './composerPopover.js'
import {
  PERMISSION_SET_MODE_MODES,
  type PermissionContextSnapshot,
  type PermissionSetModeMode,
} from '../../shared/protocol.js'

/**
 * Compact permission-MODE chip for the composer actions row (P4-24 fidelity —
 * the prototype's `PermChip`, `Surfaces.jsx:302`, replacing the fat `<details>`
 * box). Shows the current engine mode tinted; a click opens a small upward
 * popover of the wire-allowlisted modes (`PERMISSION_SET_MODE_MODES`), presented
 * with truthful names for the engine's distinct classifier-backed `auto` and
 * restrictive `dontAsk` policies.
 * `bypassPermissions` is available directly in the mode picker. The sidecar
 * still owns the mode transition and the engine's own bypass killswitch remains
 * authoritative. Auto is disabled when the sidecar reports that its live
 * classifier gate is unavailable.
 * The popover shows ONLY the mode list (the prototype's `PermChip`,
 * Surfaces.jsx:338-363) — NOT the Always-allow/deny/ask rules, which the
 * prototype relegates to a separate "Manage rules" surface (a future desktop
 * page, not this popover). The renderer never authors rules (T6b) — it only
 * selects a mode via `onSetMode` → `permission.setMode`.
 */
// `label` is the SHORT name on the composer face; `title` is the fuller name in
// the picker row (the prototype's `short`/`title` split, Surfaces.jsx PERM_MODES).
type ModeMeta = {
  label: string
  title: string
  desc: string
  toneText: string
  toneDot: string
}

// Static class maps (no interpolated `text-[…]` — the v4 dynamic-class trap).
// `satisfies Record<PermissionSetModeMode, …>` is the exhaustiveness tripwire:
// a new allowlisted mode fails to compile until it gets an entry here. Labels +
// descriptions mirror the prototype's mode picker (Surfaces.jsx PERM_MODES): the
// engine's `default` mode is presented as "Ask" ("confirm before each tool"),
// its friendlier name in the prototype (the engine's own title is "Default",
// `PermissionMode.ts:46` — the prototype is the design target here).
/** The rail's quiet read-only face geometry (ComposerActionsBar `RAIL_FACE`),
 * duplicated as a constant rather than imported to keep this chip standalone. */
const READ_ONLY_FACE =
  'inline-flex max-w-[170px] shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-[5px] py-[3px] text-[12.5px] font-medium'

const MODE_META = {
  default: {
    label: 'Ask',
    title: 'Ask permissions',
    desc: 'Confirm before each tool use',
    toneText: 'text-text-muted',
    toneDot: 'bg-text-subtle',
  },
  acceptEdits: {
    label: 'Accept edits',
    title: 'Accept edits',
    desc: 'Auto-accept edits, ask for commands',
    toneText: 'text-emerald-400',
    toneDot: 'bg-emerald-400',
  },
  plan: {
    label: 'Plan',
    title: 'Plan mode',
    desc: 'Research & plan only, no changes',
    toneText: 'text-sky-400',
    toneDot: 'bg-sky-400',
  },
  auto: {
    label: 'Auto',
    title: 'Auto mode',
    desc: 'Use the safety classifier for unapproved actions',
    toneText: 'text-accent',
    toneDot: 'bg-accent',
  },
  dontAsk: {
    label: "Don't ask",
    title: "Don't ask",
    desc: 'Deny anything that needs approval',
    toneText: 'text-red-400',
    toneDot: 'bg-red-400',
  },
  // The prototype's 5th mode. The sidecar owns the transition and the engine's
  // bypass killswitch remains the final authority.
  bypassPermissions: {
    label: 'Bypass',
    title: 'Bypass permissions',
    desc: 'Run everything without asking',
    toneText: 'text-amber-400',
    toneDot: 'bg-amber-400',
  },
} satisfies Record<PermissionSetModeMode, ModeMeta>

// The prototype's popover order (Surfaces.jsx PERM_MODES): Plan · Ask · Accept
// edits · then the skip-prompts modes.
const MODE_DISPLAY_ORDER = [
  'plan',
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const satisfies readonly PermissionSetModeMode[]

function isKnownMode(mode: string): mode is PermissionSetModeMode {
  return (PERMISSION_SET_MODE_MODES as readonly string[]).includes(mode)
}

export function PermissionModeChip({
  context,
  onSetMode,
  readOnlyMode = null,
  faceProps,
}: {
  context: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
  /** The mode a session with no live context is in, from its cached transcript
   * (a preview) or from the last one its engine reported before going away.
   * Display-only: there is no engine here to switch. */
  readOnlyMode?: string | null
  /** Feature #4 — roving-tabindex props from the composer action bar's toolbar
   * (data-composer-face + tabIndex + onFocus). Spread on the trigger so the chip
   * joins the arrow-key roving group; absent (standalone use) → an unmanaged face. */
  faceProps?: ComposerFaceProps
}) {
  // Feature #13 — the shared composer popover lifecycle (open flag +
  // outside-click/Escape dismiss + first-item focus on open + focus-restore to the
  // trigger via `close`), identical to the run-control chips. Previously this chip
  // had bespoke state with NO first-item focus and NO in-panel roving.
  const { open, setOpen, close, ref, triggerRef } = usePopover()

  const current =
    context && isKnownMode(context.mode) ? MODE_META[context.mode] : null

  // No live context, so nothing here may switch a mode. A session can still
  // KNOW its mode: a preview reads its cached transcript, and one that lost its
  // engine keeps the last mode that engine reported. Either way it renders as a
  // quiet read-only face, since the value may also be an engine-internal mode
  // the picker could not offer. With no source at all the mode was never
  // reported — and since every session HAS one, naming it would be a claim
  // about state this pane never read, so render nothing.
  if (!context) {
    if (!readOnlyMode) return null
    const meta = isKnownMode(readOnlyMode) ? MODE_META[readOnlyMode] : null
    const label = meta?.label ?? readOnlyMode
    return (
      <span
        className={`${READ_ONLY_FACE} ${meta?.toneText ?? 'text-text-muted'}`}
        title={`Permission mode: ${meta?.title ?? readOnlyMode}`}
      >
        {label}
      </span>
    )
  }

  return (
    <div ref={ref} className="relative shrink-0">
      {/* Borderless quiet face (the prototype's `ColumnChipFace`,
       * Surfaces.jsx:222): the mode's short label tinted by tone, no dot, no
       * pill — brightening to text-primary on hover like the rest of the rail. */}
      <button
        ref={triggerRef}
        {...faceProps}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${current?.label ?? context?.mode ?? 'unknown'}`}
        disabled={!context}
        onClick={() => setOpen(value => !value)}
        className={`inline-flex max-w-[170px] shrink-0 items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-[5px] py-[3px] text-[12.5px] font-medium transition-colors hover:text-text-primary disabled:opacity-50 ${current?.toneText ?? 'text-text-subtle'}`}
      >
        {current?.label ?? context?.mode ?? 'none'}
      </button>

      {open && context ? (
        <div
          role="menu"
          aria-label="Permission mode"
          onKeyDown={handleMenuRovingKeyDown}
          className="absolute bottom-full right-0 z-40 mb-2 w-60 rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
            Mode
          </div>
          {MODE_DISPLAY_ORDER.map(mode => {
            const meta = MODE_META[mode]
            const active = context.mode === mode
            const unavailable =
              mode === 'auto' && !context.permissionClassifierEnabled
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={unavailable}
                title={
                  mode === 'auto' && unavailable
                    ? 'Auto mode is unavailable for this model or has been disabled in settings.'
                    : undefined
                }
                onClick={() => {
                  onSetMode(mode)
                  close()
                }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
                  unavailable
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:bg-white/[0.02]'
                } ${active ? 'bg-white/[0.04]' : ''}`}
              >
                {/* Radio indicator (Surfaces.jsx:284-290): a tinted ring with a
                 * filled dot when active; the ring rides `currentColor`. */}
                <span
                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-current ${
                    active ? meta.toneText : 'text-text-ghost'
                  }`}
                  aria-hidden
                >
                  {active ? (
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${meta.toneDot}`}
                    />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[12.5px] ${
                      active
                        ? 'font-semibold text-text-primary'
                        : 'font-medium text-[#e4e4e7]'
                    }`}
                  >
                    {meta.title}
                  </span>
                  <span className="block text-[10.5px] text-text-subtle">
                    {meta.desc}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
