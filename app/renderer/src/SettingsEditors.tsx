/**
 * Settings core value-editors — the renderer→engine settings WRITE path. Toggle
 * / select / validated-int controls bound to REAL settings keys, rebuilt in
 * TS/Tailwind from the prototype's `Settings.jsx` Sw* controls (port zero code,
 * no inline style). Every editor is driven by the canonical `EDITABLE_SETTINGS`
 * spec (`app/shared/settingsEditable.ts`) — the same closed allowlist the
 * sidecar validates against — so the UI and the trust boundary can never
 * disagree on which keys/types exist.
 *
 * **Law 3 (settings-redesign spec §2).** The chosen SCOPE decides the write
 * target, period. `targetSourceFor` — which wrote back to whichever layer the
 * key happened to resolve at, so editing a value with a project override
 * silently landed in that project's file — is deleted. A pane is now told its
 * `layer` and every row in it writes there; the row's own provenance survives as
 * an annotation (`settingsScope.ts`), never as a redirect.
 *
 * Because the target is a property of the pane rather than of a row, it is
 * stated ONCE above the controls, before any edit, instead of being disclosed
 * per row after the fact.
 *
 * Provenance + policy come from the read-seam (`settings.snapshot`): a managed
 * key renders disabled with the `ManagedBadge`; a flag-sourced key is
 * non-editable. What a row may DISPLAY is decided by `selectSettingsRow`, which
 * refuses to state a value this scope's files have not been read for — see its
 * `unreadable` case.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import type {
  EditableSettingPane,
  EditableSettingSource,
  EditableSettingSpec,
  EditableSettingValue,
  SettingsWriteValue,
} from '../../shared/settingsEditable.js'
import {
  validateEditableSettingValue,
} from '../../shared/settingsEditable.js'
import { Field, PaneSection } from './SettingsField.js'
import {
  SETTINGS_UNKNOWN_VALUE,
  settingsUnreadNote,
} from './settingsReadState.js'
import {
  selectSettingsReset,
  selectSettingsRow,
  settingsRowCommitsUnchanged,
  settingsRowNote,
  settingsWriteTargetNote,
  type SettingsProjectEngine,
  type SettingsRowModel,
} from './settingsScope.js'
import { selectAvailableOptions, selectLayerOrigin } from './settingsState.js'
import { settingsPaneSpecs } from './settingsEditorModel.js'

export type SettingWriteInput = {
  source: EditableSettingSource
  key: string
  /** A scalar to write, or `null` to REMOVE the key from `source` (P4-41 reset).
   * The sidecar tells the two apart structurally; see `SettingsWriteValue`. */
  value: SettingsWriteValue
}

/**
 * Keys the redesign removed from the UI (spec §5). Each stays reachable through
 * the settings file itself, whose path every scope names — the point of the
 * escape hatch is that "this setting doesn't merit a control" is a cheap
 * decision rather than a cut.
 *
 *  - `includeCoAuthoredBy` is marked *deprecated* in the engine schema in favour
 *    of `attribution` (`src/utils/settings/types.ts:372-378`); shipping the
 *    deprecated control alongside its replacement is what §5 rules out. The
 *    replacement is not rendered yet because it is not in the shared write
 *    allowlist, and growing that allowlist is a per-key sidecar review.
 *  - `spinnerTipsEnabled` / `terminalTitleFromRename` are terminal-presentation
 *    keys (an Ink spinner, a terminal tab title) with no desktop meaning.
 *  - `effortLevel` is model-dependent and this page has no model (operator
 *    ruling, 2026-07-27). The reasoning behind the removal, and the pointer to
 *    the model-aware control that replaces it, are at its former position in
 *    `app/shared/settingsEditable.ts`.
 */
/**
 * Renders every core value-editor for one pane, in one scope.
 *
 * `layer` is the scope's write target (Law 3). `engine` is `absent` when the
 * chosen project has no running session, in which case its files were never
 * read and the pane states that instead of showing another project's values.
 */
export function SettingsPane({
  pane,
  title,
  snapshot,
  onWrite,
  layer,
  engine = 'live',
  noEngineNote,
  sessionOpen = false,
}: {
  pane: EditableSettingPane
  title?: string
  snapshot: SettingsSnapshot | null
  onWrite: (input: SettingWriteInput) => void
  layer: EditableSettingSource
  engine?: SettingsProjectEngine
  /** Names the project that has no engine; falls back to a generic sentence. */
  noEngineNote?: string
  /** Whether a session is attached, so the unread sentence can stop claiming
   * none is (`settingsReadState.ts`). */
  sessionOpen?: boolean
}) {
  const specs = settingsPaneSpecs(pane)
  const unavailable =
    engine === 'absent'
      ? (noEngineNote ??
        'No engine is running in this project, so its settings files have not been read.')
      : snapshot
        ? null
        : settingsUnreadNote(sessionOpen, 'Open a session to read and edit them.')

  return (
    <PaneSection title={title}>
      {/* Law 3, before the edit: one destination for every row below. Stated
       * only when a write could actually land — an unread pane promises
       * nothing. */}
      {unavailable ? (
        <p className="mb-3 text-[12px] leading-4 text-text-subtle">
          {unavailable}
        </p>
      ) : (
        <p className="mb-3 text-[12px] leading-4 text-text-muted">
          {settingsWriteTargetNote(layer, selectLayerOrigin(snapshot, layer))}
        </p>
      )}
      {specs.map(spec => (
        <SettingEditor
          engine={engine}
          key={spec.key}
          layer={layer}
          onWrite={onWrite}
          sessionOpen={sessionOpen}
          snapshot={snapshot}
          spec={spec}
        />
      ))}
    </PaneSection>
  )
}

function SettingEditor({
  spec,
  snapshot,
  onWrite,
  layer,
  engine,
  sessionOpen,
}: {
  spec: EditableSettingSpec
  snapshot: SettingsSnapshot | null
  onWrite: (input: SettingWriteInput) => void
  layer: EditableSettingSource
  engine: SettingsProjectEngine
  sessionOpen: boolean
}) {
  const row = selectSettingsRow({
    snapshot,
    key: spec.key,
    layer,
    engine,
    sessionOpen,
  })
  const managed = row.annotation.kind === 'enforced'
  const write = (value: EditableSettingValue) => {
    if (!row.writeTarget) return
    onWrite({ source: row.writeTarget, key: spec.key, value })
  }

  // P4-41 — reset REMOVES the key from this scope's file, rather than writing the
  // built-in default back the way the prototype's mock does. One selector decides
  // both whether the affordance exists and what it sends, so they cannot drift.
  const reset = selectSettingsReset(row, spec.key)

  // The badge names the layer the value actually resolves at — provenance stays
  // an annotation on the row and never structures the page (spec §2).
  const badgeSource =
    row.read.kind === 'set'
      ? row.read.source
      : row.read.kind === 'unreadable'
        ? (row.read.by ?? undefined)
        : undefined
  // The tooltip must name the file the BADGE names. Taking it from the
  // annotation instead put the overriding layer's path under a badge reading
  // "User" the moment an overridden row could show the user's own value.
  const badgeOrigin = badgeSource ? selectLayerOrigin(snapshot, badgeSource) : null
  const note = settingsRowNote(row)

  return (
    <Field
      desc={spec.description}
      editable={!managed}
      label={spec.label}
      managed={managed}
      modified={reset !== null}
      onReset={reset ? () => onWrite(reset) : undefined}
      origin={badgeOrigin}
      source={badgeSource}
    >
      <SettingControl
        engineKey={spec.key}
        onWrite={write}
        row={row}
        snapshot={snapshot}
        spec={spec}
      />
      {note ? (
        <span className="block max-w-[240px] text-right text-[10.5px] leading-tight text-text-subtle">
          {note}
        </span>
      ) : null}
    </Field>
  )
}

/**
 * The control, or an honest non-control.
 *
 * A row whose value this scope has NOT read renders no control at all — not a
 * disabled one at a guessed value. That is the `settingsReadState.ts` rule taken
 * one step further: a disabled toggle still draws a position, and a position is
 * a claim about the operator's file.
 */
function SettingControl({
  spec,
  snapshot,
  row,
  onWrite,
  engineKey,
}: {
  spec: EditableSettingSpec
  snapshot: SettingsSnapshot | null
  row: SettingsRowModel
  onWrite: (value: EditableSettingValue) => void
  engineKey: string
}) {
  if (row.read.kind !== 'set' && row.read.kind !== 'unset') {
    return (
      <span className="font-mono text-[12.5px] text-text-subtle">
        {SETTINGS_UNKNOWN_VALUE}
      </span>
    )
  }
  const current = row.read.kind === 'set' ? row.read.value : null
  const disabled = row.writeTarget === null
  // An UNSET row displays the built-in default, which is not a value anyone's
  // file holds. So "same as what is displayed" is not "already saved" here, and
  // the controls must be able to commit it: `IntField`'s no-change guard is
  // lifted, and a select gets an explicit button because re-picking the option
  // that is already selected fires no `change` event at all.
  const pinnable = settingsRowCommitsUnchanged(row)

  const control = spec.control
  if (control.kind === 'boolean') {
    const value = typeof current === 'boolean' ? current : control.default
    return (
      <ToggleSwitch
        disabled={disabled}
        label={spec.label}
        onChange={next => onWrite(next)}
        value={value}
      />
    )
  }
  if (control.kind === 'enum') {
    const value =
      typeof current === 'string' && control.options.includes(current)
        ? current
        : control.default
    return (
      <SaveableSelect
        disabled={disabled}
        label={spec.label}
        onChange={next => onWrite(next)}
        optionLabels={control.optionLabels}
        options={control.options}
        showSave={pinnable}
        value={value}
      />
    )
  }
  if (control.kind === 'dynamic-enum') {
    // Options are engine truth from the snapshot (captured at spawn). If the
    // on-disk value is not in the live set (e.g. a style whose dir was removed)
    // still show it, so the field reflects truth. No live options ⇒ disabled.
    const available = selectAvailableOptions(snapshot, spec.key)
    const value = typeof current === 'string' ? current : control.default
    const optionValues = available.map(option => option.value)
    const options = optionValues.includes(value)
      ? optionValues
      : [value, ...optionValues]
    const optionLabels: Record<string, string> = {}
    for (const option of available) optionLabels[option.value] = option.label
    return (
      <SaveableSelect
        disabled={disabled || available.length === 0}
        label={spec.label}
        onChange={next => onWrite(next)}
        optionLabels={optionLabels}
        options={options}
        showSave={pinnable && available.length > 0}
        value={value}
      />
    )
  }
  const value = typeof current === 'number' ? current : control.default
  return (
    <IntField
      commitUnchanged={pinnable}
      disabled={disabled}
      keyName={engineKey}
      label={spec.label}
      onCommit={next => onWrite(next)}
      value={value}
    />
  )
}

/* ── controls ─────────────────────────────────────────────────────────────── */

function ToggleSwitch({
  value,
  onChange,
  disabled,
  label,
}: {
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      aria-checked={value}
      aria-label={label}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        value ? 'bg-accent' : 'bg-white/10'
      }`}
      disabled={disabled}
      onClick={() => onChange(!value)}
      role="switch"
      type="button"
    >
      <span
        className={`inline-block h-[16px] w-[16px] rounded-full shadow-sm transition-transform ${
          value ? 'bg-app-bg translate-x-[18px]' : 'bg-text-subtle translate-x-[3px]'
        }`}
      />
    </button>
  )
}

/** Exported so the app-local editors (`SettingsShell.tsx`'s This-app scope) wear
 * the same select as every engine-backed one. */
export function SelectControl({
  value,
  options,
  optionLabels,
  onChange,
  disabled,
  label,
}: {
  value: string
  options: readonly string[]
  optionLabels?: Readonly<Record<string, string>>
  onChange: (next: string) => void
  disabled?: boolean
  label: string
}) {
  return (
    <select
      aria-label={label}
      className="min-w-[128px] rounded-lg border border-shell-seam bg-shell-hover px-2.5 py-1.5 text-[12.5px] text-text-primary outline-none transition-colors focus:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      value={value}
    >
      {options.map(option => (
        <option key={option} value={option}>
          {optionLabels?.[option] ?? option}
        </option>
      ))}
    </select>
  )
}

/**
 * A select plus, for an UNSET row only, a button that saves the option already
 * showing.
 *
 * Without it that value is unreachable: a `<select>` fires `change` only on a
 * DIFFERENT option, so "keep this setting at what it is now, in my own file, so
 * a later change elsewhere cannot move it" could not be expressed at all — the
 * operator picked the option, nothing happened, and the row went on saying the
 * built-in default applies.
 */
function SaveableSelect({
  value,
  options,
  optionLabels,
  onChange,
  disabled,
  label,
  showSave,
}: {
  value: string
  options: readonly string[]
  optionLabels?: Readonly<Record<string, string>>
  onChange: (next: string) => void
  disabled?: boolean
  label: string
  showSave: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <SelectControl
        disabled={disabled}
        label={label}
        onChange={onChange}
        optionLabels={optionLabels}
        options={options}
        value={value}
      />
      {showSave ? (
        <button
          aria-label={`Save ${label}`}
          className="shrink-0 rounded-lg border border-shell-seam px-2.5 py-1.5 text-[11.5px] text-text-muted transition-colors hover:bg-shell-hover"
          onClick={() => onChange(value)}
          type="button"
        >
          Save
        </button>
      ) : null}
    </div>
  )
}

/**
 * A validated integer field. Local edit state so an in-progress / invalid entry
 * shows the inline error and is NOT written; a valid value commits on blur or
 * Enter.
 */
function IntField({
  value,
  onCommit,
  disabled,
  label,
  keyName,
  commitUnchanged = false,
}: {
  value: number
  onCommit: (next: number) => void
  disabled?: boolean
  label: string
  keyName: string
  /** Send the value even when it equals what is displayed. True for an unset
   * row, whose displayed value is the built-in default rather than a saved one,
   * so re-typing it IS a change to the file. */
  commitUnchanged?: boolean
}) {
  const [draft, setDraft] = useState<string>(String(value))
  const [error, setError] = useState<string | null>(null)

  // Reflect an externally-changed value (e.g. a re-emitted snapshot) when the
  // field is not being edited.
  const [lastValue, setLastValue] = useState<number>(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(String(value))
    setError(null)
  }

  const commit = () => {
    const parsed = Number(draft.trim())
    const validation = validateEditableSettingValue(keyName, parsed)
    if (!validation.ok) {
      setError(validation.error)
      return
    }
    setError(null)
    if (commitUnchanged || validation.value !== value) {
      onCommit(validation.value as number)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        aria-label={label}
        className={`w-[96px] rounded-lg border bg-shell-hover px-2.5 py-1.5 text-right text-[12.5px] text-text-primary outline-none transition-colors focus:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-tone-danger/50' : 'border-shell-seam'
        }`}
        disabled={disabled}
        inputMode="numeric"
        onBlur={commit}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        value={draft}
      />
      {error ? (
        <span className="text-[11px] text-tone-danger">{error}</span>
      ) : null}
    </div>
  )
}
