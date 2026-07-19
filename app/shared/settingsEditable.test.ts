import { expect, test } from 'bun:test'
import {
  EDITABLE_SETTINGS_BY_KEY,
  validateEditableSettingValue,
} from './settingsEditable.js'

/* ── P4-19 dynamic-enum (output style) ──────────────────────────────────────── */

test('outputStyle is a dynamic-enum editor in the theme pane', () => {
  const spec = EDITABLE_SETTINGS_BY_KEY.get('outputStyle')
  expect(spec?.pane).toBe('theme')
  expect(spec?.control.kind).toBe('dynamic-enum')
  // The engine default (outputStyles.ts:39 DEFAULT_OUTPUT_STYLE_NAME).
  expect(spec?.control.kind === 'dynamic-enum' && spec.control.default).toBe(
    'default',
  )
})

test('dynamic-enum validator bounds the string but does NOT check membership', () => {
  // Any non-empty string within the length bound passes the pure (engine-free)
  // validator — the CLOSED membership check is the sidecar's job (it holds the
  // live option list). An unknown-but-bounded style name is accepted here.
  expect(validateEditableSettingValue('outputStyle', 'Explanatory')).toEqual({
    ok: true,
    value: 'Explanatory',
  })
  expect(validateEditableSettingValue('outputStyle', 'a-custom-style')).toEqual({
    ok: true,
    value: 'a-custom-style',
  })
})

test('dynamic-enum validator rejects a non-string, an empty string, and over-length', () => {
  expect(validateEditableSettingValue('outputStyle', true).ok).toBe(false)
  expect(validateEditableSettingValue('outputStyle', 42).ok).toBe(false)
  expect(validateEditableSettingValue('outputStyle', '').ok).toBe(false)
  const spec = EDITABLE_SETTINGS_BY_KEY.get('outputStyle')
  const maxLength =
    spec?.control.kind === 'dynamic-enum' ? spec.control.maxLength : 0
  expect(
    validateEditableSettingValue('outputStyle', 'x'.repeat(maxLength + 1)).ok,
  ).toBe(false)
  expect(validateEditableSettingValue('outputStyle', 'x'.repeat(maxLength)).ok).toBe(
    true,
  )
})

test('an unknown key is still rejected regardless of control kind', () => {
  expect(validateEditableSettingValue('notAKey', 'default').ok).toBe(false)
})
