import { Chip, ChipStrip } from './Chip.js'
import { ContextGauge } from './ContextGauge.js'
import type { ContextUsage } from './contextUsage.js'
import { PermissionModeChip } from './PermissionModeChip.js'
import { toneClasses, type Tone } from './tone.js'
import type {
  AccountStatus,
  PermissionContextSnapshot,
  PermissionSetModeMode,
} from '../../shared/protocol.js'

/**
 * P4-24 composer actions row — the desktop analog of the prototype's composer
 * `ChipStrip` (`Chat.jsx:1454` → `Surfaces.jsx:745`). Left→right: attach glyph ·
 * [model override] · permission MODE · —— · [active account] · context donut.
 *
 * REAL DATA ONLY (the prototype's chip values are mock fixtures — source wins):
 *  - MODEL chip renders ONLY when the engine reports a real per-session model
 *    OVERRIDE (`DiagnosticsSnapshot.mainLoopModel`, `protocol.ts:1335`, projected
 *    by `selectDiagnosticsSnapshot`). `null` = built-in default, which the engine
 *    deliberately does NOT turn into a fabricated label (`diagnosticsDomain`
 *    round-trips it as null, `diagnosticsDomain.test.ts:37`) — so the chip is
 *    absent, never a made-up model name.
 *  - ACCOUNT chip renders the real active alias (`selectActiveAccount`,
 *    `accountsState.ts:88`); the health dot is tinted from the real `status`.
 *    Read-only display (a switcher is P4-5 territory and would need an inbound
 *    verb this bar must not invent).
 *  - CONTEXT donut renders real result-frame usage (`selectContextUsage`) — absent
 *    until the first turn provides it, never a fabricated 0%.
 *
 * The prototype's EFFORT and fast/⚡ chips have NO live-session read seam (effort
 * exists on the wire only for agent DEFINITIONS, `protocol.ts:585`, not the live
 * main loop) and are intentionally omitted rather than fabricated.
 *
 * Tailwind discipline: no interpolated `text-[…]`; the account dot rides a
 * STATIC tone-class map (`toneClasses(...).dot`, the v4 dynamic-class trap).
 */
function accountStatusTone(status: AccountStatus['status']): Tone {
  switch (status) {
    case 'healthy':
      return 'good'
    case 'capped':
      return 'warn'
    case 'dead':
    case 'quarantined':
      return 'danger'
    default: {
      // Exhaustiveness tripwire: a new AccountStatus['status'] fails to compile
      // until it gets a tone here.
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export function ComposerActionsBar({
  attachDisabled,
  onAttach,
  modelOverride,
  permissionContext,
  onSetMode,
  account,
  contextUsage,
}: {
  attachDisabled: boolean
  onAttach: () => void
  /** Real per-session model OVERRIDE (`mainLoopModel`); null = built-in default → chip omitted. */
  modelOverride: string | null
  permissionContext: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
  /** The Codex pool's active account (real alias), or null before the snapshot arrives. */
  account: AccountStatus | null
  /** Real context-window fullness, or null before the first result frame. */
  contextUsage: ContextUsage | null
}) {
  const accountAlias = account?.alias ?? null
  return (
    <div className="mt-3 flex items-center gap-3">
      {/* Attach (§10 ❓): parity stub — a real file picker needs an engine
       * attachment capability that is NOT on the wire; the working attach path
       * today is a large paste, which the toast + title spell out. */}
      <button
        aria-label="Add attachment"
        title="Add attachment — paste a large block to attach it as a collapsed chip"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-text-subtle transition-colors hover:text-text-muted disabled:opacity-50"
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

      {/* Left rail: model override (real only) · permission MODE. The mode chip
       * always renders (disabled "—" until its context arrives), so the strip is
       * never empty; a null model drops with no dangling separator. */}
      <ChipStrip separated>
        {modelOverride ? (
          <Chip
            label="Model"
            value={modelOverride}
            title={`Session model override: ${modelOverride}`}
          />
        ) : null}
        <PermissionModeChip context={permissionContext} onSetMode={onSetMode} />
      </ChipStrip>

      <span className="flex-1" />

      {/* Right rail: active account (real alias + health dot) · context donut
       * (real usage). Both absent before their real data exists. */}
      <ChipStrip separated>
        {account && accountAlias ? (
          <Chip
            icon={
              <span
                className={`h-1.5 w-1.5 rounded-full ${toneClasses(accountStatusTone(account.status)).dot}`}
                aria-hidden
              />
            }
            label={accountAlias}
            title={`Active account: ${accountAlias} · ${account.status}`}
          />
        ) : null}
        {contextUsage ? <ContextGauge usage={contextUsage} /> : null}
      </ChipStrip>
    </div>
  )
}
