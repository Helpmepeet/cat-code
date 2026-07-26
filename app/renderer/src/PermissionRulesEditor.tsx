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
  showModes = true,
}: {
  context: PermissionContextSnapshot | null
  onSetMode: (mode: PermissionSetModeMode) => void
  /** When false, render the read-only rules WITHOUT the mode buttons — the
   * `PermissionModeChip` owns mode switching and reuses this for the rules. */
  showModes?: boolean
}) {
  if (!context) {
    return (
      <p className="text-xs text-text-subtle">
        Waiting for the engine's permission context…
      </p>
    )
  }

  return (
    <div aria-label="Permission rules" className="flex flex-col gap-5 text-xs">
      <section aria-labelledby="permission-default-mode">
        <h3
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
          id="permission-default-mode"
        >
          Default mode
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-text-muted">Permission mode</span>
          {/* Read-only current-mode pill — a PURE display of the engine's resolved
           * `context.mode`, rendered UNCONDITIONALLY. It emits no set-mode verb and
           * is never a control, so T6b holds even in the Settings read-only pane
           * (`showModes={false}`); the interactive selector below is the only thing
           * that authors a mode, and it stays gated on `showModes`. */}
          <span
            aria-label={`Current permission mode: ${context.mode}`}
            className="rounded border border-shell-seam bg-surface-raised px-2 py-1 font-mono text-text-primary"
          >
            {context.mode}
          </span>
          {showModes
            ? PERMISSION_SET_MODE_MODES.map(mode => (
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
              ))
            : null}
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-lg border border-shell-seam bg-surface-raised/50 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">
                Managed-rules-only enforcement
              </span>
              <span className="rounded bg-shell-hover px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-subtle">
                policy
              </span>
            </div>
            <p className="mt-0.5 text-[11px] leading-4 text-text-subtle">
              Only managed rules load; user, project, local, and CLI rules are
              ignored.
            </p>
          </div>
          <ReadOnlySwitch
            label="Managed-rules-only enforcement"
            on={context.managedRulesOnly}
          />
        </div>
      </section>

      <section aria-labelledby="permission-rules-list">
        <h3
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
          id="permission-rules-list"
        >
          Allow / deny / ask rules
        </h3>
        <div className="flex flex-col gap-3">
          <RuleGroup
            behavior="allow"
            label="Always allow"
            metadata={context.ruleMetadata}
            rules={context.alwaysAllowRules}
          />
          <RuleGroup
            behavior="deny"
            label="Always deny"
            metadata={context.ruleMetadata}
            rules={context.alwaysDenyRules}
          />
          <RuleGroup
            behavior="ask"
            label="Always ask"
            metadata={context.ruleMetadata}
            rules={context.alwaysAskRules}
          />
        </div>
      </section>

      {context.additionalWorkingDirectories.length > 0 ? (
        <section>
          <h3 className="mb-1 text-text-muted">Additional directories</h3>
          <ul className="flex flex-col gap-0.5">
            {context.additionalWorkingDirectories.map(directory => (
              <li className="font-mono text-text-primary" key={directory.path}>
                {directory.path}{' '}
                <span className="text-text-subtle">({directory.source})</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="permission-classifier">
        <h3
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
          id="permission-classifier"
        >
          Classifier &amp; debugging
        </h3>
        <div className="flex items-center gap-3 rounded-lg border border-shell-seam bg-surface-raised/50 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <span className="font-medium text-text-primary">
              Permission classifier
            </span>
            <p className="mt-0.5 text-[11px] leading-4 text-text-subtle">
              Route uncertain requests through the engine classifier instead
              of always prompting.
            </p>
          </div>
          <ReadOnlySwitch
            label="Permission classifier"
            on={context.permissionClassifierEnabled}
          />
        </div>
      </section>
    </div>
  )
}

function RuleGroup({
  behavior,
  label,
  metadata,
  rules,
}: {
  behavior: 'allow' | 'deny' | 'ask'
  label: string
  metadata: PermissionContextSnapshot['ruleMetadata']
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
    <div className="overflow-hidden rounded-lg border border-shell-seam">
      <h4 className="border-b border-shell-seam bg-shell-hover/40 px-3 py-1.5 text-[11px] font-medium text-text-muted">
        {label}
      </h4>
      <ul className="divide-y divide-shell-seam/70">
        {entries.flatMap(([source, ruleStrings]) =>
          ruleStrings.map(rule => {
            const matchType =
              metadata.find(
                item =>
                  item.behavior === behavior &&
                  item.source === source &&
                  item.rule === rule,
              )?.matchType ?? 'exact'
            return (
              <li
                className="flex items-center gap-2 px-3 py-2"
                key={`${source}:${rule}`}
              >
                <code className="min-w-0 flex-1 truncate font-mono text-text-primary">
                  {rule}
                </code>
                <span className="shrink-0 font-mono text-[9.5px] text-text-faint">
                  {matchType}
                </span>
                <span className="shrink-0 rounded bg-shell-hover px-1.5 py-0.5 text-[9px] text-text-subtle">
                  {source}
                </span>
              </li>
            )
          }),
        )}
      </ul>
    </div>
  )
}

function ReadOnlySwitch({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      aria-label={`${label}: ${on ? 'on' : 'off'}, managed read-only`}
      aria-disabled="true"
      className={
        'relative h-5 w-9 shrink-0 rounded-full border opacity-70 ' +
        (on
          ? 'border-accent/50 bg-accent/30'
          : 'border-text-subtle/50 bg-shell-hover')
      }
      role="switch"
      aria-checked={on}
    >
      <span
        className={
          'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-transform ' +
          (on
            ? 'translate-x-[18px] bg-accent'
            : 'translate-x-0.5 bg-text-subtle')
        }
      />
    </span>
  )
}
