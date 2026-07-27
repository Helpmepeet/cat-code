/**
 * Settings core value-editors (P4-19) — the first renderer→engine settings
 * WRITE path. Toggle / select / validated-int controls bound to REAL settings
 * keys, rebuilt in TS/Tailwind from the prototype's `Settings.jsx` Sw* controls
 * (port zero code, no inline style). Every editor is driven by the canonical
 * `EDITABLE_SETTINGS` spec (`app/shared/settingsEditable.ts`) — the same closed
 * allowlist the sidecar validates against — so the UI and the trust boundary can
 * never disagree on which keys/types exist.
 *
 * Provenance + policy come from the P4-3 read-seam (`settings.snapshot`): a
 * managed key renders disabled with the `ManagedBadge`; a flag-sourced key is
 * non-editable (`resolution.editable === false`). The current VALUE comes from
 * the snapshot's bounded `editableValues`; an unset key shows the spec default.
 * The write itself never authors engine state — it names `{ source, key, value }`
 * and the sidecar re-validates + applies it under the cross-process lock.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import type {
  EditableSettingPane,
  EditableSettingSource,
  EditableSettingSpec,
  EditableSettingValue,
} from '../../shared/settingsEditable.js'
import {
  EDITABLE_SETTINGS,
  isEditableSettingSource,
  validateEditableSettingValue,
} from '../../shared/settingsEditable.js'
import { Field, PaneSection, SOURCE_LABEL } from './SettingsField.js'
import { SETTINGS_UNREAD_NOTE, settingsWereRead } from './settingsReadState.js'
import {
  selectAvailableOptions,
  selectEditableValue,
  selectLayerOrigin,
  selectSettingField,
} from './settingsState.js'

export type SettingWriteInput = {
  source: EditableSettingSource
  key: string
  value: EditableSettingValue
}

/**
 * Renders every core value-editor for one settings pane over the real snapshot.
 * `onWrite` sends the decided `{ source, key, value }` to the sidecar verb.
 */
export function SettingsPane({
  pane,
  title,
  snapshot,
  onWrite,
}: {
  pane: EditableSettingPane
  title?: string
  snapshot: SettingsSnapshot | null
  onWrite: (input: SettingWriteInput) => void
}) {
  const specs = EDITABLE_SETTINGS.filter(spec => spec.pane === pane)
  return (
    <PaneSection title={title}>
      {/* Say WHY every control below is inert. Disabling them without this is
       * only marginally better than the silent-discard it replaces. */}
      {settingsWereRead(snapshot) ? null : (
        <p className="mb-3 text-[12px] leading-4 text-text-subtle">
          {SETTINGS_UNREAD_NOTE} These controls stay read-only until a session
          is open.
        </p>
      )}
      {specs.map(spec => (
        <SettingEditor
          key={spec.key}
          onWrite={onWrite}
          snapshot={snapshot}
          spec={spec}
        />
      ))}
    </PaneSection>
  )
}

/** Which editable layer a write targets: keep an existing editable layer where
 * the value already resolves, otherwise default to the user layer. */
function targetSourceFor(
  snapshot: SettingsSnapshot | null,
  key: string,
): EditableSettingSource {
  const resolution = selectSettingField(snapshot, key)
  if (
    resolution &&
    resolution.editable &&
    isEditableSettingSource(resolution.source)
  ) {
    return resolution.source
  }
  return 'userSettings'
}

/**
 * Write-target disclosure text — the fix for "the row shows where a value
 * comes from, never where a click will land." Quiet/uncolored for the
 * unsurprising case (the operator's own user file); spelled out with the
 * real settings-file path for the surprising one (a project/local override,
 * which `targetSourceFor` keeps writing back into — invisible outside that
 * one project). Built from `SOURCE_LABEL` (the same vocabulary as the source
 * badge) so the two can never drift apart.
 */
function writeTargetLabel(target: EditableSettingSource): string {
  return target === 'userSettings'
    ? 'Writes to your settings'
    : `Writes to ${SOURCE_LABEL[target]} settings, not yours`
}

/** Static per-target classes (never interpolated) so Tailwind's scanner keeps
 * them; reuses the same `--color-source-*` tokens as the source badges. */
const WRITE_TARGET_CLASS: Record<EditableSettingSource, string> = {
  userSettings: 'text-text-subtle',
  projectSettings: 'text-source-project font-medium',
  localSettings: 'text-source-local font-medium',
}

function SettingEditor({
  spec,
  snapshot,
  onWrite,
}: {
  spec: EditableSettingSpec
  snapshot: SettingsSnapshot | null
  onWrite: (input: SettingWriteInput) => void
}) {
  const resolution = selectSettingField(snapshot, spec.key)
  const managed = resolution?.managed ?? false
  // A flag-sourced value cannot be edited from settings (P4-3 `editable` gate);
  // a managed value is locked. Everything else is editable.
  const editable = resolution?.editable ?? true
  // With no snapshot the write has nowhere to go — `sendSettingWrite` returns
  // early when there is no active session, so an enabled-looking control would
  // accept the click and discard it with no feedback of any kind. Unread is not
  // "editable by default" (`settingsReadState.ts`).
  const unread = !settingsWereRead(snapshot)
  const disabled = managed || !editable || unread
  const origin = resolution
    ? selectLayerOrigin(snapshot, resolution.source)
    : null
  const current = selectEditableValue(snapshot, spec.key)
  const source = resolution?.source

  const target = targetSourceFor(snapshot, spec.key)
  const write = (value: EditableSettingValue) => {
    onWrite({ source: target, key: spec.key, value })
  }

  const control = spec.control
  let controlNode: ReactNode = null
  // A dynamic-enum with no live options disables itself for a second reason
  // (below); `finalDisabled` tracks whichever control actually renders so the
  // write-target note (set after this block) never claims a destination for a
  // control that cannot in fact be clicked.
  let finalDisabled = disabled
  if (control.kind === 'boolean') {
    const value = typeof current === 'boolean' ? current : control.default
    controlNode = (
      <ToggleSwitch
        disabled={disabled}
        label={spec.label}
        onChange={next => write(next)}
        value={value}
      />
    )
  } else if (control.kind === 'enum') {
    const value =
      typeof current === 'string' && control.options.includes(current)
        ? current
        : control.default
    controlNode = (
      <SelectControl
        disabled={disabled}
        label={spec.label}
        onChange={next => write(next)}
        optionLabels={control.optionLabels}
        options={control.options}
        value={value}
      />
    )
  } else if (control.kind === 'dynamic-enum') {
    // Options are engine truth from the snapshot (captured at spawn); reuse the
    // same SelectControl grammar as the static enum. If the current on-disk value
    // is not in the live set (e.g. a style whose dir was removed), still show it
    // so the field reflects truth. No live options ⇒ render disabled (honest).
    const available = selectAvailableOptions(snapshot, spec.key)
    const value = typeof current === 'string' ? current : control.default
    const optionValues = available.map(option => option.value)
    const options = optionValues.includes(value)
      ? optionValues
      : [value, ...optionValues]
    const optionLabels: Record<string, string> = {}
    for (const option of available) optionLabels[option.value] = option.label
    finalDisabled = disabled || available.length === 0
    controlNode = (
      <SelectControl
        disabled={finalDisabled}
        label={spec.label}
        onChange={next => write(next)}
        optionLabels={optionLabels}
        options={options}
        value={value}
      />
    )
  } else {
    const value = typeof current === 'number' ? current : control.default
    controlNode = (
      <IntField
        disabled={disabled}
        keyName={spec.key}
        label={spec.label}
        onCommit={next => write(next)}
        value={value}
      />
    )
  }

  // Only assert a destination once a click could actually land somewhere:
  // `finalDisabled` folds in unread (per `settingsReadState.ts`), managed,
  // non-editable, AND (dynamic-enum) an empty live option set.
  const showWriteTarget = !finalDisabled
  const writeTargetOrigin =
    showWriteTarget && target !== 'userSettings'
      ? selectLayerOrigin(snapshot, target)
      : null

  return (
    <Field
      desc={spec.description}
      editable={editable}
      label={spec.label}
      managed={managed}
      origin={origin}
      source={source}
    >
      {controlNode}
      {showWriteTarget ? (
        <WriteTargetNote origin={writeTargetOrigin} target={target} />
      ) : null}
    </Field>
  )
}

/** The write-target line under a control — see `writeTargetLabel` for why
 * it exists. `origin` is only shown for a non-`userSettings` destination:
 * that is precisely the case with no other visible cue today. */
function WriteTargetNote({
  target,
  origin,
}: {
  target: EditableSettingSource
  origin: string | null
}) {
  const detail = target !== 'userSettings' && origin ? ` — ${origin}` : ''
  return (
    <span
      className={`block max-w-[200px] text-right text-[10.5px] leading-tight ${WRITE_TARGET_CLASS[target]}`}
    >
      {writeTargetLabel(target)}
      {detail}
    </span>
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

/** Exported so the one app-local editor (`TranscriptDisplaySection`,
 * `SettingsShell.tsx`) wears the same select as every engine-backed one. */
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
 * A validated integer field. Local edit state so an in-progress / invalid entry
 * shows the inline error (via the parent `Field`) and is NOT written; a valid
 * value commits on blur or Enter. Errors are surfaced through the control's own
 * message row (the parent Field's error slot is driven by the panel that owns
 * validation in the prototype; here the field owns it inline).
 */
function IntField({
  value,
  onCommit,
  disabled,
  label,
  keyName,
}: {
  value: number
  onCommit: (next: number) => void
  disabled?: boolean
  label: string
  keyName: string
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
    if (validation.value !== value) {
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
