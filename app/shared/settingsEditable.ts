/**
 * The closed editable-settings vocabulary (P4-19) — the SINGLE source of truth
 * for the first renderer→engine settings WRITE path.
 *
 * Both trust planes derive from this one list, so they can never drift apart
 * (the P4-21 drift-risk class; an app-plane list mirroring engine vocabulary
 * with nothing forcing agreement):
 *   - the SIDECAR (the trust boundary) derives its strict-key allowlist and its
 *     per-key value validator from `EDITABLE_SETTINGS`, and refuses to write any
 *     key/type/source outside it (SECURITY-MINIMUM §2 — validate at the sidecar,
 *     never trust the renderer);
 *   - the RENDERER derives the value-editor UI (control kind, options, label,
 *     default) from the same list.
 *
 * This module is ENGINE-FREE (plain data + pure functions, no `src/` import) so
 * it can live in `app/shared/` and be imported by renderer, sidecar, and main
 * alike. The KEYS below are a subset of the engine's real `SettingsSchema`
 * (`src/utils/settings/types.ts`); each `default` mirrors that schema's
 * documented default. The set is deliberately bounded to non-secret scalar
 * settings (booleans, small enums, one bounded int): no key here is ever
 * credential-bearing, so carrying their VALUES outbound (see
 * `SettingsSnapshot.editableValues`) leaks nothing — `secretGuard` still scans
 * every outbound frame as defense-in-depth.
 */

/** The three settings layers a UI edit may target (the engine's
 * `EditableSettingSource = Exclude<SettingSource, 'policySettings' |
 * 'flagSettings'>`, constants.ts:182). Policy/flag are read-only. */
export const EDITABLE_SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
] as const

export type EditableSettingSource = (typeof EDITABLE_SETTING_SOURCES)[number]

export function isEditableSettingSource(
  value: unknown,
): value is EditableSettingSource {
  return (
    typeof value === 'string' &&
    (EDITABLE_SETTING_SOURCES as readonly string[]).includes(value)
  )
}

/** A settings-shell category a core editor renders under. */
export type EditableSettingPane = 'general' | 'model' | 'privacy' | 'theme'

/** A single writable value crossing the wire — a non-secret scalar. */
export type EditableSettingValue = boolean | string | number

export type EditableSettingControl =
  | { kind: 'boolean'; default: boolean }
  | {
      kind: 'enum'
      options: readonly string[]
      optionLabels?: Readonly<Record<string, string>>
      default: string
    }
  | { kind: 'int'; min: number; max?: number; default: number }

export type EditableSettingSpec = {
  /** The exact `SettingsSchema` key this editor writes. */
  key: string
  pane: EditableSettingPane
  label: string
  description: string
  control: EditableSettingControl
}

/**
 * The core value-editors P4-19 wires. Each key is real (`SettingsSchema`); the
 * `default` mirrors the engine's documented default so an unset key renders at
 * its true default. Keybindings / IDE / LSP / model-list / output-style /
 * accent-swatch are DEFERRED (they need their own live-status read-seams or an
 * available-options seam) — see the P4-19 report §deferred.
 */
export const EDITABLE_SETTINGS: readonly EditableSettingSpec[] = [
  // ── General ──────────────────────────────────────────────────────────────
  {
    key: 'includeCoAuthoredBy',
    pane: 'general',
    label: 'Co-author attribution',
    description:
      "Add Claude's co-authored-by trailer to commits and PRs (default: on).",
    control: { kind: 'boolean', default: true },
  },
  {
    key: 'includeGitInstructions',
    pane: 'general',
    label: 'Git workflow instructions',
    description:
      "Include the built-in commit/PR workflow guidance in Claude's system prompt (default: on).",
    control: { kind: 'boolean', default: true },
  },
  {
    key: 'respectGitignore',
    pane: 'general',
    label: 'Respect .gitignore',
    description:
      'The file picker skips paths ignored by .gitignore (default: on).',
    control: { kind: 'boolean', default: true },
  },
  {
    key: 'terminalTitleFromRename',
    pane: 'general',
    label: 'Rename updates terminal title',
    description:
      '/rename writes the new topic to the terminal tab title (default: on).',
    control: { kind: 'boolean', default: true },
  },
  {
    key: 'autoUpdatesChannel',
    pane: 'general',
    label: 'Update channel',
    description: 'Release channel used for auto-updates.',
    control: {
      kind: 'enum',
      options: ['latest', 'stable'],
      optionLabels: { latest: 'Latest', stable: 'Stable' },
      default: 'latest',
    },
  },
  // ── Model & Inference ──────────────────────────────────────────────────────
  {
    key: 'alwaysThinkingEnabled',
    pane: 'model',
    label: 'Always-on thinking',
    description:
      'Enable extended thinking automatically for supported models (default: on).',
    control: { kind: 'boolean', default: true },
  },
  {
    key: 'fastMode',
    pane: 'model',
    label: 'Fast mode',
    description: 'Trade some reasoning depth for lower latency (default: off).',
    control: { kind: 'boolean', default: false },
  },
  {
    key: 'effortLevel',
    pane: 'model',
    label: 'Reasoning effort',
    description: 'Persisted effort level for supported models.',
    control: {
      kind: 'enum',
      options: ['low', 'medium', 'high'],
      optionLabels: { low: 'Low', medium: 'Medium', high: 'High' },
      default: 'medium',
    },
  },
  {
    key: 'reasoningDisplay',
    pane: 'model',
    label: 'Reasoning display',
    description: 'How reasoning from Codex/GPT models is shown.',
    control: {
      kind: 'enum',
      options: ['off', 'summary', 'raw'],
      optionLabels: { off: 'Off', summary: 'Summary', raw: 'Raw trace' },
      default: 'summary',
    },
  },
  {
    key: 'promptSuggestionEnabled',
    pane: 'model',
    label: 'Prompt suggestions',
    description: 'Offer suggested follow-up prompts (default: on).',
    control: { kind: 'boolean', default: true },
  },
  // ── Privacy ───────────────────────────────────────────────────────────────
  {
    key: 'cleanupPeriodDays',
    pane: 'privacy',
    label: 'Transcript retention (days)',
    description:
      'Days to retain chat transcripts (default: 30). 0 disables persistence entirely.',
    control: { kind: 'int', min: 0, max: 3650, default: 30 },
  },
  // ── Theme & Output ────────────────────────────────────────────────────────
  {
    key: 'syntaxHighlightingDisabled',
    pane: 'theme',
    label: 'Disable syntax highlighting',
    description: 'Turn off syntax highlighting in diffs (default: off).',
    control: { kind: 'boolean', default: false },
  },
  {
    key: 'spinnerTipsEnabled',
    pane: 'theme',
    label: 'Spinner tips',
    description: 'Show tips in the working spinner (default: on).',
    control: { kind: 'boolean', default: true },
  },
]

export const EDITABLE_SETTINGS_BY_KEY: ReadonlyMap<string, EditableSettingSpec> =
  new Map(EDITABLE_SETTINGS.map(spec => [spec.key, spec]))

/** The closed set of writable keys — the sidecar's strict-key allowlist source. */
export const EDITABLE_SETTING_KEYS: ReadonlySet<string> = new Set(
  EDITABLE_SETTINGS.map(spec => spec.key),
)

export type EditableSettingValidation =
  | { ok: true; value: EditableSettingValue }
  | { ok: false; error: string }

/**
 * Pure per-key value validator — the boundary check the SIDECAR runs before it
 * touches disk (and the renderer can reuse for optimistic UI). Returns the
 * type-narrowed value on success. Never trusts the caller's type: a boolean key
 * rejects a string, an enum key rejects an out-of-set value, an int key rejects
 * a non-integer or out-of-range number.
 */
export function validateEditableSettingValue(
  key: string,
  value: unknown,
): EditableSettingValidation {
  const spec = EDITABLE_SETTINGS_BY_KEY.get(key)
  if (!spec) {
    return { ok: false, error: `not an editable setting: ${key}` }
  }
  const control = spec.control
  switch (control.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${key} expects a boolean` }
      }
      return { ok: true, value }
    case 'enum':
      if (
        typeof value !== 'string' ||
        !control.options.includes(value)
      ) {
        return {
          ok: false,
          error: `${key} expects one of: ${control.options.join(', ')}`,
        }
      }
      return { ok: true, value }
    case 'int':
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < control.min ||
        (control.max !== undefined && value > control.max)
      ) {
        return {
          ok: false,
          error:
            `${key} expects an integer in [${control.min}, ` +
            `${control.max ?? '∞'}]`,
        }
      }
      return { ok: true, value }
    default: {
      const never: never = control
      return { ok: false, error: `unhandled control: ${JSON.stringify(never)}` }
    }
  }
}
