import { useEffect, useRef, useState } from 'react'
import {
  PERMISSION_SET_MODE_MODES,
  type PermissionContextSnapshot,
  type PermissionSetModeMode,
} from '../../shared/protocol.js'
import { PermissionRulesEditor } from './PermissionRulesEditor.js'

/**
 * Compact permission-MODE chip for the composer actions row (P4-24 fidelity —
 * the prototype's `PermChip`, `Surfaces.jsx:302`, replacing the fat `<details>`
 * box). Shows the current engine mode tinted; a click opens a small upward
 * popover of the FOUR wire-allowlisted modes (`PERMISSION_SET_MODE_MODES` — NOT
 * the prototype's invented `auto`/`bypass`, which the sidecar rejects, C2).
 * Read-only rules are tucked below the modes (the prototype relegates them to a
 * separate "Manage rules" surface). The renderer never authors rules (T6b) — it
 * only selects a mode via `onSetMode` → `permission.setMode`.
 */
type ModeMeta = { label: string; desc: string; toneText: string; toneDot: string }

// Static class maps (no interpolated `text-[…]` — the v4 dynamic-class trap).
// `satisfies Record<PermissionSetModeMode, …>` is the exhaustiveness tripwire:
// a new allowlisted mode fails to compile until it gets an entry here.
const MODE_META = {
  default: {
    label: 'Default',
    desc: 'Ask for permission per the active rules',
    toneText: 'text-text-muted',
    toneDot: 'bg-text-subtle',
  },
  acceptEdits: {
    label: 'Accept edits',
    desc: 'Auto-accept edits, ask for commands',
    toneText: 'text-emerald-400',
    toneDot: 'bg-emerald-400',
  },
  plan: {
    label: 'Plan',
    desc: 'Research & plan only, no changes',
    toneText: 'text-sky-400',
    toneDot: 'bg-sky-400',
  },
  dontAsk: {
    label: "Don't ask",
    desc: 'Run without asking for permission',
    toneText: 'text-amber-400',
    toneDot: 'bg-amber-400',
  },
} satisfies Record<PermissionSetModeMode, ModeMeta>

function isKnownMode(mode: string): mode is PermissionSetModeMode {
  return (PERMISSION_SET_MODE_MODES as readonly string[]).includes(mode)
}

export function PermissionModeChip({
  context,
  onSetMode,
}: {
  context: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false)
      }
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

  const current =
    context && isKnownMode(context.mode) ? MODE_META[context.mode] : null

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${current?.label ?? context?.mode ?? 'unknown'}`}
        disabled={!context}
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors hover:bg-white/5 disabled:opacity-50"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${current?.toneDot ?? 'bg-text-subtle'}`}
          aria-hidden
        />
        <span className={current?.toneText ?? 'text-text-subtle'}>
          {current?.label ?? context?.mode ?? '—'}
        </span>
      </button>

      {open && context ? (
        <div
          role="menu"
          aria-label="Permission mode"
          className="absolute bottom-full right-0 z-40 mb-2 w-60 rounded-lg border border-shell-seam bg-surface-raised p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
            Mode
          </div>
          {PERMISSION_SET_MODE_MODES.map(mode => {
            const meta = MODE_META[mode]
            const active = context.mode === mode
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSetMode(mode)
                  setOpen(false)
                }}
                className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 ${
                  active ? 'bg-white/[0.06]' : ''
                }`}
              >
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${meta.toneDot}`}
                  aria-hidden
                />
                <span className="min-w-0">
                  <span
                    className={`block text-xs ${active ? meta.toneText : 'text-text-primary'}`}
                  >
                    {meta.label}
                  </span>
                  <span className="block text-[10.5px] text-text-subtle">
                    {meta.desc}
                  </span>
                </span>
              </button>
            )
          })}
          <div className="mt-1 border-t border-shell-seam pt-1.5">
            <PermissionRulesEditor
              context={context}
              onSetMode={onSetMode}
              showModes={false}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
