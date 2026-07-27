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
 * with the prototype's five labels — Plan · Ask · Accept edits · Auto · Bypass
 * (engine keys `plan`/`default`/`acceptEdits`/`dontAsk`/`bypassPermissions`).
 * `bypassPermissions` is shown disabled unless the session was launched with the
 * trusted opt-in (`CATCODE_ALLOW_BYPASS=1` → `isBypassPermissionsModeAvailable`);
 * the sidecar re-checks that flag and rejects otherwise (C2, PERMISSION-BOUNDARY.md
 * §3). `auto` stays excluded — engine-internal, not renderer-addressable.
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
  // The engine mode is `dontAsk` (title "Don't Ask", PermissionMode.ts:73); the
  // prototype presents this 4th-by-escalation settable mode as "Auto mode". The
  // engine's own `auto` mode is INTERNAL (not user-settable, `permissions.ts:28`),
  // so `dontAsk` is what a picker can actually select here.
  dontAsk: {
    label: 'Auto',
    title: 'Auto mode',
    desc: 'Auto-accept edits and commands',
    toneText: 'text-accent',
    toneDot: 'bg-accent',
  },
  // The prototype's 5th mode. Selectable ONLY when the session was launched with
  // the trusted opt-in (`CATCODE_ALLOW_BYPASS=1` → context
  // `isBypassPermissionsModeAvailable`); otherwise the row is shown disabled for
  // visual parity, and the sidecar rejects a request anyway (defence in depth).
  bypassPermissions: {
    label: 'Bypass',
    title: 'Bypass permissions',
    desc: 'Run everything without asking',
    toneText: 'text-amber-400',
    toneDot: 'bg-amber-400',
  },
} satisfies Record<PermissionSetModeMode, ModeMeta>

// The prototype's popover order (Surfaces.jsx PERM_MODES): Plan · Ask · Accept
// edits · then the skip-prompts mode. The prototype's Bypass is the mode NOT on
// the desktop wire allowlist — it stays off until a trusted desktop grant surface
// exists (`sessionController.ts:133`).
const MODE_DISPLAY_ORDER = [
  'plan',
  'default',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
] as const satisfies readonly PermissionSetModeMode[]

function isKnownMode(mode: string): mode is PermissionSetModeMode {
  return (PERMISSION_SET_MODE_MODES as readonly string[]).includes(mode)
}

export function PermissionModeChip({
  context,
  onSetMode,
  faceProps,
}: {
  context: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
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
            // Bypass is grantable only when the trusted launch flag enabled it;
            // otherwise the row is shown (parity) but disabled with a hint.
            const unavailable =
              mode === 'bypassPermissions' &&
              !context.isBypassPermissionsModeAvailable
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={unavailable}
                title={
                  unavailable
                    ? 'Launch with CATCODE_ALLOW_BYPASS=1 to enable bypass mode'
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
                    active ? meta.toneText : 'text-[#3f3f46]'
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
