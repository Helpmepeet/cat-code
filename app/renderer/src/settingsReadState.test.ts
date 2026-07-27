import { expect, test } from 'bun:test'
import type { SettingsSnapshot } from '../../shared/protocol.js'
import {
  SETTINGS_UNREAD_NOTE,
  selectSettingsReadState,
  settingsWereRead,
} from './settingsReadState.js'

const EMPTY_BUT_READ: SettingsSnapshot = {
  layers: [],
  resolved: [],
  policyOrigin: null,
  editableValues: [],
}

// The distinction the whole surface depends on: a snapshot that arrived and
// contained nothing is a real answer; no snapshot is not an answer at all.
test('an empty-but-read snapshot is read, not unread', () => {
  expect(selectSettingsReadState(EMPTY_BUT_READ)).toBe('read')
  expect(settingsWereRead(EMPTY_BUT_READ)).toBe(true)
})

test('a null snapshot is unread — nothing may be asserted from it', () => {
  expect(selectSettingsReadState(null)).toBe('unread')
  expect(settingsWereRead(null)).toBe(false)
})

// Panes reached this state by rendering a "waiting" message that could never
// resolve; the shared copy must not reintroduce that.
test('the shared unread note does not promise that anything is arriving', () => {
  expect(SETTINGS_UNREAD_NOTE.toLowerCase()).not.toContain('waiting')
  expect(SETTINGS_UNREAD_NOTE.toLowerCase()).not.toContain('loading')
  expect(SETTINGS_UNREAD_NOTE).toContain('No session is open')
})
