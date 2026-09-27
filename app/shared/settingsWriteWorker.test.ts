import { expect, test } from 'bun:test'
import {
  parseSettingsWriteWorkerRequest,
  parseSettingsWriteWorkerResult,
  type SettingsWriteWorkerRequest,
  type SettingsWriteWorkerResult,
} from './settingsWriteWorker.js'

const request: SettingsWriteWorkerRequest = {
  type: 'settings-write',
  version: 1,
  verb: {
    type: 'settings.setValue',
    requestId: 'save-1',
    source: 'projectSettings',
    key: 'includeCoAuthoredBy',
    value: false,
  },
}

test('settings write boundary admits only an editable, scalar, closed request', () => {
  expect(parseSettingsWriteWorkerRequest(request)).toEqual(request)
  expect(parseSettingsWriteWorkerRequest({ ...request, cwd: '/somewhere' })).toBeNull()
  expect(parseSettingsWriteWorkerRequest({
    ...request,
    verb: { ...request.verb, source: 'policySettings' },
  })).toBeNull()
  expect(parseSettingsWriteWorkerRequest({
    ...request,
    verb: { ...request.verb, key: 'apiKey' },
  })).toBeNull()
  expect(parseSettingsWriteWorkerRequest({
    ...request,
    verb: { ...request.verb, value: 'false' },
  })).toBeNull()
  expect(parseSettingsWriteWorkerRequest({
    ...request,
    verb: { ...request.verb, apiKey: 'secret' },
  })).toBeNull()
})

test('settings write result rejects contradictory or extra fields', () => {
  const result: SettingsWriteWorkerResult = {
    type: 'settings-write-result',
    version: 1,
    requestId: 'save-1',
    ok: true,
    changed: true,
    message: 'Setting saved.',
  }
  expect(parseSettingsWriteWorkerResult(result)).toEqual(result)
  expect(parseSettingsWriteWorkerResult({ ...result, ok: false })).toBeNull()
  expect(parseSettingsWriteWorkerResult({ ...result, value: false })).toBeNull()
})
