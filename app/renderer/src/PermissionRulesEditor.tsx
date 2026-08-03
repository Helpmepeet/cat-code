import { PERMISSION_SET_MODE_MODES } from '../../shared/protocol.js'
import type {
  PermissionContextSnapshot,
  PermissionSetModeMode,
  SettingsSnapshot,
} from '../../shared/protocol.js'
import { SourceBadge } from './SettingsField.js'
import { settingsUnreadNote } from './settingsReadState.js'

/**
 * Human names for the engine's mode keys. `PermissionModeChip` renders its own
 * copy of these labels an inch away, so printing `dontAsk` / `acceptEdits` /
 * `bypassPermissions` here put two vocabularies for one thing on one screen.
 * Duplicated rather than imported because that chip's table is not exported and
 * belongs to another surface.
 */
const MODE_LABEL: Record<string, string> = {
  default: 'Ask',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass',
}

function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode
}

/**
 * Human names for where a rule or directory came from. Wider than the settings
 * layers: the engine's permission sources also include runtime origins
 * (`src/types/permissions.ts:54-62`) that no settings file can produce.
 */
const RULE_SOURCE_LABEL: Record<string, string> = {
  userSettings: 'your defaults',
  projectSettings: 'this project',
  localSettings: 'private to you',
  flagSettings: 'a launch flag',
  policySettings: 'organization policy',
  cliArg: 'a launch flag',
  command: 'a command',
  session: 'this session',
}

function ruleSourceLabel(source: string): string {
  return RULE_SOURCE_LABEL[source] ?? source
}

/** How a rule is matched, in words rather than the engine's own token. */
const MATCH_TYPE_LABEL: Record<string, string> = {
  exact: 'exact match',
  prefix: 'starts with',
  wildcard: 'pattern',
}

/**
 * Read-only permission rules/context surface (P2-4, adapts the prototype's
 * `PermissionRules.jsx` — decisions/PERMISSION-BOUNDARY.md §4).
 *
 * TWO read paths, on purpose (CC-13) — the split is by what the data IS, not by
 * convenience:
 *
 *  1. `defaultMode` — the persisted `permissions.defaultMode` SETTING, from the
 *     P4-3 settings snapshot. A global, file-backed configuration value, so the
 *     section renders whether or not a session is attached. It has THREE states,
 *     not two: set, unset, and NOT YET READ. The snapshot is keyed by session
 *     (`settingsState.ts` `selectSettingsSnapshot`) because settings are
 *     resolved engine-side and there is no engine without a session
 *     (N-process), so with none attached the app has read no settings file at
 *     all. Collapsing that into "unset" would assert a fact about the
 *     operator's files that the app has not established — `settingsLoaded`
 *     keeps the two apart.
 *  2. `context` — the C3 `permission.context` snapshot: the ENGINE's live
 *     resolved context for ONE session. Everything else here is read from it,
 *     and must be, because it is a strict SUPERSET of the settings files that no
 *     settings-file read can reproduce: `cliArg`/`command` rules added at
 *     runtime, C1 always-allow suggestions applied mid-turn, PermissionRequest
 *     hooks applying rules, auto-mode dangerous-rule stripping
 *     (`sidecar/sessionController.ts` post-steps), and `managedRulesOnly`
 *     (`shouldAllowManagedPermissionRulesOnly()`), which can make user/project/
 *     local/CLI rules load NOT AT ALL — rendering settings-file rules there
 *     would actively misreport what is enforced. `ruleMetadata` likewise is
 *     derived at the sidecar with the engine's own rule parser (P4-34) so the
 *     renderer never learns the rule grammar.
 *
 * Hence: no session ⇒ the settings-backed section still renders, and the
 * session-derived half says so plainly instead of waiting forever.
 *
 * Write paths, deliberately narrow:
 *   - mode switching via `permission.setMode` (C2). Classifier-backed `auto`
 *     is offered only while the engine gate is available; `bypassPermissions`
 *     still requires its trusted launch opt-in. It sets THIS SESSION's mode only; it has no
 *     destination for `permissions.defaultMode` (PERMISSION-BOUNDARY.md §3),
 *     which is why the default is read-only here;
 *   - "always allow" lives on the QUEUE cards as C1 suggestion selection.
 * General rule CRUD is NOT enabled at this boundary — adding allow rules or
 * removing deny rules is exactly T6b's escalation.
 */
export function PermissionRulesEditor({
  context,
  defaultMode = null,
  settingsLoaded = true,
  onSetMode,
  showModes = true,
}: {
  context: PermissionContextSnapshot | null
  /**
   * The persisted `permissions.defaultMode` + the layer it resolved from
   * (`selectPermissionDefaultMode`). null means unset at every enabled layer —
   * but ONLY when `settingsLoaded`; otherwise nothing has been read yet.
   */
  defaultMode?: NonNullable<SettingsSnapshot['permissionDefaultMode']> | null
  /**
   * Whether a settings snapshot has arrived at all. False ⇒ no session is
   * attached, so no settings file has been read and a null `defaultMode` means
   * UNKNOWN, not unset. Defaults true so a caller that always has a snapshot
   * need not think about it.
   */
  settingsLoaded?: boolean
  onSetMode: (mode: PermissionSetModeMode) => void
  /** When false, render the read-only rules WITHOUT the mode buttons — the
   * `PermissionModeChip` owns mode switching and reuses this for the rules. */
  showModes?: boolean
}) {
  return (
    <div aria-label="Permission rules" className="flex flex-col gap-5 text-xs">
      <section aria-labelledby="permission-default-mode">
        <h3
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
          id="permission-default-mode"
        >
          Default mode
        </h3>
        {/* The SETTING, not any session's live mode: `permissions.defaultMode`
          * off the P4-3 settings snapshot. Read-only — the renderer never
          * authors a permission value (T6b), and `permission.setMode` has no
          * destination for the default (PERMISSION-BOUNDARY.md §3). */}
        <div className="flex items-center gap-2">
          <span className="text-text-muted">
            The mode new sessions start in
          </span>
          {defaultMode ? (
            <>
              <span
                aria-label={`Default permission mode: ${modeLabel(defaultMode.value)}`}
                className="rounded border border-shell-seam bg-surface-raised px-2 py-1 text-text-primary"
              >
                {modeLabel(defaultMode.value)}
              </span>
              <SourceBadge source={defaultMode.source} />
            </>
          ) : (
            <span
              aria-label={`Default permission mode: ${
                settingsLoaded ? 'not set' : 'unknown'
              }`}
              className="rounded border border-shell-seam bg-surface-raised px-2 py-1 font-mono text-text-subtle"
            >
              {settingsLoaded ? 'not set' : 'unknown'}
            </span>
          )}
        </div>
        {/* Only the LOADED case may speak about the settings files — with no
         * snapshot the app has read none, so claiming "not set in any settings
         * file" would be an assertion it cannot support. */}
        {defaultMode || !settingsLoaded ? null : (
          <p className="mt-1.5 text-[11px] leading-4 text-text-subtle">
            <code className="font-mono">permissions.defaultMode</code> is not set
            in any settings file, so the engine chooses each session's opening
            mode.
          </p>
        )}
        {settingsLoaded ? null : (
          <p className="mt-1.5 text-[11px] leading-4 text-text-subtle">
            {settingsUnreadNote(
              context !== null,
              'Open a session to see the saved default.',
            )}
          </p>
        )}
      </section>

      {context ? (
        <>
          <section aria-labelledby="permission-session-mode">
            <h3
              className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted"
              id="permission-session-mode"
            >
              This session
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-muted">Current permission mode</span>
              {/* Read-only current-mode pill — a PURE display of the engine's
               * resolved `context.mode`. It emits no set-mode verb and is never a
               * control, so T6b holds even in the Settings read-only pane
               * (`showModes={false}`); the interactive selector below is the only
               * thing that authors a mode, and it stays gated on `showModes`. */}
              <span
                aria-label={`Current permission mode: ${modeLabel(context.mode)}`}
                className="rounded border border-shell-seam bg-surface-raised px-2 py-1 text-text-primary"
              >
                {modeLabel(context.mode)}
              </span>
              {showModes
                ? PERMISSION_SET_MODE_MODES.map(mode => {
                    const unavailable =
                      (mode === 'auto' &&
                        !context.permissionClassifierEnabled) ||
                      (mode === 'bypassPermissions' &&
                        !context.isBypassPermissionsModeAvailable)
                    return (
                      <button
                        aria-pressed={context.mode === mode}
                        className={
                          context.mode === mode
                            ? 'rounded bg-accent px-2 py-1 font-medium text-app-bg'
                            : 'rounded border border-text-subtle px-2 py-1 text-text-primary disabled:cursor-not-allowed disabled:opacity-40'
                        }
                        disabled={unavailable}
                        key={mode}
                        onClick={() => onSetMode(mode)}
                        title={
                          mode === 'auto' && unavailable
                            ? 'Auto mode is unavailable for this model or has been disabled in settings.'
                            : mode === 'bypassPermissions' && unavailable
                              ? 'Bypass mode has to be turned on when Cat Code starts.'
                              : undefined
                        }
                        type="button"
                      >
                        {modeLabel(mode)}
                      </button>
                    )
                  })
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
                  Only managed rules load; user, project, local, and CLI rules
                  are ignored.
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
                  <li
                    className="font-mono text-text-primary"
                    key={directory.path}
                  >
                    {directory.path}{' '}
                    <span className="text-text-subtle">
                      (from {ruleSourceLabel(directory.source)})
                    </span>
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
        </>
      ) : (
        /* No attached session — a TERMINAL statement, not a "waiting…" that can
         * never resolve. The effective rules, this session's mode, and the
         * policy/classifier facts are engine-resolved per session (see the
         * header), so there is nothing global to fall back to for them. */
        <p className="text-text-subtle">
          No session is attached, so this window has no engine-resolved
          permission state to show: the effective allow / deny / ask rules, the
          current session mode, and the managed-policy and classifier state are
          all per-session. Open or select a session to see them.
        </p>
      )}
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
                <span className="shrink-0 text-[9.5px] text-text-faint">
                  {MATCH_TYPE_LABEL[matchType] ?? matchType}
                </span>
                <span className="shrink-0 rounded bg-shell-hover px-1.5 py-0.5 text-[9px] text-text-subtle">
                  {ruleSourceLabel(source)}
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
