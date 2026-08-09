import { expect, test } from 'bun:test'
import type { RemoteSettingsResultFrame } from '../../shared/protocol.js'
import { directConnectResultForRequest } from './remoteSettingsPageModel.js'

const SUCCESS: RemoteSettingsResultFrame = {
  kind: 'remoteSettings.result',
  protocolVersion: 1,
  sessionId: 'session-1',
  requestId: 'connect-1',
  verb: 'remoteSettings.directConnect',
  ok: true,
  message: 'Connected',
  directConnect: { sessionId: 'remote-1', wsUrl: 'ws://remote.example.test' },
}

test('direct connect consumes only its own correlated success result', () => {
  expect(directConnectResultForRequest('connect-1', SUCCESS)).toEqual(SUCCESS)
  expect(directConnectResultForRequest('other', SUCCESS)).toBeNull()
  expect(
    directConnectResultForRequest('connect-1', {
      ...SUCCESS,
      verb: 'remoteSettings.bridgeToggle',
    }),
  ).toBeNull()
})
