/** Closed, one-shot main ↔ settings-write worker contract. No cwd crosses stdin. */
import { MAX_TEXT_FIELD_CHARS } from './limits.js'
import { narrowExact, oneOf, isBoolean, isString } from './narrow.js'
import type { SettingsVerbMessage } from './protocol.js'
import {
  isEditableSettingSource,
  validateEditableSettingWrite,
} from './settingsEditable.js'

export const SETTINGS_WRITE_WORKER_VERSION = 1
export const MAX_SETTINGS_WRITE_WORKER_RECORD_BYTES = 16 * 1024

export type SettingsWriteWorkerRequest = {
  type: 'settings-write'
  version: 1
  verb: SettingsVerbMessage
}

export type SettingsWriteWorkerResult = {
  type: 'settings-write-result'
  version: 1
  requestId: string
  ok: boolean
  changed: boolean
  message: string
}

function boundedText(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= MAX_TEXT_FIELD_CHARS
}

function boundedMessage(value: unknown): value is string {
  return isString(value) && value.length <= MAX_TEXT_FIELD_CHARS
}

function parseVerb(value: unknown): SettingsVerbMessage | null {
  const row = narrowExact(value, {
    type: oneOf(['settings.setValue'] as const),
    requestId: boundedText,
    source: isEditableSettingSource,
    key: boundedText,
    value: (candidate: unknown): candidate is SettingsVerbMessage['value'] =>
      candidate === null || typeof candidate === 'boolean' ||
      (typeof candidate === 'string' && candidate.length <= MAX_TEXT_FIELD_CHARS) ||
      (typeof candidate === 'number' && Number.isFinite(candidate)),
  })
  if (!row || !validateEditableSettingWrite(row.key, row.value).ok) return null
  return row
}

/** Main calls this before spawning; the child repeats the same check. */
export function parseSettingsWriteWorkerRequest(value: unknown): SettingsWriteWorkerRequest | null {
  return narrowExact(value, {
    type: oneOf(['settings-write'] as const),
    version: oneOf([SETTINGS_WRITE_WORKER_VERSION] as const),
    verb: (candidate: unknown): candidate is SettingsVerbMessage => parseVerb(candidate) !== null,
  })
}

/** A response is accepted only if its full shape and outcome agree. */
export function parseSettingsWriteWorkerResult(value: unknown): SettingsWriteWorkerResult | null {
  const row = narrowExact(value, {
    type: oneOf(['settings-write-result'] as const),
    version: oneOf([SETTINGS_WRITE_WORKER_VERSION] as const),
    requestId: boundedText,
    ok: isBoolean,
    changed: isBoolean,
    message: boundedMessage,
  })
  if (!row || (row.changed && !row.ok)) return null
  return row
}
