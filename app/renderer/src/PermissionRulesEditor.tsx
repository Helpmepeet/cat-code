import { PERMISSION_SET_MODE_MODES } from '../../shared/protocol.js'
import type {
  PermissionContextSnapshot,
  PermissionSetModeMode,
} from '../../shared/protocol.js'

/**
 * Read-only permission rules/context surface (P2-4, adapts the prototype's
 * `PermissionRules.jsx` — decisions/PERMISSION-BOUNDARY.md §4).
 *
 * Read path: the C3 `permission.context` snapshot — the ENGINE's live
 * context, so settings-file and hook-applied rules show up (a renderer-side
 * reconstruction from update echoes would miss them). Not rendered before the
 * first snapshot arrives; a fresh snapshot supersedes everything local.
 *
 * Write paths, deliberately narrow:
 *   - mode switching via `permission.setMode` (C2 — the 4 wire-allowlisted
 *     modes; `bypassPermissions`/`auto` are not offered and would be rejected
 *     at the sidecar anyway);
 *   - "always allow" lives on the QUEUE cards as C1 suggestion selection.
 * General rule CRUD is NOT enabled at this boundary — adding allow rules or
 * removing deny rules is exactly T6b's escalation.
 */
export function PermissionRulesEditor({
  context,
  onSetMode,
}: {
  context: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
}) {
  if (!context) {
    return (
      <p className="text-xs text-text-subtle">
        Waiting for the engine's permission context…
      </p>
    )
  }

  return (
    <div aria-label="Permission rules" className="flex flex-col gap-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-text-muted">Mode:</span>
        {PERMISSION_SET_MODE_MODES.map(mode => (
          <button
            aria-pressed={context.mode === mode}
            className={
              context.mode === mode
                ? 'rounded bg-accent px-2 py-1 font-medium text-app-bg'
                : 'rounded border border-text-subtle px-2 py-1 text-text-primary'
            }
            key={mode}
            onClick={() => onSetMode(mode)}
            type="button"
          >
            {mode}
          </button>
        ))}
        {!PERMISSION_SET_MODE_MODES.includes(
          context.mode as PermissionSetModeMode,
        ) ? (
          <span className="font-mono text-text-muted">
            current: {context.mode}
          </span>
        ) : null}
      </div>

      <RuleGroup label="Always allow" rules={context.alwaysAllowRules} />
      <RuleGroup label="Always deny" rules={context.alwaysDenyRules} />
      <RuleGroup label="Always ask" rules={context.alwaysAskRules} />

      {context.additionalWorkingDirectories.length > 0 ? (
        <div>
          <h3 className="mb-1 text-text-muted">Additional directories</h3>
          <ul className="flex flex-col gap-0.5">
            {context.additionalWorkingDirectories.map(directory => (
              <li className="font-mono text-text-primary" key={directory.path}>
                {directory.path}{' '}
                <span className="text-text-subtle">({directory.source})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function RuleGroup({
  label,
  rules,
}: {
  label: string
  rules: Record<string, string[]>
}) {
  const entries = Object.entries(rules).filter(
    ([, ruleStrings]) => ruleStrings.length > 0,
  )
  if (entries.length === 0) {
    return (
      <div>
        <h3 className="mb-1 text-text-muted">{label}</h3>
        <p className="text-text-subtle">No rules.</p>
      </div>
    )
  }
  return (
    <div>
      <h3 className="mb-1 text-text-muted">{label}</h3>
      <ul className="flex flex-col gap-0.5">
        {entries.flatMap(([source, ruleStrings]) =>
          ruleStrings.map(rule => (
            <li className="font-mono text-text-primary" key={`${source}:${rule}`}>
              {rule} <span className="text-text-subtle">({source})</span>
            </li>
          )),
        )}
      </ul>
    </div>
  )
}
