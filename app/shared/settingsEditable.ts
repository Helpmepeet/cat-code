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
  | {
      /**
       * A string chosen from a LIVE option set the sidecar captures at spawn and
       * carries on `SettingsSnapshot.availableOptions` (keyed by the setting
       * `key`). Unlike `enum`, the option set is genuinely dynamic (built-in +
       * user/project/plugin, e.g. output styles) so it cannot be a static list.
       * This engine-free pure validator only BOUNDS the string (type + length, a
       * T7 guard); the CLOSED membership check (value ∈ the captured live options)
       * is enforced at the sidecar, which holds the list — never in the renderer.
       */
      kind: 'dynamic-enum'
      maxLength: number
      default: string
    }

/**
 * The reserved `dynamic-enum` option meaning "no override in this file" — the
 * engine decides.
 *
 * Some engine keys are OPTIONAL and resolve at runtime rather than to a fixed
 * documented default (`model` is the first: `src/utils/settings/types.ts:388`
 * `z.string().optional()`, resolved per account/provider by
 * `getDefaultOptionForUser`, `src/utils/model/modelOptions.ts:56`, which is
 * itself a real option carrying `value: null`). A select over such a key needs a
 * row for that state, or picking a model becomes a one-way door with no way back
 * to the engine's choice.
 *
 * It is a TOKEN, never a value: the sidecar offers it as an available option and
 * REMOVES the key when it is chosen (`app/sidecar/settingsDomain.ts`), so this
 * string is never written to a settings file. Deliberately not the empty string
 * — `validateEditableSettingValue` rejects zero-length input (a T7 bound) and
 * that bound stays as it is.
 */
export const SETTINGS_ENGINE_DEFAULT = '__catcode.engineDefault__'

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
 * its true default. `outputStyle` is a `dynamic-enum` whose live options ride
 * `SettingsSnapshot.availableOptions` (the sidecar captures the real style
 * registry at spawn). Keybindings / IDE / LSP / default-model / accent-swatch /
 * code-theme+font remain DEFERRED (separate config file, live-status read-seams,
 * provider-routing, or no engine key) — see the P4-19 report §deferred.
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
    key: 'model',
    pane: 'model',
    label: 'Default model',
    description:
      'Model for sessions started afterwards. Leave it on the default to let Cat Code choose per account.',
    control: {
      kind: 'dynamic-enum',
      maxLength: 200,
      // The engine's own "no override" row, not a model name — see
      // SETTINGS_ENGINE_DEFAULT. `model` is optional in the schema
      // (`src/utils/settings/types.ts:388`) and the engine resolves an unset
      // value per account and provider, so there is no default string to mirror
      // here and naming one would make the row claim a choice nobody made.
      default: SETTINGS_ENGINE_DEFAULT,
    },
  },
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
  // `effortLevel` is deliberately NOT here (operator ruling, 2026-07-27).
  // Reasoning effort is a property of the MODEL, and this list has no model:
  // `modelSupportsEffort` (src/utils/effort.ts:25) is false for haiku and for
  // sonnet/opus outside 4-6, and `getSupportedEffortLevels` (:82) returns six
  // levels for gpt-5.6-sol/terra against the three this schema can persist
  // (types.ts:716 + `toPersistableEffort` :127). A fixed enum with a fixed
  // default therefore has to lie about at least one of: whether the knob
  // applies, which levels exist, and what the value is when unset (the real
  // fallback is `getDefaultEffortForModel` :322, which is per-model). The
  // model-aware control is the composer's run-control chip, which reads
  // `RunControlsSnapshot.effort` — built from those same engine functions
  // against the session's resolved model (app/sidecar/runControlsDomain.ts:431).
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
  {
    key: 'outputStyle',
    pane: 'theme',
    label: 'Output style',
    description:
      'System-prompt style for assistant responses. Options come from the live registry (built-in default/Explanatory/Learning plus any custom or plugin styles).',
    // `default` mirrors DEFAULT_OUTPUT_STYLE_NAME (src/constants/outputStyles.ts:39);
    // the option list is dynamic, so this is a dynamic-enum (bounded string here,
    // membership-checked at the sidecar against the captured registry).
    control: { kind: 'dynamic-enum', maxLength: 120, default: 'default' },
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
    case 'dynamic-enum':
      // Shape/length only. This module is engine-free and has no option list;
      // the closed membership check (value ∈ the captured live options) runs at
      // the sidecar in `applySettingsVerb`.
      if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > control.maxLength
      ) {
        return {
          ok: false,
          error: `${key} expects a non-empty string (≤ ${control.maxLength} chars)`,
        }
      }
      return { ok: true, value }
    default: {
      const never: never = control
      return { ok: false, error: `unhandled control: ${JSON.stringify(never)}` }
    }
  }
}
